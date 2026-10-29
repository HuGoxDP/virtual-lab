// path: src/app/pages/admin/test-run/test-run.component.ts

import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, inject, input, output, signal, viewChild } from '@angular/core';

import { TestRun } from '../../../models/admin.model';
import { MEASURE_SECONDS, buildFailedRunReport, buildTestRunReport } from '../../../player/test-run-report';
import { PLAYER_HOST_FACTORY, PlayerHostLike, playerHostOptions } from '../../../player/player-config';

type Phase = 'downloading' | 'starting' | 'measuring';

const PHASE_TEXT: Readonly<Record<Phase, string>> = {
  downloading: 'Завантаження архіву…',
  starting: 'Запуск сценарію у пісочниці…',
  measuring: `Вимірювання: ${MEASURE_SECONDS} с роботи сцени…`,
};

/**
 * One test run in this browser: downloads the version's archive, runs it in the sandboxed player
 * (`PlayerHost`, the same integration the viewer uses), measures `MEASURE_SECONDS` and emits the report to
 * save. The scenario's realm is untrusted, so its numbers pass through `buildTestRunReport` (clamped,
 * strings truncated to the server's caps) before leaving this component; a run that fails at any step is
 * reported as `{error}` rather than as numbers. The host is always disposed: when the run ends, is cancelled
 * or the component is destroyed. Starts by itself when shown.
 */
@Component({
  selector: 'vl-test-run',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display: block; }
    .stage { width: 100%; aspect-ratio: 16 / 9; max-height: 50vh; background: #000; border-radius: var(--radius-md); overflow: hidden; }
    .stage ::ng-deep iframe { width: 100%; height: 100%; border: 0; display: block; }
    .status { margin: var(--space-3) 0; font-size: 14px; }
    .actions { display: flex; justify-content: flex-end; }
  `,
  template: `
    <div class="stage" #stage data-role="stage"></div>
    <p class="status" role="status" data-role="status">{{ text() }}</p>
    <div class="actions">
      <button type="button" class="btn btn-secondary" data-action="cancel-run" (click)="cancel()">Скасувати</button>
    </div>
  `,
})
export class TestRunComponent implements AfterViewInit, OnDestroy {
  /** Where the version's ZIP is served (`/scenarios/<sha>.zip`). */
  readonly url = input.required<string>();
  /** The report to save: numbers, or `{error}` when the run failed. Emitted once, never after a cancel. */
  readonly finished = output<TestRun>();
  /** The moderator gave up; the host is already disposed. */
  readonly cancelled = output<void>();

  private readonly stage = viewChild.required<ElementRef<HTMLElement>>('stage');
  private readonly makeHost = inject(PLAYER_HOST_FACTORY);

  protected readonly phase = signal<Phase>('downloading');
  protected readonly text = () => PHASE_TEXT[this.phase()];

  private readonly abort = new AbortController();
  private host: PlayerHostLike | null = null;
  private stopped = false;

  ngAfterViewInit(): void {
    void this.run();
  }

  ngOnDestroy(): void {
    this.stop();
  }

  protected cancel(): void {
    if (this.stopped) return;
    this.stop();
    this.cancelled.emit();
  }

  private stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.host?.dispose();
    this.host = null;
  }

  private async run(): Promise<void> {
    let report: TestRun;
    try {
      const response = await fetch(this.url(), { signal: this.abort.signal });
      if (!response.ok) throw new Error(`Помилка завантаження архіву: ${response.status}`);
      const blob = await response.blob();
      if (this.stopped) return;

      this.phase.set('starting');
      this.host = this.makeHost(this.stage().nativeElement, playerHostOptions());
      await this.host.load({ kind: 'blob', blob }, { diag: false });
      if (this.stopped) return;

      this.phase.set('measuring');
      const metrics = await this.host.measure(MEASURE_SECONDS);
      report = buildTestRunReport(metrics, navigator.userAgent);
    } catch (err) {
      if (this.stopped) return; // cancelled or destroyed: the rejection is ours
      report = buildFailedRunReport(err instanceof Error ? err.message : String(err), navigator.userAgent);
    }
    if (this.stopped) return;
    this.stop();
    this.finished.emit(report);
  }
}
