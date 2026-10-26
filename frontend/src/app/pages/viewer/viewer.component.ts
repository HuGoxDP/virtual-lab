// path: src/app/pages/viewer/viewer.component.ts

import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  ChangeDetectionStrategy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';

// Engine imports — from the WebEngineTS npm package
import { Application, BuildInfo, Texture2D } from 'WebEngineTS';
import type { IScenarioLoadProgress } from 'WebEngineTS';

import { IconComponent } from '../../ui/icon/icon.component';
import { ScenarioService, DownloadProgress } from '../../services/scenario.service';
import { TelemetryService } from '../../services/telemetry.service';
import { ScenarioCatalogItem } from '../../models/scenario.model';
import { STAGE_ENGINE, STAGE_FETCH, readFlag } from './viewer-format';
import { PROFILER_GUARD_INTERVAL_MS, enforceProfilerOff, lockProfiler } from './viewer-profiler';
import { ViewerHudComponent } from './viewer-hud.component';
import { ViewerLoadingComponent } from './viewer-loading.component';

/**
 * Viewer states for the loading UI.
 */
type ViewerState = 'idle' | 'downloading' | 'loading-engine' | 'running' | 'error' | 'unsupported';

@Component({
  selector: 'app-viewer',
  standalone: true,
  imports: [ViewerHudComponent, ViewerLoadingComponent, IconComponent],
  templateUrl: './viewer.component.html',
  styleUrls: ['./viewer.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewerComponent implements AfterViewInit, OnDestroy {

  @ViewChild('webglCanvas', { static: true })
  canvasRef!: ElementRef<HTMLCanvasElement>;

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly scenarioService = inject(ScenarioService);
  private readonly telemetry = inject(TelemetryService);

  private readonly destroy$ = new Subject<void>();
  private app: Application | null = null;

  /** Aborts the archive download when the user navigates away mid-transfer. */
  private downloadAbort: AbortController | null = null;

  /**
   * Kept so "restart" can re-run the scenario without downloading it again.
   *
   * A signal, not a field, because `canRestart` derives from it: a streamed run
   * has no buffer to re-run, and a plain field would never notify the zoneless
   * scheduler to disable the button.
   */
  private readonly loadedBuffer = signal<ArrayBuffer | null>(null);

  /** Re-closes the profiler if a running scenario opens it again. */
  private profilerGuard: ReturnType<typeof setInterval> | null = null;

  private contextLostHandler: ((event: Event) => void) | null = null;

  /**
   * Incremented on every navigation so a load that is still in flight cannot
   * write its result over a newer one.
   */
  private loadToken = 0;

  /** Catalog id of the scenario currently loaded, for telemetry attribution. */
  private scenarioId = '';

  /** The id in the URL; the exit target even when the lookup failed and `scenarioId` was never set. */
  private routeId = '';

  // UI state. Signals, not plain fields: the app is zoneless, so a signal write
  // is what notifies the change-detection scheduler. Mutating a field from an
  // async callback would never repaint.
  readonly state = signal<ViewerState>('idle');
  readonly progressPercent = signal(0);
  /** Archive bytes received / announced by the server (0 = unknown); `null` = no archive download. */
  readonly loadedBytes = signal<number | null>(null);
  readonly totalBytes = signal<number | null>(null);
  readonly stage = signal('');
  readonly errorMessage = signal<string | null>(null);
  readonly scenarioTitle = signal('');
  readonly contextLost = signal(false);
  readonly isFullscreen = signal(false);

  /**
   * Whether to show the engine build stamp (`?diag=1`). The stamp is all the flag does: the
   * profiler overlay never runs on the platform, with or without it (see `viewer-profiler.ts`).
   */
  readonly buildStampVisible = signal(false);

  /**
   * Whether to load from the scenario's streaming manifest rather than its ZIP.
   *
   * Opt-in via `?stream=1`, and deliberately **not** the default. The manifest
   * path is proven to render the same scene, but on the hardware measured so far
   * it is not faster to first frame and holds noticeably more texture memory
   * (`docs/PLAN.md`). Making it the default would trade a student-visible
   * regression for an unproven win. The flag exists so the comparison can be
   * repeated on a real GPU, which is what would settle it.
   *
   * Ignored when the scenario has no `manifestUrl` — most do not.
   */
  readonly streamingRequested = signal(false);

  readonly isLoading = computed(
    () => this.state() === 'downloading' || this.state() === 'loading-engine'
  );

  // A streamed run holds no buffer, so there is nothing to re-run in place —
  // restarting it would mean re-fetching, which is not what the button promises.
  readonly canRestart = computed(
    () => this.state() === 'running' && !this.contextLost() && this.loadedBuffer() !== null
  );

  /**
   * Which engine build is running, for the diagnostics readout.
   *
   * Not `Application.version`: that is a string literal fixed at "0.1.0" across
   * every local pack, so it cannot tell two builds apart — which is the only
   * question worth asking. `BuildInfo` is stamped from the engine's package.json
   * at build time, and `builtAt` is what actually distinguishes one build from
   * the next. A frame time quoted without it is not reproducible.
   */
  readonly engineBuild = ViewerComponent.describeEngineBuild();

  private static describeEngineBuild(): string {
    if (!BuildInfo.isBuild) return 'engine: running from source';

    // Minutes are enough to identify a pack; seconds are noise on screen.
    const builtAt = BuildInfo.builtAt
      ? BuildInfo.builtAt.replace('T', ' ').slice(0, 16) + ' UTC'
      : 'build date unknown';

    return `engine ${BuildInfo.version} · ${builtAt}`;
  }

  // ==================== LIFECYCLE ====================

  ngAfterViewInit(): void {
    // First thing, before the WebGL probe and before any scenario code can exist.
    lockProfiler();

    // Read once: these are launch options (read before the WebGL probe so the build stamp also shows on the unsupported screen), not something to toggle mid-run.
    const query = this.route.snapshot.queryParamMap;
    this.buildStampVisible.set(readFlag(query.get('diag')));
    this.streamingRequested.set(readFlag(query.get('stream')));

    const canvas = this.canvasRef.nativeElement;

    // Probe before constructing: the Application constructor throws on a
    // machine without WebGL2 and the user would see a raw exception string.
    if (!ViewerComponent.supportsWebGL2(canvas)) {
      this.state.set('unsupported');
      return;
    }

    // The engine's game loop is a plain requestAnimationFrame loop and never
    // touches change detection — the app is zoneless, so no NgZone dance is
    // needed (or possible: the injected NgZone would be a no-op).
    this.app = this.createApplication(canvas);

    // KTX2 textures are transcoded by a WASM module the *host* serves, not the
    // engine bundle. Angular publishes src/assets at /assets, so the engine's
    // default of "/basis/" would 404 here — silently, until a scenario actually
    // ships compressed textures. Set before any scenario loads.
    Texture2D.ktx2TranscoderPath = '/assets/basis/';

    // A lost context silently freezes the scene otherwise.
    this.contextLostHandler = (event: Event) => {
      event.preventDefault();
      this.app?.stop();
      this.contextLost.set(true);
    };
    canvas.addEventListener('webglcontextlost', this.contextLostHandler);

    document.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
    window.addEventListener('pagehide', this.pageHideHandler);

    this.route.paramMap
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        const id = params.get('id');
        this.routeId = id ?? '';
        if (id) {
          void this.openScenario(id);
        } else {
          this.showError('Сценарій не вказано.');
        }
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.loadToken++; // a load still in flight is now stale: it must not re-arm the profiler guard

    // Stop streaming a possibly-large archive into a dead component.
    this.downloadAbort?.abort();
    this.downloadAbort = null;
    this.loadedBuffer.set(null);

    const canvas = this.canvasRef.nativeElement;
    if (this.contextLostHandler) {
      canvas.removeEventListener('webglcontextlost', this.contextLostHandler);
      this.contextLostHandler = null;
    }
    document.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
    window.removeEventListener('pagehide', this.pageHideHandler);
    this.telemetry.endSession();

    if (this.profilerGuard !== null) clearInterval(this.profilerGuard);
    this.profilerGuard = null;
    enforceProfilerOff();

    // Full cleanup: scenario → engine → WebGL context
    if (this.app) {
      this.app.dispose();
      this.app = null;
    }
  }

  /** Test seam: jsdom has no WebGL2, so a spec swaps the engine out here. Behaviour is `new Application`. */
  protected createApplication(canvas: HTMLCanvasElement): Application {
    return new Application(canvas);
  }

  /** Cheap feature probe; the context is released immediately. */
  private static supportsWebGL2(canvas: HTMLCanvasElement): boolean {
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2');
      if (!gl) return false;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  // ==================== LOADING PIPELINE ====================

  /**
   * Resolves the scenario through the API, then runs the load pipeline.
   *
   * The archive URL comes from the server, never from the query string — a
   * client-supplied URL would let anyone drive the download proxy.
   */
  private async openScenario(id: string): Promise<void> {
    const token = ++this.loadToken;
    this.setState('downloading', 0, 'Отримання даних сценарію');

    let scenario: ScenarioCatalogItem;

    try {
      scenario = await this.scenarioService.fetchScenarioById(id);
      if (token !== this.loadToken) return;

      this.scenarioId = scenario.id;
      this.scenarioTitle.set(scenario.title ?? '');

      if (!scenario.scenarioUrl) {
        this.showError('Для цього сценарію ще не завантажено архів.');
        return;
      }
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error('[ViewerComponent] Scenario lookup failed:', err);
      this.showError('Сценарій не знайдено.');
      return;
    }

    await this.startLoading(scenario, token);
  }

  /**
   * Full loading pipeline:
   * 1. Download ZIP from URL (with progress)
   * 2. Pass ArrayBuffer to engine (with progress)
   * 3. Engine parses ZIP, validates manifest, executes entry point
   */
  private async startLoading(scenario: ScenarioCatalogItem, token: number): Promise<void> {
    if (this.streamingRequested() && scenario.manifestUrl) {
      await this.startStreaming(scenario.manifestUrl, token);
      return;
    }

    this.setState('downloading', 0, STAGE_FETCH);
    this.loadedBytes.set(0);

    this.downloadAbort?.abort();
    const abort = new AbortController();
    this.downloadAbort = abort;

    try {
      // Step 1: Download the ZIP
      const zipBuffer = await this.scenarioService.downloadScenarioZip(
        scenario,
        (progress: DownloadProgress) => {
          if (token !== this.loadToken) return;
          this.progressPercent.set(progress.percent >= 0 ? progress.percent : 0);
          this.loadedBytes.set(progress.loaded);
          this.totalBytes.set(progress.total);
        },
        abort.signal
      );

      if (token !== this.loadToken) return;
      this.loadedBuffer.set(zipBuffer);

      await this.runBuffer(zipBuffer, token);

    } catch (err) {
      if (token !== this.loadToken || abort.signal.aborted) return;
      const message = err instanceof Error
        ? err.message
        : 'Невідома помилка при завантаженні сценарію';
      console.error('[ViewerComponent] Load failed:', err);
      this.showError(message);
    }
  }

  /**
   * Runs a scenario from its streaming manifest instead of its archive.
   *
   * No download step: the engine fetches scripts and assets itself, in priority
   * order, so the only progress worth reporting is the engine's own. `restart()`
   * is unavailable afterwards because there is no buffer to re-run — it would
   * have to re-fetch, which is a different thing from what the button promises.
   */
  private async startStreaming(manifestUrl: string, token: number): Promise<void> {
    this.setState('loading-engine', 0, STAGE_ENGINE);
    this.armProfilerGuard();

    try {
      if (!this.app) throw new Error('Engine not initialized');

      await this.app.loadScenarioFromManifest(
        manifestUrl,
        (progress: IScenarioLoadProgress) => {
          if (token !== this.loadToken) return;
          this.progressPercent.set(Math.round(progress.progress * 100));
        }
      );

      if (token !== this.loadToken) return;
      this.loadedBuffer.set(null);
      this.setState('running', 100, '');

      this.watchProfiler();
      void this.telemetry.startSession(this.scenarioId);

    } catch (err) {
      if (token !== this.loadToken) return;
      const message = err instanceof Error ? err.message : 'Не вдалося завантажити сценарій';
      console.error('[ViewerComponent] Streamed load failed:', err);
      this.showError(message);
    }
  }

  /** Hands an already-downloaded archive to the engine. */
  private async runBuffer(zipBuffer: ArrayBuffer, token: number): Promise<void> {
    this.setState('loading-engine', 0, STAGE_ENGINE);
    // The archive is complete by now; the byte line stays, at "N з N МБ".
    this.loadedBytes.set(zipBuffer.byteLength);
    this.totalBytes.set(zipBuffer.byteLength);

    if (!this.app) throw new Error('Engine not initialized');

    this.armProfilerGuard();
    await this.app.loadScenarioFromBuffer(
      zipBuffer,
      (progress: IScenarioLoadProgress) => {
        if (token !== this.loadToken) return;
        this.progressPercent.set(Math.round(progress.progress * 100));
      }
    );

    if (token !== this.loadToken) return;
    this.setState('running', 100, '');

    this.watchProfiler();

    // Only count a launch that actually reached a running scene.
    void this.telemetry.startSession(this.scenarioId);
  }

  /**
   * Closes the profiler a scenario opened during load, and keeps closing it: a scenario can call
   * `showOverlay()` or re-open the engine's gate at any later moment, and the engine's setter is
   * two-way today. A once-a-second check costs nothing and bounds a re-opened overlay to a blink.
   */
  private watchProfiler(): void {
    if (enforceProfilerOff()) {
      console.warn('[ViewerComponent] Scenario opened the profiler; closed it.');
    }
    this.armProfilerGuard();
  }

  /**
   * Shuts the gate and starts the periodic re-check (once per component). Called at load *start*, not
   * only after success: a scenario's entry point runs during the load, so one that re-opens the gate
   * and then fails or stalls would otherwise stay open until the component is destroyed.
   */
  private armProfilerGuard(): void {
    lockProfiler();
    this.profilerGuard ??= setInterval(enforceProfilerOff, PROFILER_GUARD_INTERVAL_MS);
  }

  // ==================== VIEWER CONTROLS ====================

  /** Re-runs the scenario from the buffer already in memory — no re-download. */
  async restart(): Promise<void> {
    const buffer = this.loadedBuffer();
    if (!buffer || !this.app) return;

    const token = ++this.loadToken;
    try {
      await this.runBuffer(buffer, token);
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error('[ViewerComponent] Restart failed:', err);
      this.showError(err instanceof Error ? err.message : 'Не вдалося перезапустити сценарій');
    }
  }

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await this.canvasRef.nativeElement.parentElement?.requestFullscreen();
      }
    } catch (err) {
      console.warn('[ViewerComponent] Fullscreen rejected:', err);
    }
  }

  private readonly fullscreenChangeHandler = (): void => {
    this.isFullscreen.set(!!document.fullscreenElement);
  };

  /** ngOnDestroy never runs when the tab is closed; pagehide does. */
  private readonly pageHideHandler = (): void => {
    this.telemetry.endSession();
  };

  /** After a context loss the engine cannot recover in place — reload the page. */
  reloadPage(): void {
    window.location.reload();
  }

  // ==================== UI HELPERS ====================

  private setState(state: ViewerState, percent: number, stage: string): void {
    this.state.set(state);
    this.progressPercent.set(percent);
    this.stage.set(stage);
    this.loadedBytes.set(null);
    this.totalBytes.set(null);
    this.errorMessage.set(null);
  }

  private showError(message: string): void {
    this.state.set('error');
    this.errorMessage.set(message);
  }

  /** HUD "Вийти" and the loader's "Скасувати": back to the scenario's own page. */
  exit(): void {
    void this.router.navigate(this.routeId ? ['/scenario', this.routeId] : ['/catalog']);
  }

  /** The error, unsupported and context-lost screens keep their way out: the catalog. */
  goBack(): void {
    void this.router.navigate(['/catalog']);
  }
}
