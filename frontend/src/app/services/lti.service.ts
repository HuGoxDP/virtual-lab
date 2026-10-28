// path: src/app/services/lti.service.ts

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { LtiSession } from '../models/lti.model';

/** A failed LTI call: the HTTP status (0 = no answer) and the server's own Ukrainian message. */
export class LtiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Present on a 409: the grade Moodle already holds (0..1). */
    readonly score?: number,
  ) {
    super(message);
  }
}

const NETWORK_ERROR = 'Немає зв’язку з платформою. Спробуйте ще раз.';
const GENERIC_ERROR = 'Не вдалося виконати запит. Спробуйте ще раз.';

/**
 * Client of the platform's LTI endpoints (`/api/lti/*`). The session lives in an HttpOnly cookie, so
 * the page never sees a token; the calls are same-origin and carry it automatically.
 */
@Injectable({ providedIn: 'root' })
export class LtiService {
  private readonly http = inject(HttpClient);

  /** Rejects with `LtiRequestError`; 401 means there is no (or an expired) LMS session. */
  async getSession(): Promise<LtiSession> {
    return this.request(this.http.get<LtiSession>('/api/lti/session'));
  }

  /**
   * Sends the learner's work to the gradebook, once. `score` is 0..1 and only a graded scenario
   * sends it; the body is JSON even when empty, which is what the endpoint requires.
   */
  async submit(score?: number): Promise<{ score: number }> {
    const body = score === undefined ? {} : { score };
    return this.request(this.http.post<{ score: number }>('/api/lti/submit', body));
  }

  private async request<T>(call: Parameters<typeof firstValueFrom<T>>[0]): Promise<T> {
    try {
      return await firstValueFrom(call);
    } catch (err) {
      throw LtiService.toError(err);
    }
  }

  private static toError(err: unknown): LtiRequestError {
    if (!(err instanceof HttpErrorResponse)) return new LtiRequestError(GENERIC_ERROR, 0);
    if (err.status === 0) return new LtiRequestError(NETWORK_ERROR, 0);
    const body = err.error as { error?: unknown; score?: unknown } | null;
    const message = typeof body?.error === 'string' && body.error ? body.error : GENERIC_ERROR;
    const score = typeof body?.score === 'number' ? body.score : undefined;
    return new LtiRequestError(message, err.status, score);
  }
}
