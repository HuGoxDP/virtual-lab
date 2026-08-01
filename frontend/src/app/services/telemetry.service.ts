// path: src/app/services/telemetry.service.ts

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

const CLIENT_ID_KEY = 'vlClientId';

/**
 * Anonymous "a scenario was opened" reporting.
 *
 * No identity model: the client id is a random UUID kept in `localStorage`
 * purely so repeat visits from one browser can be told apart from many
 * browsers. Nothing here is tied to a person, and a cleared browser is simply
 * a new client.
 *
 * Failures are swallowed by design — telemetry must never break playback.
 */
@Injectable({ providedIn: 'root' })
export class TelemetryService {

  private readonly http = inject(HttpClient);

  private sessionId: string | null = null;

  private get clientId(): string {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  }

  /** Opens a session; a previous one is closed first. */
  async startSession(scenarioId: string): Promise<void> {
    this.endSession();

    try {
      const response = await firstValueFrom(
        this.http.post<{ sessionId: string }>('/api/telemetry/session', {
          scenarioId,
          clientId: this.clientId,
        })
      );
      this.sessionId = response.sessionId;
    } catch {
      this.sessionId = null;
    }
  }

  /**
   * Closes the open session, if any.
   *
   * Uses `sendBeacon` so the request survives page unload — a `fetch` issued
   * from `pagehide` is routinely cancelled. Falls back to `fetch(keepalive)`
   * where `sendBeacon` is unavailable.
   */
  endSession(): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.sessionId = null;

    const url = `/api/telemetry/session/${encodeURIComponent(sessionId)}/end`;

    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([], { type: 'text/plain' }));
      } else {
        void fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
      }
    } catch {
      // Telemetry is never allowed to surface an error to the student.
    }
  }
}
