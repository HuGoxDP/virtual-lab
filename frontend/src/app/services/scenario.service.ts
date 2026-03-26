// path: src/app/services/scenario.service.ts

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
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

@Injectable({ providedIn: 'root' })
export class ScenarioService {

  private readonly _scenarios$ = new BehaviorSubject<ScenarioCatalogItem[]>([]);
  private readonly _loading$ = new BehaviorSubject<boolean>(false);
  private readonly _error$ = new BehaviorSubject<string | null>(null);

  public readonly scenarios$: Observable<ScenarioCatalogItem[]> = this._scenarios$.asObservable();
  public readonly loading$: Observable<boolean> = this._loading$.asObservable();
  public readonly error$: Observable<string | null> = this._error$.asObservable();

  public readonly categories: CategoryFilter[] = [
    { id: 'all',       label: 'Всі сценарії',  icon: '📋' },
    { id: 'physics',   label: 'Фізика',         icon: '⚡' },
    { id: 'biology',   label: 'Біологія',       icon: '🧬' },
    { id: 'chemistry', label: 'Хімія',          icon: '🧪' },
    { id: 'history',   label: 'Історія',        icon: '🏛️' },
    { id: 'astronomy', label: 'Астрономія',     icon: '🔭' },
  ];

  constructor(private readonly http: HttpClient) {}

  // ==================== CATALOG ====================

  async loadCatalog(): Promise<void> {
    this._loading$.next(true);
    this._error$.next(null);

    try {
      const manifest = await firstValueFrom(
        this.http.get<ScenarioCatalogManifest>(environment.catalogUrl)
      );

      this._scenarios$.next(manifest.scenarios ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не вдалося завантажити каталог';
      this._error$.next(message);
      this._scenarios$.next([]);
      console.error('[ScenarioService] Catalog load failed:', err);
    } finally {
      this._loading$.next(false);
    }
  }

  getScenarios(): ScenarioCatalogItem[] {
    return this._scenarios$.getValue();
  }

  getScenarioById(id: string): ScenarioCatalogItem | undefined {
    return this._scenarios$.getValue().find(s => s.id === id);
  }

  filterScenarios(category: string, query: string): ScenarioCatalogItem[] {
    const all = this._scenarios$.getValue();
    const q = query.trim().toLowerCase();

    return all.filter(s => {
      const matchesCategory = category === 'all' || s.category === category;
      const matchesQuery = !q
        || (s.title ?? '').toLowerCase().includes(q)      // ← ФИКС: защита от undefined
        || (s.description ?? '').toLowerCase().includes(q); // ← ФИКС: защита от undefined
      return matchesCategory && matchesQuery;
    });
  }

  // ==================== ZIP DOWNLOAD ====================

  /**
   * Подготавливает URL для скачивания.
   *
   * Google Drive sharing link:
   *   https://drive.google.com/file/d/FILE_ID/view?usp=sharing
   *
   * Браузер НЕ МОЖЕТ скачать напрямую с Google Drive (CORS).
   * Поэтому мы проксируем через наш бекенд:
   *   /api/proxy-download?url=https://drive.google.com/...
   *
   * Локальные URL (/assets/...) остаются как есть.
   */
  private resolveDownloadUrl(url: string): string {
    // Локальный файл — скачиваем напрямую
    if (url.startsWith('/') || url.startsWith(window.location.origin)) {
      return url;
    }

    // Внешний URL (Google Drive и т.д.) — проксируем через бекенд
    return `/api/proxy-download?url=${encodeURIComponent(url)}`;
  }

  /**
   * Downloads a scenario ZIP from the given URL as an ArrayBuffer.
   */
  async downloadScenarioZip(
    url: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<ArrayBuffer> {

    // ← ДОБАВЛЕНО: преобразование URL для Google Drive и др.
    const downloadUrl = this.resolveDownloadUrl(url);

    const response = await fetch(downloadUrl);

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
