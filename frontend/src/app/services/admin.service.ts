// path: src/app/services/admin.service.ts

import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpEventType, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { AdminScenario, ArchiveUploadResult } from '../models/scenario.model';

/** Editable fields of a catalog row. */
export interface ScenarioDraft {
  id: string;
  title: string;
  description: string;
  fullDescription: string;
  category: string;
  categoryLabel: string;
  imageUrl: string;
  version: string;
  author: string;
}

const TOKEN_KEY = 'adminToken';

@Injectable({ providedIn: 'root' })
export class AdminService {

  private readonly http = inject(HttpClient);

  // sessionStorage, not localStorage: the token dies with the tab rather than
  // sitting on disk until someone remembers to clear it.
  private readonly _token = signal(sessionStorage.getItem(TOKEN_KEY) ?? '');

  readonly token = this._token.asReadonly();
  readonly isAuthenticated = computed(() => this._token().length > 0);

  setToken(token: string): void {
    const trimmed = token.trim();
    sessionStorage.setItem(TOKEN_KEY, trimmed);
    this._token.set(trimmed);
  }

  clearToken(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    this._token.set('');
  }

  private authHeaders(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this._token()}` });
  }

  // ==================== CATALOG CRUD ====================

  async listScenarios(): Promise<AdminScenario[]> {
    const response = await firstValueFrom(
      this.http.get<{ scenarios: AdminScenario[] }>('/api/admin/scenarios', {
        headers: this.authHeaders(),
      })
    );
    return response.scenarios ?? [];
  }

  async createScenario(draft: ScenarioDraft): Promise<void> {
    await firstValueFrom(
      this.http.post('/api/catalog', draft, { headers: this.authHeaders() })
    );
  }

  async updateScenario(id: string, patch: Partial<ScenarioDraft & { isPublished: boolean }>): Promise<void> {
    await firstValueFrom(
      this.http.put(`/api/catalog/${encodeURIComponent(id)}`, patch, {
        headers: this.authHeaders(),
      })
    );
  }

  async deleteScenario(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(`/api/catalog/${encodeURIComponent(id)}`, {
        headers: this.authHeaders(),
      })
    );
  }

  // ==================== ARCHIVE ====================

  /**
   * Uploads an archive, reporting upload progress.
   *
   * Uses `reportProgress` + `observe: 'events'` — plain `fetch` cannot report
   * upload progress at all, only download.
   */
  uploadArchive(
    id: string,
    file: File,
    onProgress: (percent: number) => void
  ): Promise<ArchiveUploadResult> {
    const form = new FormData();
    form.append('archive', file);

    return new Promise((resolve, reject) => {
      this.http.post<ArchiveUploadResult>(
        `/api/scenarios/${encodeURIComponent(id)}/archive`,
        form,
        { headers: this.authHeaders(), reportProgress: true, observe: 'events' }
      ).subscribe({
        next: event => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          } else if (event.type === HttpEventType.Response && event.body) {
            resolve(event.body);
          }
        },
        error: reject,
      });
    });
  }

  async importArchive(id: string): Promise<ArchiveUploadResult> {
    return firstValueFrom(
      this.http.post<ArchiveUploadResult>(
        `/api/scenarios/${encodeURIComponent(id)}/archive/import`,
        {},
        { headers: this.authHeaders() }
      )
    );
  }

  /** Turns an API error into the message the server actually sent. */
  static describeError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      if (err.status === 401) return 'Потрібна авторизація — введіть токен.';
      if (err.status === 403) return 'Невірний токен.';
      if (err.status === 503) return 'ADMIN_TOKEN не налаштований на сервері.';
      const serverMessage = (err.error as { error?: string } | null)?.error;
      if (serverMessage) return serverMessage;
      return `Помилка ${err.status}`;
    }
    return err instanceof Error ? err.message : 'Невідома помилка';
  }
}
