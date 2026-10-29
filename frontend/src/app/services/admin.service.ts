// path: src/app/services/admin.service.ts

import { Injectable, computed, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

const TOKEN_KEY = 'adminToken';

@Injectable({ providedIn: 'root' })
export class AdminService {

  // sessionStorage, not localStorage: the token dies with the tab rather than
  // sitting on disk until someone remembers to clear it.
  private readonly _token = signal(sessionStorage.getItem(TOKEN_KEY) ?? '');

  private readonly _endedReason = signal<string | null>(null);

  readonly token = this._token.asReadonly();
  readonly isAuthenticated = computed(() => this._token().length > 0);

  /** Why the session was taken away (a rejected or revoked code), for the sign-in screen; null otherwise. */
  readonly endedReason = this._endedReason.asReadonly();

  setToken(token: string): void {
    const trimmed = token.trim();
    sessionStorage.setItem(TOKEN_KEY, trimmed);
    this._token.set(trimmed);
    this._endedReason.set(null);
  }

  clearToken(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    this._token.set('');
  }

  /** The server stopped accepting the code: clear it and remember why, so sign-in can say so. */
  endSession(reason: string): void {
    this.clearToken();
    this._endedReason.set(reason);
  }

  /** Turns an API error into the message the server actually sent; the status stands in when it sent none. */
  static describeError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const serverMessage = (err.error as { error?: string } | null)?.error;
      if (serverMessage) return serverMessage;
      if (err.status === 401) return 'Потрібна авторизація — введіть код доступу.';
      if (err.status === 403) return 'Невірний або відкликаний код доступу.';
      return `Помилка ${err.status}`;
    }
    return err instanceof Error ? err.message : 'Невідома помилка';
  }
}
