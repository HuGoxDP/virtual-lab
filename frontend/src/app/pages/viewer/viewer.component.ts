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

// The only thing this page takes from the engine package: the host client of the sandboxed player.
// It carries no engine code, so nothing in the page can run a scenario (player-isolation).
import { PlayerHost } from 'WebEngineTS/player-host';
import type { PlayerError, PlayerHostOptions, PlayerLoadSource, PlayerProgress } from 'WebEngineTS/player-host';

import { IconComponent } from '../../ui/icon/icon.component';
import { ScenarioService, DownloadProgress } from '../../services/scenario.service';
import { TelemetryService } from '../../services/telemetry.service';
import { ScenarioCatalogItem } from '../../models/scenario.model';
import {
  STAGE_ENGINE,
  STAGE_FETCH,
  absoluteUrl,
  isPauseShortcut,
  mapPlayerError,
  readFlag,
} from './viewer-format';
import { ViewerHudComponent } from './viewer-hud.component';
import { ViewerLoadingComponent } from './viewer-loading.component';

/** Where the sandboxed player, the engine bundle it imports and the KTX2 transcoder are served. */
const PLAYER_URL = '/player/player.html';
const ENGINE_URL = '/assets/WebEngineTS.standalone.js';
/** The engine's default is `/basis/`, which 404s here: Angular publishes `src/assets` under `/assets`. */
const TRANSCODER_PATH = '/assets/basis/';

/** The slice of `PlayerHost` the viewer drives; a spec substitutes a fake with the same surface. */
export type PlayerHostLike = Pick<PlayerHost, 'load' | 'restart' | 'pause' | 'resume' | 'measure' | 'dispose'>;

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

  /** Where the sandboxed player frame is put; the frame is created and removed by `PlayerHost`. */
  @ViewChild('playerHost', { static: true })
  playerRef!: ElementRef<HTMLElement>;

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly scenarioService = inject(ScenarioService);
  private readonly telemetry = inject(TelemetryService);

  private readonly destroy$ = new Subject<void>();
  private host: PlayerHostLike | null = null;

  /** Aborts the archive download when the user navigates away mid-transfer. */
  private downloadAbort: AbortController | null = null;

  /**
   * What the player ran, kept so "restart" can run it again in a fresh frame without downloading it
   * again: the archive as a `Blob` (the host owns the bytes; the frame only ever receives a copy), or
   * the manifest URL of a streamed run.
   *
   * A signal, not a field, because `canRestart` derives from it.
   */
  private readonly loadedSource = signal<PlayerLoadSource | null>(null);

  /**
   * Incremented on every navigation and restart so a load that is still in flight cannot write its
   * result over a newer one.
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

  /** Frames per second reported by the player; `null` until the first report of a run. */
  readonly fps = signal<number | null>(null);
  /** Whether the player confirmed the scenario's clock is paused. Reflects the player, never guesses. */
  readonly paused = signal(false);

  /**
   * Whether to show the engine build stamp (`?diag=1`). The stamp is all the flag does: the
   * profiler overlay never runs on the platform, with or without it (the host always sends `diag: false`).
   */
  readonly buildStampVisible = signal(false);

  /**
   * Which engine build the player runs, for the diagnostics readout; `''` until known.
   *
   * The page holds no engine, so the only source is the player's own measurement
   * (`PlayerMetrics.engineBuild`), asked for once the scenario is running. Not `Application.version`:
   * that is a string literal fixed at "0.1.0" across every local pack, so it cannot tell two builds apart.
   */
  readonly engineBuild = signal('');

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

  /** Pause needs a running scenario in a live frame. */
  readonly canPause = computed(() => this.state() === 'running' && !this.contextLost());

  /** Any run can start again in a fresh frame: the ZIP from the retained Blob, a streamed one from its manifest. */
  readonly canRestart = computed(
    () => this.state() === 'running' && !this.contextLost() && this.loadedSource() !== null
  );

  // ==================== LIFECYCLE ====================

  ngAfterViewInit(): void {
    // Read once: these are launch options, not something to toggle mid-run.
    const query = this.route.snapshot.queryParamMap;
    this.buildStampVisible.set(readFlag(query.get('diag')));
    this.streamingRequested.set(readFlag(query.get('stream')));

    // Probe before starting: a machine without WebGL2 should see the explanation, not a frame that
    // fails inside the sandbox.
    if (!ViewerComponent.supportsWebGL2()) {
      this.state.set('unsupported');
      return;
    }

    this.host = this.createPlayerHost(this.playerRef.nativeElement, {
      playerUrl: PLAYER_URL,
      engineUrl: ENGINE_URL,
      transcoderPath: TRANSCODER_PATH,
      callbacks: {
        onProgress: progress => this.onPlayerProgress(progress),
        onFps: value => this.fps.set(value),
        onPaused: value => this.paused.set(value),
        onContextLost: () => this.contextLost.set(true),
        onError: error => this.onPlayerError(error),
      },
    });

    document.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
    document.addEventListener('keydown', this.keydownHandler);
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
    this.loadToken++; // a load still in flight is now stale: it must not write into a dead component

    // Stop streaming a possibly-large archive into a dead component.
    this.downloadAbort?.abort();
    this.downloadAbort = null;
    this.loadedSource.set(null);

    document.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
    document.removeEventListener('keydown', this.keydownHandler);
    window.removeEventListener('pagehide', this.pageHideHandler);
    this.telemetry.endSession();

    // Full cleanup: frame → scenario → engine → WebGL context all go with the iframe element.
    this.host?.dispose();
    this.host = null;
  }

  /** Test seam: jsdom has no WebGL2 or real frames, so a spec swaps the host out here. Behaviour is `new PlayerHost`. */
  protected createPlayerHost(container: HTMLElement, options: PlayerHostOptions): PlayerHostLike {
    return new PlayerHost(container, options);
  }

  /** Cheap feature probe; the context is released immediately. */
  private static supportsWebGL2(): boolean {
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

  // ==================== PLAYER CALLBACKS ====================

  /** Only a run in flight has a progress ring; a late report from a discarded frame is dropped by the host. */
  private onPlayerProgress(progress: PlayerProgress): void {
    if (this.state() === 'loading-engine') this.progressPercent.set(Math.round(progress.progress * 100));
  }

  private onPlayerError(error: PlayerError): void {
    // Before the next run reaches the player there is no run of ours to fail (a frame being replaced
    // by a new scenario must not put its own error over the download).
    if (this.state() === 'downloading' || this.state() === 'idle') return;

    const message = mapPlayerError(error);
    if (message === null) {
      console.warn('[ViewerComponent] Scenario error:', error.message);
      return;
    }
    console.error(`[ViewerComponent] Player ${error.code} error:`, error.message);
    this.showError(message);
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
   * 1. Download the ZIP from its URL (with progress), unless streaming was asked for and exists
   * 2. Hand the archive (as a Blob) or the manifest URL to the sandboxed player
   * 3. The player's engine unpacks it, validates the manifest and executes the entry point
   */
  private async startLoading(scenario: ScenarioCatalogItem, token: number): Promise<void> {
    if (this.streamingRequested() && scenario.manifestUrl) {
      // No download step: the engine in the frame fetches scripts and assets itself, in priority order.
      const source: PlayerLoadSource = { kind: 'manifest', url: absoluteUrl(scenario.manifestUrl, location.href) };
      this.loadedSource.set(source);
      await this.runSource(source, token, false);
      return;
    }

    this.setState('downloading', 0, STAGE_FETCH);
    this.loadedBytes.set(0);

    this.downloadAbort?.abort();
    const abort = new AbortController();
    this.downloadAbort = abort;

    let archive: ArrayBuffer;
    try {
      archive = await this.scenarioService.downloadScenarioZip(
        scenario,
        (progress: DownloadProgress) => {
          if (token !== this.loadToken) return;
          this.progressPercent.set(progress.percent >= 0 ? progress.percent : 0);
          this.loadedBytes.set(progress.loaded);
          this.totalBytes.set(progress.total);
        },
        abort.signal
      );
    } catch (err) {
      if (token !== this.loadToken || abort.signal.aborted) return;
      console.error('[ViewerComponent] Download failed:', err);
      this.showError(err instanceof Error ? err.message : 'Невідома помилка при завантаженні сценарію');
      return;
    }

    if (token !== this.loadToken) return;
    // The host keeps the bytes as a Blob; the player gets a structured copy on every (re)start.
    const source: PlayerLoadSource = { kind: 'blob', blob: new Blob([archive], { type: 'application/zip' }) };
    this.loadedSource.set(source);
    // The archive is complete by now; the byte line stays, at "N з N МБ".
    await this.runSource(source, token, false, archive.byteLength);
  }

  /**
   * Starts (or restarts) the player on `source` and follows it to `running`.
   *
   * Every failure that matters has already reached `onPlayerError` (the host reports before it
   * rejects); a rejection caused by a newer run or by destroying the view carries a stale token and
   * stays silent. What is left is a rejection nobody reported, which must not leave a spinner.
   */
  private async runSource(source: PlayerLoadSource, token: number, restart: boolean, archiveBytes?: number): Promise<void> {
    const host = this.host;
    if (!host) return;

    this.setState('loading-engine', 0, STAGE_ENGINE);
    if (archiveBytes !== undefined) {
      this.loadedBytes.set(archiveBytes);
      this.totalBytes.set(archiveBytes);
    }
    this.fps.set(null);
    this.paused.set(false); // a fresh frame never starts paused

    try {
      // diag is always false: the profiler is off on the platform, whatever the scenario or `?diag=1` says.
      await (restart ? host.restart() : host.load(source, { diag: false }));
    } catch (err) {
      if (token === this.loadToken && this.state() === 'loading-engine') {
        console.error('[ViewerComponent] Run failed:', err);
        this.showError(err instanceof Error ? err.message : 'Не вдалося завантажити сценарій');
      }
      return;
    }

    if (token !== this.loadToken) return;
    this.setState('running', 100, '');
    this.focusFrame();

    // Only count a launch that actually reached a running scene.
    void this.telemetry.startSession(this.scenarioId);

    if (this.buildStampVisible()) void this.readEngineBuild(host, token);
  }

  /** Asks the player which engine it runs; the stamp shows about a second after the scenario starts. */
  private async readEngineBuild(host: PlayerHostLike, token: number): Promise<void> {
    try {
      const metrics = await host.measure(1);
      if (token === this.loadToken) this.engineBuild.set(`engine ${metrics.engineBuild}`);
    } catch (err) {
      if (token === this.loadToken) console.warn('[ViewerComponent] Engine build unavailable:', err);
    }
  }

  // ==================== VIEWER CONTROLS ====================

  /** Runs the same source again in a fresh frame — no re-download, no state carried over from the old frame. */
  async restart(): Promise<void> {
    const source = this.loadedSource();
    if (!source || !this.host) return;

    await this.runSource(source, ++this.loadToken, true);
  }

  /** HUD pause button and the Space shortcut. The state flips when the player confirms (`onPaused`). */
  togglePause(): void {
    if (!this.canPause()) return;
    if (this.paused()) this.host?.resume();
    else this.host?.pause();
  }

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        // The host's container (frame + HUD), not the frame: the frame is given no `fullscreen` permission.
        await this.playerRef.nativeElement.parentElement?.requestFullscreen();
      }
    } catch (err) {
      console.warn('[ViewerComponent] Fullscreen rejected:', err);
    }
  }

  /** Keyboard focus goes to the scenario, so its controls work without a click first. */
  private focusFrame(): void {
    this.playerRef.nativeElement.querySelector('iframe')?.focus();
  }

  private readonly fullscreenChangeHandler = (): void => {
    this.isFullscreen.set(!!document.fullscreenElement);
  };

  /**
   * Space pauses while the host page has the keyboard. With the frame focused the same key is handled
   * by the player inside the frame, which reports `paused` back; the key event goes to exactly one of
   * the two documents (a frame's key events never reach this page), so one press is one toggle. Both
   * routes end in the player's own confirmation (`onPaused`), and a pause/resume request for the state
   * the player is already in is a no-op there, so even a double delivery could not flip it back.
   */
  private readonly keydownHandler = (event: KeyboardEvent): void => {
    if (!this.canPause() || !isPauseShortcut(event)) return;
    event.preventDefault();
    this.togglePause();
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
