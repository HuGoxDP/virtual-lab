// path: src/app/services/scenario.service.ts

import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  ScenarioCatalogItem,
  ScenarioCatalogManifest,
  CategoryFilter,
} from '../models/scenario.model';
import { environment } from '../../environments/environment';

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

/**
 * Icons per category key. The set of categories itself comes from the API —
 * this is only a display lookup, so an unknown category still renders.
 */
const CATEGORY_ICONS: Record<string, string> = {
  all: '📋',
  physics: '⚡',
  biology: '🧬',
  chemistry: '🧪',
  history: '🏛️',
  astronomy: '🔭',
};

const DEFAULT_CATEGORY_ICON = '📁';

/** Scenarios fetched per request; the catalog appends pages on demand. */
const PAGE_SIZE = 24;

const ALL_CATEGORIES: CategoryFilter = {
  id: 'all',
  label: 'Всі сценарії',
  icon: CATEGORY_ICONS['all'],
};

@Injectable({ providedIn: 'root' })
export class ScenarioService {

  private readonly http = inject(HttpClient);

  private readonly _scenarios = signal<ScenarioCatalogItem[]>([]);
  private readonly _apiCategories = signal<CategoryFilter[]>([]);
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private readonly _total = signal(0);

  public readonly scenarios = this._scenarios.asReadonly();
  public readonly loading = this._loading.asReadonly();
  public readonly error = this._error.asReadonly();

  /** How many scenarios match the current filter, across all pages. */
  public readonly total = this._total.asReadonly();
  public readonly hasMore = computed(() => this._scenarios().length < this._total());

  /** "Всі сценарії" plus whatever categories the published scenarios actually use. */
  public readonly categories = computed<CategoryFilter[]>(
    () => [ALL_CATEGORIES, ...this._apiCategories()]
  );

  // ==================== CATALOG ====================

  /**
   * Loads the first page for the given filter, replacing what is held.
   *
   * Filtering and paging both happen server-side — a client-side filter over a
   * paged response would only ever search the page in hand.
   */
  async loadCatalog(category = 'all', query = ''): Promise<void> {
    await this.fetchPage(category, query, 0, false);
  }

  /** Appends the next page for the same filter. */
  async loadMore(category = 'all', query = ''): Promise<void> {
    if (this._loading() || !this.hasMore()) return;
    await this.fetchPage(category, query, this._scenarios().length, true);
  }

  private async fetchPage(
    category: string,
    query: string,
    offset: number,
    append: boolean
  ): Promise<void> {
    this._loading.set(true);
    this._error.set(null);

    let params = new HttpParams()
      .set('limit', String(PAGE_SIZE))
      .set('offset', String(offset));

    if (category && category !== 'all') params = params.set('category', category);
    if (query.trim()) params = params.set('q', query.trim());

    try {
      const manifest = await firstValueFrom(
        this.http.get<ScenarioCatalogManifest>(environment.catalogUrl, { params })
      );

      const page = manifest.scenarios ?? [];
      this._scenarios.set(append ? [...this._scenarios(), ...page] : page);
      this._total.set(manifest.total ?? page.length);
      this._apiCategories.set(
        (manifest.categories ?? []).map(c => ({
          id: c.category,
          label: c.categoryLabel,
          icon: CATEGORY_ICONS[c.category] ?? DEFAULT_CATEGORY_ICON,
        }))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не вдалося завантажити каталог';
      this._error.set(message);
      if (!append) {
        this._scenarios.set([]);
        this._apiCategories.set([]);
        this._total.set(0);
      }
      console.error('[ScenarioService] Catalog load failed:', err);
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Fetches a single scenario straight from the API.
   *
   * The viewer uses this instead of an in-memory lookup so that a hard reload
   * of /play/:id — where the catalog was never loaded — still resolves, and so
   * that the archive URL comes from the server rather than from the query string.
   */
  async fetchScenarioById(id: string): Promise<ScenarioCatalogItem> {
    return firstValueFrom(
      this.http.get<ScenarioCatalogItem>(`${environment.catalogUrl}/${encodeURIComponent(id)}`)
    );
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
