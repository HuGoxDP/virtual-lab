// path: src/app/services/admin-api.service.ts

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpEventType, HttpHeaders } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';

import {
  AdminCategory, AdminUser, ArchiveChecks, ArchiveEntry, AuditRow, BulkAction, BulkResult, CategoryInput,
  CreatedKey, Dashboard, FromArchiveResult, KeyRow, PlatformConfig, PreviewResult, ScenarioPatch, ScenarioVersion, TestRun,
  TransitionAction, TransitionResult, VersionAction,
} from '../models/admin.model';
import { AdminScenario, ArchiveUploadResult } from '../models/scenario.model';
import { AdminService } from './admin.service';

/** What the server says for a code it does not know or has revoked (`backend/auth.js`). */
const REJECTED_CODE_MESSAGE = 'Невірний токен';

/**
 * True when the server stopped accepting the session's code: a 401 (no credential) or the 403 that says
 * the code is unknown or revoked. Any other 403 (`Недостатньо прав`, `Це не ваш сценарій`) is a refused
 * action by a valid user and must not sign them out.
 */
export function isCredentialRejection(err: unknown): boolean {
  if (!(err instanceof HttpErrorResponse)) return false;
  if (err.status === 401) return true;
  return err.status === 403 && (err.error as { error?: string } | null)?.error === REJECTED_CODE_MESSAGE;
}

const seg = encodeURIComponent;

/** An upload stopped by its caller (`AbortSignal`): not a failure, so screens show no error for it. */
export class UploadCancelled extends Error {
  constructor() {
    super('Завантаження скасовано.');
    this.name = 'UploadCancelled';
  }
}

/**
 * One typed method per admin route (Phases 2-4 of release 2). Every call carries the session's bearer;
 * a rejected code ends the session (`AdminService.endSession`) before the error reaches the caller, so
 * no screen needs its own "signed out mid-session" handling. Errors are rethrown as `HttpErrorResponse`
 * for `AdminService.describeError`.
 */
@Injectable({ providedIn: 'root' })
export class AdminApi {

  private readonly http = inject(HttpClient);
  private readonly admin = inject(AdminService);

  private headers(code = this.admin.token()): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${code}` });
  }

  private async call<T>(request: (headers: HttpHeaders) => Observable<T>, code?: string): Promise<T> {
    try {
      return await firstValueFrom(request(this.headers(code)));
    } catch (err) {
      // A code passed in explicitly is a sign-in attempt: there is no session yet to end.
      if (code === undefined && isCredentialRejection(err)) {
        this.admin.endSession(
          (err as HttpErrorResponse).status === 401
            ? 'Сесію завершено: потрібно увійти знову.'
            : 'Код доступу недійсний або відкликаний: увійдіть знову.'
        );
      }
      throw err;
    }
  }

  private get<T>(path: string, code?: string): Promise<T> {
    return this.call(headers => this.http.get<T>(path, { headers }), code);
  }

  private post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.call(headers => this.http.post<T>(path, body, { headers }));
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.call(headers => this.http.put<T>(path, body, { headers }));
  }

  private delete<T>(path: string): Promise<T> {
    return this.call(headers => this.http.delete<T>(path, { headers }));
  }

  // ==================== SESSION ====================

  /** Who `code` is (defaults to the session's code). With an explicit code a failure ends no session. */
  me(code?: string): Promise<AdminUser> {
    return this.get<AdminUser>('/api/auth/me', code);
  }

  config(): Promise<PlatformConfig> {
    return this.get<PlatformConfig>('/api/config');
  }

  // ==================== SCENARIOS ====================

  async listScenarios(): Promise<AdminScenario[]> {
    return (await this.get<{ scenarios?: AdminScenario[] }>('/api/admin/scenarios')).scenarios ?? [];
  }

  /** One admin row, or null when there is none (or it is not the caller's). The API has no by-id route. */
  async scenario(id: string): Promise<AdminScenario | null> {
    return (await this.listScenarios()).find(row => row.id === id) ?? null;
  }

  createScenario(body: Record<string, unknown>): Promise<unknown> {
    return this.post('/api/catalog', body);
  }

  updateScenario(id: string, patch: ScenarioPatch): Promise<unknown> {
    return this.put(`/api/catalog/${seg(id)}`, patch);
  }

  deleteScenario(id: string): Promise<unknown> {
    return this.delete(`/api/catalog/${seg(id)}`);
  }

  /** submit / withdraw / approve / reject / unpublish; `note` only means something for `reject`. */
  transition(id: string, action: TransitionAction, note?: string): Promise<TransitionResult> {
    return this.post(`/api/scenarios/${seg(id)}/${action}`, action === 'reject' && note !== undefined ? { note } : {});
  }

  history(id: string): Promise<AuditRow[]> {
    return this.get(`/api/scenarios/${seg(id)}/history`);
  }

  bulk(ids: string[], action: BulkAction, category?: string): Promise<BulkResult[]> {
    return this.post<{ results: BulkResult[] }>('/api/scenarios/bulk', { ids, action, ...(category ? { category } : {}) })
      .then(response => response.results);
  }

  // ==================== PREVIEW ====================

  uploadPreview(id: string, file: File): Promise<PreviewResult> {
    const form = new FormData();
    form.append('preview', file);
    return this.post(`/api/scenarios/${seg(id)}/preview`, form);
  }

  removePreview(id: string): Promise<{ imageUrl: string }> {
    return this.delete(`/api/scenarios/${seg(id)}/preview`);
  }

  // ==================== ARCHIVES AND VERSIONS ====================

  /**
   * Posts `form` reporting upload progress (0-100), abortable through `signal`. Aborting unsubscribes,
   * which cancels the request in the browser, and rejects with `UploadCancelled`. A rejected code ends the
   * session like any other call.
   */
  private upload<T>(path: string, form: FormData, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<T> {
    return this.call(headers => new Observable<T>(subscriber => {
      const sub = this.http.post<T>(path, form, { headers, reportProgress: true, observe: 'events' }).subscribe({
        next: event => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
          } else if (event.type === HttpEventType.Response && event.body !== null) {
            subscriber.next(event.body);
          }
        },
        error: err => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
      const abort = () => { sub.unsubscribe(); subscriber.error(new UploadCancelled()); };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      return () => { signal?.removeEventListener('abort', abort); sub.unsubscribe(); };
    }));
  }

  /** A new archive for scenario `id` (multipart field `archive`); the answer carries the stored `version`. */
  uploadArchive(id: string, file: File, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<ArchiveUploadResult> {
    const form = new FormData();
    form.append('archive', file);
    return this.upload(`/api/scenarios/${seg(id)}/archive`, form, onProgress, signal);
  }

  /** Creates a draft from the archive's own manifest; `category` defaults server-side. */
  fromArchive(file: File, onProgress: (percent: number) => void, signal?: AbortSignal, category?: string): Promise<FromArchiveResult> {
    const form = new FormData();
    if (category) form.append('category', category);
    form.append('archive', file);
    return this.upload('/api/scenarios/from-archive', form, onProgress, signal);
  }

  async versions(id: string): Promise<ScenarioVersion[]> {
    return (await this.get<{ versions?: ScenarioVersion[] }>(`/api/scenarios/${seg(id)}/versions`)).versions ?? [];
  }

  versionAction(id: string, versionId: number, action: VersionAction): Promise<unknown> {
    return this.post(`/api/scenarios/${seg(id)}/versions/${versionId}/${action}`);
  }

  deleteVersion(id: string, versionId: number): Promise<unknown> {
    return this.delete(`/api/scenarios/${seg(id)}/versions/${versionId}`);
  }

  versionContents(id: string, versionId: number): Promise<ArchiveEntry[]> {
    return this.get(`/api/scenarios/${seg(id)}/versions/${versionId}/contents`);
  }

  runChecks(id: string, versionId: number): Promise<ArchiveChecks> {
    return this.post(`/api/scenarios/${seg(id)}/versions/${versionId}/checks`);
  }

  async saveTestRun(id: string, versionId: number, run: TestRun): Promise<TestRun> {
    return (await this.post<{ testRun: TestRun }>(`/api/scenarios/${seg(id)}/versions/${versionId}/test-run`, run)).testRun;
  }

  // ==================== DASHBOARD, CATEGORIES, KEYS ====================

  dashboard(): Promise<Dashboard> {
    return this.get('/api/admin/dashboard');
  }

  async categories(): Promise<AdminCategory[]> {
    return (await this.get<{ categories?: AdminCategory[] }>('/api/categories')).categories ?? [];
  }

  createCategory(input: CategoryInput): Promise<AdminCategory> {
    return this.post('/api/categories', input);
  }

  updateCategory(slug: string, input: CategoryInput): Promise<AdminCategory> {
    return this.put(`/api/categories/${seg(slug)}`, input);
  }

  deleteCategory(slug: string): Promise<unknown> {
    return this.delete(`/api/categories/${seg(slug)}`);
  }

  reorderCategories(slugs: string[]): Promise<unknown> {
    return this.post('/api/categories/reorder', { slugs });
  }

  async keys(): Promise<KeyRow[]> {
    return (await this.get<{ keys?: KeyRow[] }>('/api/keys')).keys ?? [];
  }

  createKey(label: string, role: AdminUser['role']): Promise<CreatedKey> {
    return this.post('/api/keys', { label, role });
  }

  revokeKey(id: number): Promise<KeyRow> {
    return this.post(`/api/keys/${id}/revoke`);
  }
}
