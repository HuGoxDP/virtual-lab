// path: src/app/services/platform-config.service.ts

import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/**
 * Public limits from `GET /api/config`. The footer states the archive limit from here instead of
 * hard-coding it; a failed request leaves it `null` and the footer then names the format only.
 */
@Injectable({ providedIn: 'root' })
export class PlatformConfigService {

  private readonly http = inject(HttpClient);

  private readonly _maxArchiveBytes = signal<number | null>(null);
  readonly maxArchiveBytes = this._maxArchiveBytes.asReadonly();

  private pending: Promise<void> | null = null;

  /** Fetches the config once; concurrent and later calls share the result, a failure may be retried. */
  load(): Promise<void> {
    this.pending ??= this.fetch();
    return this.pending;
  }

  private async fetch(): Promise<void> {
    try {
      const config = await firstValueFrom(this.http.get<{ maxArchiveBytes?: unknown }>('/api/config'));
      const bytes = config?.maxArchiveBytes;
      // Anything but a positive finite number is a malformed answer, not a limit to display.
      this._maxArchiveBytes.set(typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : null);
    } catch (err) {
      this.pending = null; // let the next page view try again
      console.error('[PlatformConfigService] Config load failed:', err);
    }
  }
}
