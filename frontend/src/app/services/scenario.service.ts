// path: src/app/services/scenario.service.ts

import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  CatalogSummary,
  CategoryFilter,
  ScenarioCatalogItem,
  ScenarioCatalogManifest,
  ScenarioDetail,
} from '../models/scenario.model';
import { environment } from '../../environments/environment';
import { CatalogFilter, DEFAULT_CATALOG_FILTER } from './catalog-query';
import { AdminService } from './admin.service';

/**
 * Download progress event emitted while fetching a scenario ZIP.
 */
export interface DownloadProgress {
  /** Bytes received so far. */
  loaded: number;
  /** Total bytes (0 if server doesn't send Content-Length). */
  total: number;
  /** Percentage 0–100 (or -1 if total is unknown). */
  percent: number;
}

/** Scenarios fetched per request; the catalog appends pages on demand. */
const PAGE_SIZE = 24;

/** Shown for any catalog failure; the technical detail goes to the console. */
const CATALOG_ERROR = 'Не вдалося завантажити каталог';

/** The chip that clears the category filter. */
const ALL_CATEGORIES = { id: 'all', label: 'Усі напрями', icon: 'list-dashes' } as const;

@Injectable({ providedIn: 'root' })
export class ScenarioService {

  private readonly http = inject(HttpClient);
  private readonly admin = inject(AdminService);

  private readonly _scenarios = signal<ScenarioCatalogItem[]>([]);
  private readonly _apiCategories = signal<CategoryFilter[]>([]);
  private readonly _summary = signal<CatalogSummary | null>(null);
  private readonly _loading = signal<boolean>(false);
  private readonly _loaded = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private readonly _total = signal(0);
  private readonly _filter = signal<CatalogFilter>(DEFAULT_CATALOG_FILTER);

  /**
   * Identifies the newest request. A response that comes back for an older one is dropped, so a
   * slow answer for a previous filter can never overwrite the list of the current one.
   */
  private latestRequest = 0;

  public readonly scenarios = this._scenarios.asReadonly();
  public readonly loading = this._loading.asReadonly();
  public readonly error = this._error.asReadonly();

  /** True once a request has finished (either way): before that, an empty list means "not yet". */
  public readonly loaded = this._loaded.asReadonly();

  /** Whole-catalog counters; null until the first successful answer. */
  public readonly summary = this._summary.asReadonly();

  /** The filter of the latest catalog request; the scenario page links back with it. */
  public readonly filter = this._filter.asReadonly();

  /** How many scenarios match the current filter, across all pages. */
  public readonly total = this._total.asReadonly();
  public readonly hasMore = computed(() => this._scenarios().length < this._total());

  /** "Усі напрями" plus the API's categories, in the API's order. */
  public readonly categories = computed<CategoryFilter[]>(() => [
    { ...ALL_CATEGORIES, count: this._summary()?.scenarios ?? 0 },
    ...this._apiCategories(),
  ]);

  // ==================== CATALOG ====================

  /**
   * Loads the first page for the given filter, replacing what is held.
   *
   * Filtering, ordering and paging all happen server-side — a client-side filter over a
   * paged response would only ever search the page in hand.
   */
  async loadCatalog(filter: CatalogFilter = DEFAULT_CATALOG_FILTER): Promise<void> {
    await this.fetchPage(filter, 0, false);
  }

  /** Appends the next page for the same filter. */
  async loadMore(filter: CatalogFilter = DEFAULT_CATALOG_FILTER): Promise<void> {
    if (this._loading() || !this.hasMore()) return;
    await this.fetchPage(filter, this._scenarios().length, true);
  }

  private async fetchPage(filter: CatalogFilter, offset: number, append: boolean): Promise<void> {
    const request = ++this.latestRequest;
    this._loading.set(true);
    this._error.set(null);
    this._filter.set(filter);

    let params = new HttpParams()
      .set('limit', String(PAGE_SIZE))
      .set('offset', String(offset));

    if (filter.category && filter.category !== 'all') params = params.set('category', filter.category);
    if (filter.q.trim()) params = params.set('q', filter.q.trim());
    if (filter.sort !== DEFAULT_CATALOG_FILTER.sort) params = params.set('sort', filter.sort);

    try {
      const manifest = await firstValueFrom(
        this.http.get<ScenarioCatalogManifest>(environment.catalogUrl, { params })
      );
      if (request !== this.latestRequest) return;

      const page = manifest.scenarios ?? [];
      this._scenarios.set(append ? [...this._scenarios(), ...page] : page);
      this._total.set(manifest.total ?? page.length);
      this._summary.set(manifest.summary ?? null);
      this._apiCategories.set(
        (manifest.categories ?? []).map(c => ({
          id: c.category,
          label: c.categoryLabel,
          icon: c.icon,
          count: c.count,
        }))
      );
    } catch (err) {
      console.error('[ScenarioService] Catalog load failed:', err);
      if (request !== this.latestRequest) return;

      this._error.set(CATALOG_ERROR);
      // The chips and counters describe the whole catalog and stay; only the list is lost.
      if (!append) {
        this._scenarios.set([]);
        this._total.set(0);
      }
    } finally {
      if (request === this.latestRequest) {
        this._loading.set(false);
        this._loaded.set(true);
      }
    }
  }

  /**
   * Fetches a single scenario, with its related scenarios, straight from the API.
   *
   * The viewer and the scenario page use this instead of an in-memory lookup so that a hard reload
   * of /play/:id or /scenario/:id — where the catalog was never loaded — still resolves, and so
   * that the archive URL comes from the server rather than from the query string.
   * Rejects with the `HttpErrorResponse`, so a caller can tell a 404 from a server error.
   *
   * With `version` (a sha256) it asks for that archive version - a draft preview. A scenario that is
   * not published answers only its owner or a moderator, so the session's bearer is sent along (when
   * there is one: a published scenario's versions need none). Only a preview sends it: the plain
   * lookup is public and carries no credential.
   */
  async fetchScenarioById(id: string, version?: string): Promise<ScenarioDetail> {
    const token = this.admin.token();
    const options = version === undefined ? {} : {
      params: new HttpParams().set('version', version),
      headers: token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : undefined,
    };
    const detail = await firstValueFrom(
      this.http.get<ScenarioDetail>(`${environment.catalogUrl}/${encodeURIComponent(id)}`, options)
    );
    // Both lists may be missing from an older answer; the page can rely on arrays.
    return { ...detail, features: detail.features ?? [], related: detail.related ?? [] };
  }

  // ==================== ZIP DOWNLOAD ====================

  /**
   * The URL to fetch a scenario's archive from.
   *
   * Every archive is served from this origin by nginx, so this is the row's own
   * URL. There used to be a fallback here that routed anything external through
   * `/api/proxy-download`, because a browser cannot fetch from Google Drive
   * (CORS) — that path and its server side are gone, along with the last
   * scenario that needed them.
   *
   * An off-origin URL is therefore a misconfigured row, not a supported case:
   * it is returned as-is and will fail the fetch visibly rather than being
   * silently relayed.
   */
  private resolveDownloadUrl(scenario: ScenarioCatalogItem): string {
    return scenario.scenarioUrl;
  }

  /**
   * Downloads a scenario's ZIP archive as an ArrayBuffer.
   *
   * `signal` lets the caller abort a transfer that is no longer wanted —
   * without it, leaving the viewer keeps streaming a large archive into a
   * component that no longer exists.
   */
  async downloadScenarioZip(
    scenario: ScenarioCatalogItem,
    onProgress?: (progress: DownloadProgress) => void,
    signal?: AbortSignal
  ): Promise<ArrayBuffer> {

    const downloadUrl = this.resolveDownloadUrl(scenario);

    const response = await fetch(downloadUrl, { signal });

    if (!response.ok) {
      throw new Error(`Помилка завантаження: ${response.status} ${response.statusText}`);
    }

    const contentLength = Number(response.headers.get('Content-Length') ?? 0);
    const reader = response.body?.getReader();

    if (!reader) {
      return response.arrayBuffer();
    }

    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException('Завантаження скасовано', 'AbortError');
      }

      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;

      onProgress?.({
        loaded: received,
        total: contentLength,
        percent: contentLength > 0
          ? Math.round((received / contentLength) * 100)
          : -1,
      });
    }

    const result = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result.buffer;
  }
}
