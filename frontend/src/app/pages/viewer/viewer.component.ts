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
import { Application, BuildInfo, MemoryProfiler, Texture2D } from 'WebEngineTS';
import type { IScenarioLoadProgress } from 'WebEngineTS';

import { ScenarioService, DownloadProgress } from '../../services/scenario.service';
import { TelemetryService } from '../../services/telemetry.service';
import { ScenarioCatalogItem } from '../../models/scenario.model';

/**
 * Viewer states for the loading UI.
 */
type ViewerState = 'idle' | 'downloading' | 'loading-engine' | 'running' | 'error' | 'unsupported';

@Component({
  selector: 'app-viewer',
  standalone: true,
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

  /** Kept so "restart" can re-run the scenario without downloading it again. */
  private loadedBuffer: ArrayBuffer | null = null;

  private contextLostHandler: ((event: Event) => void) | null = null;

  /**
   * Incremented on every navigation so a load that is still in flight cannot
   * write its result over a newer one.
   */
  private loadToken = 0;

  /** Catalog id of the scenario currently loaded, for telemetry attribution. */
  private scenarioId = '';

  // UI state. Signals, not plain fields: the app is zoneless, so a signal write
  // is what notifies the change-detection scheduler. Mutating a field from an
  // async callback would never repaint.
  readonly state = signal<ViewerState>('idle');
  readonly progressPercent = signal(0);
  readonly progressLabel = signal('');
  readonly errorMessage = signal<string | null>(null);
  readonly scenarioTitle = signal('');
  readonly contextLost = signal(false);
  readonly isFullscreen = signal(false);
  readonly diagnosticsVisible = signal(false);

  /**
   * Whether the engine diagnostics overlay may be opened at all.
   *
   * Off unless the URL asks for it (`?diag=1`), per scenario. Diagnostics are a
   * measurement tool, not a student-facing feature: without the flag the button
   * is not rendered, the overlay is never created, and nothing is sampled — the
   * profiler's rAF loop only exists while the overlay does, so the cost is
   * genuinely zero rather than merely hidden.
   */
  readonly diagnosticsEnabled = signal(false);

  readonly isLoading = computed(
    () => this.state() === 'downloading' || this.state() === 'loading-engine'
  );

  readonly canRestart = computed(() => this.state() === 'running' && !this.contextLost());

  /** Stroke offset for the progress ring (circumference ≈ 264). */
  readonly ringOffset = computed(() => 264 - (264 * this.progressPercent() / 100));

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
    this.app = new Application(canvas);

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

    // Read once: the flag is a launch option, not something to toggle mid-run.
    this.diagnosticsEnabled.set(
      ViewerComponent.readDiagFlag(this.route.snapshot.queryParamMap.get('diag'))
    );

    this.route.paramMap
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        const id = params.get('id');
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

    // Stop streaming a possibly-large archive into a dead component.
    this.downloadAbort?.abort();
    this.downloadAbort = null;
    this.loadedBuffer = null;

    const canvas = this.canvasRef.nativeElement;
    if (this.contextLostHandler) {
      canvas.removeEventListener('webglcontextlost', this.contextLostHandler);
      this.contextLostHandler = null;
    }
    document.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
    window.removeEventListener('pagehide', this.pageHideHandler);
    this.telemetry.endSession();

    if (this.diagnosticsVisible()) MemoryProfiler.hideOverlay();

    // Full cleanup: scenario → engine → WebGL context
    if (this.app) {
      this.app.dispose();
      this.app = null;
    }
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
    this.setState('downloading', 0, 'Отримання даних сценарію...');

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
    this.setState('downloading', 0, 'Завантаження архіву...');

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
          const mb = (progress.loaded / (1024 * 1024)).toFixed(1);
          this.progressLabel.set(`Завантаження: ${mb} MB`);
        },
        abort.signal
      );

      if (token !== this.loadToken) return;
      this.loadedBuffer = zipBuffer;

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

  /** Hands an already-downloaded archive to the engine. */
  private async runBuffer(zipBuffer: ArrayBuffer, token: number): Promise<void> {
    this.setState('loading-engine', 0, 'Ініціалізація сцени...');

    if (!this.app) throw new Error('Engine not initialized');

    await this.app.loadScenarioFromBuffer(
      zipBuffer,
      (progress: IScenarioLoadProgress) => {
        if (token !== this.loadToken) return;
        this.progressPercent.set(Math.round(progress.progress * 100));
        this.progressLabel.set(progress.currentOperation);
      }
    );

    if (token !== this.loadToken) return;
    this.setState('running', 100, '');

    this.enforceDiagnosticsPolicy();

    // Only count a launch that actually reached a running scene.
    void this.telemetry.startSession(this.scenarioId);
  }

  /**
   * Closes the profiler overlay if the scenario opened it without `?diag=1`.
   *
   * A scenario is arbitrary engine code and can call `MemoryProfiler.showOverlay()`
   * itself — `solar-system` does, so students were being shown a developer
   * overlay of FPS and VRAM counters on the platform's flagship scenario. The
   * gating on the button cannot prevent that: it only governs the platform's own
   * control, not what the content does once it is running.
   *
   * Whether the overlay belongs in a scenario at all is ScenarioCreator's
   * question. Whether students see it is this platform's, so it is decided here
   * rather than assumed.
   */
  private enforceDiagnosticsPolicy(): void {
    if (this.diagnosticsEnabled()) return;

    if (MemoryProfiler.isOverlayVisible) {
      MemoryProfiler.hideOverlay();
      console.warn('[ViewerComponent] Scenario opened the profiler overlay; closed it (no ?diag=1).');
    }
  }

  // ==================== VIEWER CONTROLS ====================

  /** Re-runs the scenario from the buffer already in memory — no re-download. */
  async restart(): Promise<void> {
    if (!this.loadedBuffer || !this.app) return;

    const token = ++this.loadToken;
    try {
      await this.runBuffer(this.loadedBuffer, token);
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

  /**
   * Engine-provided overlay: FPS, CPU frame time, VRAM estimates.
   *
   * Guarded as well as hidden. The template does not render the button without
   * the flag, but a stale DOM node or a console call must not be able to start
   * sampling either.
   */
  toggleDiagnostics(): void {
    if (!this.diagnosticsEnabled()) return;

    MemoryProfiler.toggleOverlay();
    this.diagnosticsVisible.set(MemoryProfiler.isOverlayVisible);
  }

  /** Accepts `1`, `true` or a bare `?diag`; anything else means off. */
  private static readDiagFlag(raw: string | null): boolean {
    if (raw === null) return false;
    const v = raw.toLowerCase();
    return v === '' || v === '1' || v === 'true';
  }

  /** After a context loss the engine cannot recover in place — reload the page. */
  reloadPage(): void {
    window.location.reload();
  }

  // ==================== UI HELPERS ====================

  private setState(state: ViewerState, percent: number, label: string): void {
    this.state.set(state);
    this.progressPercent.set(percent);
    this.progressLabel.set(label);
    this.errorMessage.set(null);
  }

  private showError(message: string): void {
    this.state.set('error');
    this.errorMessage.set(message);
  }

  goBack(): void {
    void this.router.navigate(['/catalog']);
  }
}
