// path: src/app/pages/viewer/lti-submit.component.ts

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { LtiSession } from '../../models/lti.model';
import { LtiRequestError, LtiService } from '../../services/lti.service';

/** What the scenario last reported (`PlayerHost` `onResult`); `score` is 0..1. */
export interface LtiResult {
  score: number;
  completed: boolean;
}

type LtiMode = 'loading' | 'unavailable' | 'view' | 'submitted' | 'ready';

/** Moodle's line item is created with this maximum, and the grade is shown against it. */
export const GRADE_MAX = 100;

const SESSION_ENDED = 'Сесію Moodle завершено. Відкрийте роботу знову з курсу в Moodle, щоб здати її.';
const SESSION_FAILED = 'Не вдалося отримати дані сесії Moodle. Оновіть сторінку.';
const SUBMIT_FAILED = 'Не вдалося передати роботу. Спробуйте ще раз.';

/** Score 0..1 as whole points out of {@link GRADE_MAX}; junk is clamped rather than shown. */
export function toPoints(score: number): number {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0)) * GRADE_MAX);
}

/**
 * The viewer's LTI controls, rendered only for `/play/:id?lti=1`. Reads the launch session, then
 * offers exactly one of: nothing yet (loading), a message (no session), view mode (instructor),
 * «Роботу здано» with the grade, or the submit button. The grade is the gradebook's business: this
 * only sends the work (`POST /api/lti/submit`) and shows what Moodle answered.
 */
@Component({
  selector: 'vl-lti-submit',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './lti-submit.component.html',
  styleUrl: './lti-submit.component.scss',
})
export class LtiSubmitComponent {
  private readonly lti = inject(LtiService);

  /** The latest score from the scenario; owned by the viewer, so one that arrived before the session loaded is not lost. */
  readonly result = input<LtiResult | null>(null);

  private readonly _session = signal<LtiSession | null>(null);
  private readonly _unavailable = signal<string | null>(null);
  /** The grade Moodle holds; `score` is `null` when a 409 said "already submitted" without one. */
  private readonly _submitted = signal<{ score: number | null } | null>(null);
  private readonly _confirming = signal(false);
  private readonly _busy = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly unavailable = this._unavailable.asReadonly();
  readonly confirming = this._confirming.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();

  readonly graded = computed(() => this._session()?.graded ?? false);

  readonly mode = computed<LtiMode>(() => {
    const session = this._session();
    if (this._unavailable()) return 'unavailable';
    if (!session) return 'loading';
    if (session.role !== 'learner' || session.messageType !== 'resource') return 'view';
    return this._submitted() ? 'submitted' : 'ready';
  });

  /** «оцінка X з 100» for the submitted state; `null` when no grade is known. */
  readonly submittedPoints = computed(() => {
    const score = this._submitted()?.score;
    return typeof score === 'number' ? toPoints(score) : null;
  });

  /** What the confirmation shows and a graded submit sends: the last reported score, 0 when none. */
  readonly pendingPoints = computed(() => toPoints(this.result()?.score ?? 0));
  readonly hasResult = computed(() => this.result() !== null);

  protected readonly gradeMax = GRADE_MAX;

  constructor() {
    void this.loadSession();
  }

  private async loadSession(): Promise<void> {
    try {
      const session = await this.lti.getSession();
      this._submitted.set(session.submitted ? { score: session.submitted.score } : null);
      this._session.set(session);
    } catch (err) {
      const ended = err instanceof LtiRequestError && err.status === 401;
      this._unavailable.set(ended ? SESSION_ENDED : SESSION_FAILED);
    }
  }

  /** «Здати» asks first; «Завершити» has nothing to confirm (it submits the maximum). */
  begin(): void {
    if (this._busy()) return;
    if (this.graded()) this._confirming.set(true);
    else void this.send();
  }

  cancel(): void {
    this._confirming.set(false);
  }

  /** One request at a time: `busy` is set before the first await, so a second click is ignored. */
  async send(): Promise<void> {
    if (this._busy()) return;
    this._busy.set(true);
    this._confirming.set(false);
    this._error.set(null);

    const result = this.result();
    try {
      const sent = await this.lti.submit(this.graded() && result ? result.score : undefined);
      this._submitted.set({ score: sent.score });
    } catch (err) {
      this.onSubmitFailed(err);
    } finally {
      this._busy.set(false);
    }
  }

  private onSubmitFailed(err: unknown): void {
    if (!(err instanceof LtiRequestError)) {
      this._error.set(SUBMIT_FAILED);
    } else if (err.status === 409) {
      this._submitted.set({ score: err.score ?? null });
    } else if (err.status === 401) {
      this._unavailable.set(SESSION_ENDED);
    } else {
      this._error.set(err.message); // 502 and the rest: the button stays, the student can retry
    }
  }
}
