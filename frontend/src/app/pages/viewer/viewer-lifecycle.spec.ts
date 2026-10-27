// path: src/app/pages/viewer/viewer-lifecycle.spec.ts
//
// Player isolation, phase 5 - the viewer drives a sandboxed `PlayerHost` instead of running the engine in
// the page. jsdom has no WebGL2 and no real frames, so `ViewerComponent.supportsWebGL2` is stubbed to true
// and the protected `createPlayerHost` seam returns a fake with the host's surface that captures the
// callbacks the viewer registered. Test-plan scenarios 164-169. DW-5.2, DW-5.5.

import { TestBed, ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import type { PlayerHostOptions, PlayerLoadSource } from 'WebEngineTS/player-host';

import { ScenarioService } from '../../services/scenario.service';
import { TelemetryService } from '../../services/telemetry.service';
import { ViewerComponent } from './viewer.component';
import { STAGE_ENGINE, STAGE_FETCH } from './viewer-format';

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ITEM = { id: 'solar-system', title: 'Сонячна система', scenarioUrl: '/scenarios/a.zip', manifestUrl: '/a/solar-system.json' };
const zip = () => new ArrayBuffer(2_000_000);

type DownloadProgress = (p: { loaded: number; total: number; percent: number }) => void;
type Callbacks = NonNullable<PlayerHostOptions['callbacks']>;
type Failure = { code: 'handshake' | 'origin' | 'version' | 'load' | 'runtime'; message: string };

function makeHost() {
  const host = {
    options: undefined as unknown as PlayerHostOptions,
    container: undefined as unknown as HTMLElement,
    load: vi.fn(async (_s: PlayerLoadSource, _o: { diag: boolean }): Promise<void> => undefined),
    restart: vi.fn(async (): Promise<void> => undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    measure: vi.fn(async (_s: number) => ({ timeToFirstFrameMs: 1, avgFps: 60, gpuMemoryBytes: 1, consoleErrors: 0, engineBuild: '0.1.0-local.9 (2026-10-26T10:00:00Z)' })),
    dispose: vi.fn(),
    cb: () => host.options.callbacks as Callbacks,
  };
  return host;
}

function makeService(item: Partial<typeof ITEM> = {}) {
  return {
    fetchScenarioById: vi.fn(async () => ({ ...ITEM, ...item })),
    downloadScenarioZip: vi.fn(async (_s: unknown, onProgress?: DownloadProgress, _signal?: AbortSignal) => {
      onProgress?.({ loaded: 1_000_000, total: 2_000_000, percent: 50 });
      return zip();
    }),
  };
}

function makeTelemetry() {
  return { startSession: vi.fn(async (_id: string) => undefined), endSession: vi.fn() };
}

interface Doubles {
  host: ReturnType<typeof makeHost>;
  service: ReturnType<typeof makeService>;
  telemetry: ReturnType<typeof makeTelemetry>;
}

function setup(opts: {
  query?: Record<string, string>;
  id?: string | null;
  item?: Partial<typeof ITEM>;
  arrange?: (d: Doubles) => void;
  webgl2?: boolean;
} = {}) {
  const host = makeHost();
  const service = makeService(opts.item);
  const telemetry = makeTelemetry();
  opts.arrange?.({ host, service, telemetry });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(ViewerComponent as any, 'supportsWebGL2').mockReturnValue(opts.webgl2 ?? true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(ViewerComponent.prototype as any, 'createPlayerHost').mockImplementation(((container: HTMLElement, options: PlayerHostOptions) => {
    host.container = container;
    host.options = options;
    return host;
  }) as never);

  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ScenarioService, useValue: service },
      { provide: TelemetryService, useValue: telemetry },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { queryParamMap: convertToParamMap(opts.query ?? {}) },
          paramMap: new BehaviorSubject(convertToParamMap(opts.id === null ? {} : { id: opts.id ?? 'solar-system' })),
        },
      },
    ],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(ViewerComponent);
  fixture.detectChanges(); // ngAfterViewInit starts the load
  return { fixture, viewer: fixture.componentInstance, host, service, telemetry, navigate };
}

async function until(fixture: ComponentFixture<ViewerComponent>, check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true));
  fixture.detectChanges();
}
const running = (f: ComponentFixture<ViewerComponent>) => until(f, () => f.componentInstance.state() === 'running');
const loadingEngine = (f: ComponentFixture<ViewerComponent>) => until(f, () => f.componentInstance.state() === 'loading-engine');
const el = (f: ComponentFixture<ViewerComponent>) => f.nativeElement as HTMLElement;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const space = (init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('ViewerComponent on PlayerHost', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  describe('164 host construction and the engine-free page', () => {
    it('DW-5.5 builds the host with the player, the engine bundle and the transcoder the platform serves', async () => {
      const { fixture, host } = setup();
      await running(fixture);
      expect(host.options).toMatchObject({
        playerUrl: '/player/player.html',
        engineUrl: '/assets/WebEngineTS.standalone.js',
        transcoderPath: '/assets/basis/',
      });
      expect(host.container).toBe(el(fixture).querySelector('.player-host'));
    });

    it('DW-5.2 always loads with diag: false, with ?diag=1 or without', async () => {
      for (const query of [{}, { diag: '1' }] as Record<string, string>[]) {
        const { fixture, host } = setup({ query });
        await running(fixture);
        expect(host.load).toHaveBeenCalledWith(expect.anything(), { diag: false });
        TestBed.resetTestingModule();
        vi.restoreAllMocks();
      }
    });

    it('no WebGL2: the unsupported screen shows and no host is created', async () => {
      const { fixture, viewer, host } = setup({ webgl2: false });
      expect(viewer.state()).toBe('unsupported');
      expect(host.options).toBeUndefined();
      fixture.detectChanges();
      expect(el(fixture).textContent).toContain('Браузер не підтримує WebGL 2');
    });

    it('the viewer exposes no diagnostics or in-page engine members', () => {
      const { viewer } = setup({ query: { diag: '1' } });
      const members = viewer as unknown as Record<string, unknown>;
      for (const name of ['toggleDiagnostics', 'diagnosticsVisible', 'enforceDiagnosticsPolicy', 'app', 'createApplication']) {
        expect(members[name]).toBeUndefined();
      }
    });
  });

  describe('149 exit()', () => {
    it('goes to /scenario/:id when the URL carried an id', async () => {
      const { fixture, viewer, navigate } = setup();
      await running(fixture);
      viewer.exit();
      expect(navigate).toHaveBeenCalledWith(['/scenario', 'solar-system']);
    });

    it('goes to /catalog without a route id', async () => {
      const { fixture, viewer, navigate } = setup({ id: null });
      await until(fixture, () => viewer.state() === 'error');
      expect(viewer.errorMessage()).toBe('Сценарій не вказано.');
      viewer.exit();
      expect(navigate).toHaveBeenCalledWith(['/catalog']);
    });

    it('still targets /scenario/:id when the lookup failed', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { fixture, viewer, navigate } = setup({ arrange: d => d.service.fetchScenarioById.mockRejectedValue(new Error('404')) });
      await until(fixture, () => viewer.state() === 'error');
      viewer.exit();
      expect(navigate).toHaveBeenCalledWith(['/scenario', 'solar-system']);
    });

    it('DW-5.2 "Скасувати" exits; destroying mid-download aborts it with no error screen and starts no frame', async () => {
      let signal: AbortSignal | undefined;
      const pending = deferred<ArrayBuffer>();
      const { fixture, viewer, navigate, host } = setup({
        arrange: d => d.service.downloadScenarioZip.mockImplementation(async (_s, _p, sig) => {
          signal = sig;
          sig?.addEventListener('abort', () => pending.reject(new DOMException('aborted', 'AbortError')));
          return pending.promise;
        }),
      });
      await until(fixture, () => viewer.state() === 'downloading' && signal !== undefined);
      el(fixture).querySelector<HTMLButtonElement>('vl-viewer-loading .cancel')!.click();
      expect(navigate).toHaveBeenCalledWith(['/scenario', 'solar-system']);

      fixture.destroy();
      expect(signal!.aborted).toBe(true);
      await tick();
      expect(viewer.state()).not.toBe('error');
      expect(host.load).not.toHaveBeenCalled();
      expect(host.dispose).toHaveBeenCalledTimes(1);
    });

    it('DW-5.2 leaving mid-load disposes the frame; the rejection that follows writes nothing', async () => {
      const hold = deferred<void>();
      const { fixture, viewer, host, telemetry } = setup({ arrange: d => d.host.load.mockImplementationOnce(() => hold.promise) });
      await loadingEngine(fixture);
      fixture.destroy();
      expect(host.dispose).toHaveBeenCalledTimes(1);
      hold.reject(new Error('[PlayerHost] disposed.'));
      await tick();
      expect(viewer.state()).toBe('loading-engine');
      expect(telemetry.startSession).not.toHaveBeenCalled();
    });
  });

  describe('150 ZIP run, Blob retention and canRestart', () => {
    it('DW-5.2 a ZIP run hands the host a Blob of the archive, reaches running and focuses the frame', async () => {
      const frame = document.createElement('iframe');
      frame.focus = vi.fn();
      const { fixture, viewer, host, service, telemetry } = setup({
        arrange: d => d.host.load.mockImplementationOnce(async () => { d.host.container.appendChild(frame); }),
      });
      await running(fixture);

      const [source, opts] = host.load.mock.calls[0];
      expect(source.kind).toBe('blob');
      const blob = (source as { kind: 'blob'; blob: Blob }).blob;
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(2_000_000);
      expect(opts).toEqual({ diag: false });
      expect(service.downloadScenarioZip).toHaveBeenCalledTimes(1);
      expect(telemetry.startSession).toHaveBeenCalledWith('solar-system');
      expect(frame.focus).toHaveBeenCalledTimes(1);
      expect(viewer.canRestart()).toBe(true);
      expect(el(fixture).querySelector<HTMLButtonElement>('vl-viewer-hud .restart')!.disabled).toBe(false);
    });

    it('DW-5.2 a streamed run loads the absolute manifest URL, downloads nothing, and can restart', async () => {
      const { fixture, viewer, host, service } = setup({ query: { stream: '1' } });
      await running(fixture);
      expect(host.load).toHaveBeenCalledWith({ kind: 'manifest', url: `${location.origin}/a/solar-system.json` }, { diag: false });
      expect(service.downloadScenarioZip).not.toHaveBeenCalled();
      expect(viewer.canRestart()).toBe(true);
    });

    it('?stream=1 on a scenario without a manifestUrl falls back to the ZIP', async () => {
      const { fixture, host, service } = setup({ query: { stream: '1' }, item: { manifestUrl: null as never } });
      await running(fixture);
      expect(service.downloadScenarioZip).toHaveBeenCalledTimes(1);
      expect(host.load.mock.calls[0][0].kind).toBe('blob');
    });

    it('canRestart and canPause are false after the context is lost, and the overlay shows', async () => {
      const { fixture, viewer, host } = setup();
      await running(fixture);
      host.cb().onContextLost!();
      expect(viewer.contextLost()).toBe(true);
      expect(viewer.canRestart()).toBe(false);
      expect(viewer.canPause()).toBe(false);
      fixture.detectChanges();
      expect(el(fixture).textContent).toContain('Графічний контекст втрачено');
    });

    it('canRestart is false while a restart is loading, true again once it is running', async () => {
      const { fixture, viewer, host } = setup();
      await running(fixture);
      const hold = deferred<void>();
      host.restart.mockImplementationOnce(() => hold.promise);
      const restarting = viewer.restart();
      expect(viewer.state()).toBe('loading-engine');
      expect(viewer.canRestart()).toBe(false);
      hold.resolve();
      await restarting;
      expect(viewer.state()).toBe('running');
      expect(viewer.canRestart()).toBe(true);
    });
  });

  describe('151 restart()', () => {
    it('DW-5.2 restarts in a fresh frame (host.restart) with no second download and a second telemetry launch', async () => {
      const { fixture, viewer, host, service, telemetry } = setup();
      await running(fixture);
      await viewer.restart();
      expect(host.restart).toHaveBeenCalledTimes(1);
      expect(host.load).toHaveBeenCalledTimes(1);
      expect(service.downloadScenarioZip).toHaveBeenCalledTimes(1);
      expect(telemetry.startSession).toHaveBeenCalledTimes(2);
      expect(viewer.state()).toBe('running');
    });

    it('DW-5.2 restart while paused: the new frame is not paused and carries no stale FPS', async () => {
      const { fixture, viewer, host } = setup();
      await running(fixture);
      host.cb().onPaused!(true);
      host.cb().onFps!(58);
      expect(viewer.paused()).toBe(true);
      await viewer.restart();
      expect(viewer.paused()).toBe(false);
      expect(viewer.fps()).toBeNull();
    });

    it('a streamed run restarts from the same manifest', async () => {
      const { fixture, viewer, host } = setup({ query: { stream: '1' } });
      await running(fixture);
      await viewer.restart();
      expect(host.restart).toHaveBeenCalledTimes(1);
      expect(host.load).toHaveBeenCalledTimes(1);
    });

    it('shows the error screen with the player message when the restart fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { fixture, viewer, host } = setup();
      await running(fixture);
      host.restart.mockImplementationOnce(async () => {
        host.cb().onError!({ code: 'load', message: 'boom' });
        throw new Error('[PlayerHost] load: boom');
      });
      await viewer.restart();
      expect(viewer.state()).toBe('error');
      expect(viewer.errorMessage()).toBe('boom');
    });

    it('an unreported rejection still ends in the error screen, never a spinner', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { fixture, viewer, host } = setup();
      await running(fixture);
      host.restart.mockRejectedValueOnce('nope');
      await viewer.restart();
      expect(viewer.state()).toBe('error');
      expect(viewer.errorMessage()).toBe('Не вдалося завантажити сценарій');
    });

    it('is a no-op before any source has loaded', async () => {
      const hold = deferred<ArrayBuffer>();
      const { fixture, viewer, host } = setup({ arrange: d => d.service.downloadScenarioZip.mockReturnValue(hold.promise) });
      await until(fixture, () => viewer.state() === 'downloading');
      await viewer.restart();
      expect(host.restart).not.toHaveBeenCalled();
      hold.resolve(zip());
      await running(fixture);
    });
  });

  describe('165 host adapter: signals from player callbacks', () => {
    it('DW-5.2 fps reaches the HUD as "N FPS" and is absent before the first report', async () => {
      const { fixture, viewer, host } = setup();
      await running(fixture);
      expect(el(fixture).querySelector('vl-viewer-hud .fps')).toBeNull();
      host.cb().onFps!(59.6);
      fixture.detectChanges();
      expect(viewer.fps()).toBe(59.6);
      expect(el(fixture).querySelector('vl-viewer-hud .fps')!.textContent).toBe('60 FPS');
    });

    it('DW-5.2 the HUD shows the pause button and the Space hint while running', async () => {
      const { fixture } = setup();
      await running(fixture);
      expect(el(fixture).querySelector('vl-viewer-hud .pause')).not.toBeNull();
      expect(el(fixture).querySelector('vl-viewer-hud .hints')!.textContent).toContain('Space');
    });

    it('DW-5.2 the pause button asks the host to pause, and to resume once the player confirmed', async () => {
      const { fixture, viewer, host } = setup();
      await running(fixture);
      el(fixture).querySelector<HTMLButtonElement>('vl-viewer-hud .pause')!.click();
      expect(host.pause).toHaveBeenCalledTimes(1);
      expect(viewer.paused()).toBe(false); // the player has not confirmed yet
      host.cb().onPaused!(true);
      fixture.detectChanges();
      expect(el(fixture).querySelector('vl-viewer-hud .pause')!.getAttribute('aria-label')).toBe('Продовжити');
      el(fixture).querySelector<HTMLButtonElement>('vl-viewer-hud .pause')!.click();
      expect(host.resume).toHaveBeenCalledTimes(1);
    });

    it('progress drives the ring only while a run is loading', async () => {
      const hold = deferred<void>();
      const { fixture, viewer, host } = setup({ arrange: d => d.host.load.mockImplementationOnce(() => hold.promise) });
      await loadingEngine(fixture);
      host.cb().onProgress!({ progress: 0.42, operation: 'x' });
      expect(viewer.progressPercent()).toBe(42);
      hold.resolve();
      await running(fixture);
      host.cb().onProgress!({ progress: 0.1, operation: 'late' });
      expect(viewer.progressPercent()).toBe(100);
    });

    it('DW-5.2 a context loss inside the frame shows the overlay with reload and catalog actions', async () => {
      const { fixture, viewer, host, navigate } = setup();
      await running(fixture);
      host.cb().onContextLost!();
      fixture.detectChanges();
      const panel = el(fixture).querySelector('.error-overlay')!;
      const reload = vi.spyOn(viewer, 'reloadPage').mockImplementation(() => undefined);
      panel.querySelector<HTMLButtonElement>('.btn-primary')!.click();
      expect(reload).toHaveBeenCalled();
      panel.querySelector<HTMLButtonElement>('.btn-secondary')!.click();
      expect(navigate).toHaveBeenCalledWith(['/catalog']);
    });
  });

  describe('166 Space', () => {
    it('DW-5.2 Space with the host focused pauses, then resumes, and is consumed', async () => {
      const { fixture, viewer, host } = setup();
      await running(fixture);
      expect(space().defaultPrevented).toBe(true);
      expect(host.pause).toHaveBeenCalledTimes(1);
      host.cb().onPaused!(true);
      space();
      expect(host.resume).toHaveBeenCalledTimes(1);
      expect(viewer.paused()).toBe(true);
    });

    it('DW-5.2 Space does nothing before running, in a control, on repeat, with a modifier, or for another key', async () => {
      const hold = deferred<void>();
      const { fixture, host } = setup({ arrange: d => d.host.load.mockImplementationOnce(() => hold.promise) });
      await loadingEngine(fixture);
      space();
      hold.resolve();
      await running(fixture);

      const button = document.createElement('button');
      const input = document.createElement('input');
      document.body.append(button, input);
      expect(space({}, button).defaultPrevented).toBe(false);
      expect(space({}, input).defaultPrevented).toBe(false);
      space({ repeat: true });
      space({ ctrlKey: true });
      space({ code: 'Enter', key: 'Enter' });
      expect(host.pause).not.toHaveBeenCalled();
      button.remove();
      input.remove();
    });

    it('DW-5.U1 a Space pressed inside the frame never reaches the host handler: the player alone answers it', async () => {
      const { fixture, host } = setup();
      await running(fixture);
      const frame = document.createElement('iframe');
      host.container.appendChild(frame);
      const inner = frame.contentDocument!;
      const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
      inner.body.dispatchEvent(event);
      expect(host.pause).not.toHaveBeenCalled();
      expect(host.resume).not.toHaveBeenCalled();
      frame.remove();
    });

    it('DW-5.U1 a pause or resume request for the state the player is already in changes nothing on the host', async () => {
      const { fixture, viewer, host } = setup();
      await running(fixture);
      // The player paused itself (Space inside the frame) and said so; the host's view follows its word.
      host.cb().onPaused!(true);
      expect(viewer.paused()).toBe(true);
      host.cb().onPaused!(true); // a repeated report is not a toggle
      expect(viewer.paused()).toBe(true);
      host.cb().onPaused!(false);
      expect(viewer.paused()).toBe(false);
    });

    it('Space does nothing after a context loss or after the view is destroyed', async () => {
      const { fixture, host } = setup();
      await running(fixture);
      host.cb().onContextLost!();
      space();
      fixture.destroy();
      space();
      expect(host.pause).not.toHaveBeenCalled();
    });
  });

  describe('167 error mapping', () => {
    const fail = async (error: Failure) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const hold = deferred<void>();
      const ctx = setup({ arrange: d => d.host.load.mockImplementationOnce(() => hold.promise) });
      await loadingEngine(ctx.fixture);
      ctx.host.cb().onError!(error);
      hold.reject(new Error('[PlayerHost] failed'));
      await tick();
      return ctx;
    };

    it('DW-5.2 a player that never says hello is an error state, not a spinner', async () => {
      const { viewer, fixture } = await fail({ code: 'handshake', message: 'the player did not say hello within 10000 ms.' });
      expect(viewer.state()).toBe('error');
      expect(viewer.errorMessage()).toContain('Відтворювач сценаріїв не відповів');
      fixture.detectChanges();
      expect(el(fixture).querySelector('.error-content h1')!.textContent).toBe('Помилка завантаження');
    });

    it('an origin or version mismatch says the player is incompatible', async () => {
      for (const code of ['origin', 'version'] as const) {
        const { viewer } = await fail({ code, message: 'x' });
        expect(viewer.errorMessage()).toContain('не сумісний');
        TestBed.resetTestingModule();
        vi.restoreAllMocks();
      }
    });

    it('a load failure shows the player message and starts no telemetry', async () => {
      const { viewer, telemetry } = await fail({ code: 'load', message: 'bad manifest' });
      expect(viewer.errorMessage()).toBe('bad manifest');
      expect(telemetry.startSession).not.toHaveBeenCalled();
      expect(viewer.canRestart()).toBe(false);
    });

    it('a runtime error after start does not replace the running scene', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { fixture, viewer, host } = setup();
      await running(fixture);
      host.cb().onError!({ code: 'runtime', message: 'TypeError in scenario' });
      expect(viewer.state()).toBe('running');
      expect(viewer.errorMessage()).toBeNull();
    });

    it('an error reported while the archive is still downloading does not land on the download', async () => {
      const hold = deferred<ArrayBuffer>();
      const { fixture, viewer, host } = setup({ arrange: d => d.service.downloadScenarioZip.mockReturnValue(hold.promise) });
      await until(fixture, () => viewer.state() === 'downloading');
      host.cb().onError!({ code: 'load', message: 'old frame' });
      expect(viewer.state()).toBe('downloading');
      hold.resolve(zip());
      await running(fixture);
    });
  });

  describe('168 build stamp (?diag=1) through the player', () => {
    it('DW-5.2 asks the player for its build once running and shows it', async () => {
      const { fixture, viewer, host } = setup({ query: { diag: '1' } });
      expect(el(fixture).querySelector('.build-badge')).toBeNull();
      await running(fixture);
      await until(fixture, () => viewer.engineBuild() !== '');
      expect(host.measure).toHaveBeenCalledWith(1);
      expect(el(fixture).querySelector('.build-badge')!.textContent).toBe('engine 0.1.0-local.9 (2026-10-26T10:00:00Z)');
    });

    it('without ?diag=1 nothing is measured and no badge shows', async () => {
      const { fixture, host } = setup();
      await running(fixture);
      expect(host.measure).not.toHaveBeenCalled();
      expect(el(fixture).querySelector('.build-badge')).toBeNull();
    });

    it('a failed measurement leaves the scene running and the badge absent', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { fixture, viewer, host } = setup({ query: { diag: '1' }, arrange: d => d.host.measure.mockRejectedValue(new Error('not running')) });
      await running(fixture);
      await tick();
      expect(viewer.state()).toBe('running');
      expect(viewer.engineBuild()).toBe('');
      expect(host.measure).toHaveBeenCalled();
    });
  });

  describe('152 byte-signal reset', () => {
    it('engine stage shows "N з N" while loading, then every byte signal resets on running', async () => {
      const hold = deferred<void>();
      const { fixture, viewer } = setup({ arrange: d => d.host.load.mockImplementationOnce(() => hold.promise) });
      await loadingEngine(fixture);
      expect(viewer.stage()).toBe(STAGE_ENGINE);
      expect(viewer.loadedBytes()).toBe(2_000_000);
      expect(viewer.totalBytes()).toBe(2_000_000);
      hold.resolve();
      await running(fixture);
      expect(viewer.stage()).toBe('');
      expect(viewer.loadedBytes()).toBeNull();
      expect(viewer.progressPercent()).toBe(100);
      expect(el(fixture).querySelector('vl-viewer-loading')).toBeNull();
    });

    it('the download phase shows the fetch stage, the byte progress and the ring percent', async () => {
      const hold = deferred<ArrayBuffer>();
      const { fixture, viewer } = setup({
        arrange: d => d.service.downloadScenarioZip.mockImplementation(async (_s, onProgress) => {
          onProgress?.({ loaded: 1_000_000, total: 2_000_000, percent: 50 });
          return hold.promise;
        }),
      });
      await until(fixture, () => viewer.loadedBytes() === 1_000_000);
      expect(viewer.state()).toBe('downloading');
      expect(viewer.stage()).toBe(STAGE_FETCH);
      expect(viewer.progressPercent()).toBe(50);
      hold.resolve(zip());
      await running(fixture);
    });

    it('an unknown total (percent -1) leaves the ring at 0', async () => {
      const hold = deferred<ArrayBuffer>();
      const { fixture, viewer } = setup({
        arrange: d => d.service.downloadScenarioZip.mockImplementation(async (_s, onProgress) => {
          onProgress?.({ loaded: 300, total: 0, percent: -1 });
          return hold.promise;
        }),
      });
      await until(fixture, () => viewer.loadedBytes() === 300);
      expect(viewer.progressPercent()).toBe(0);
      hold.resolve(zip());
      await running(fixture);
    });

    it('the streamed path has no archive download: byte signals stay null', async () => {
      const hold = deferred<void>();
      const { fixture, viewer } = setup({ query: { stream: '1' }, arrange: d => d.host.load.mockImplementationOnce(() => hold.promise) });
      await loadingEngine(fixture);
      expect(viewer.loadedBytes()).toBeNull();
      expect(el(fixture).querySelector('.loader-bytes')).toBeNull();
      hold.resolve();
      await running(fixture);
    });
  });

  describe('153 failures and stale loads', () => {
    it('a lookup failure shows "Сценарій не знайдено." and never starts a frame', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { fixture, viewer, host } = setup({ arrange: d => d.service.fetchScenarioById.mockRejectedValue(new Error('404')) });
      await until(fixture, () => viewer.state() === 'error');
      expect(viewer.errorMessage()).toBe('Сценарій не знайдено.');
      expect(host.load).not.toHaveBeenCalled();
    });

    it('a scenario without an archive shows the "no archive" message', async () => {
      const { fixture, viewer, service } = setup({ item: { scenarioUrl: '' } });
      await until(fixture, () => viewer.state() === 'error');
      expect(viewer.errorMessage()).toBe('Для цього сценарію ще не завантажено архів.');
      expect(service.downloadScenarioZip).not.toHaveBeenCalled();
    });

    it('a failed download shows its message, with the Ukrainian fallback for a non-Error, and starts no frame', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const a = setup({ arrange: d => d.service.downloadScenarioZip.mockRejectedValue(new Error('HTTP 500')) });
      await until(a.fixture, () => a.viewer.state() === 'error');
      expect(a.viewer.errorMessage()).toBe('HTTP 500');
      expect(a.host.load).not.toHaveBeenCalled();
      expect(a.telemetry.startSession).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
      vi.restoreAllMocks();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const b = setup({ arrange: d => d.service.downloadScenarioZip.mockRejectedValue('x') });
      await until(b.fixture, () => b.viewer.state() === 'error');
      expect(b.viewer.errorMessage()).toBe('Невідома помилка при завантаженні сценарію');
    });

    it('a restart superseded by a newer one cannot overwrite its result', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { fixture, viewer, host } = setup();
      await running(fixture);
      const slow = deferred<void>();
      host.restart.mockImplementationOnce(() => slow.promise);
      const first = viewer.restart();
      host.restart.mockImplementationOnce(async () => {
        host.cb().onError!({ code: 'load', message: 'late' });
        throw new Error('late');
      });
      await viewer.restart();
      expect(viewer.state()).toBe('error');
      slow.resolve(); // the stale one finishing afterwards must not flip it back to running
      await first;
      expect(viewer.state()).toBe('error');
      expect(viewer.errorMessage()).toBe('late');
    });
  });

  describe('169 teardown and fullscreen', () => {
    it('DW-5.2 destroy disposes the host once and ends the telemetry session', async () => {
      const { fixture, host, telemetry } = setup();
      await running(fixture);
      fixture.destroy();
      expect(host.dispose).toHaveBeenCalledTimes(1);
      expect(telemetry.endSession).toHaveBeenCalled();
    });

    it('DW-5.2 fullscreen requests the host container (frame + HUD) and exits when already fullscreen', async () => {
      const { fixture, viewer } = setup();
      await running(fixture);
      const container = el(fixture).querySelector('.viewer-container') as HTMLElement;
      const request = vi.fn(async () => undefined);
      container.requestFullscreen = request;
      await viewer.toggleFullscreen();
      expect(request).toHaveBeenCalledTimes(1);

      const exit = vi.fn(async () => undefined);
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => container });
      document.exitFullscreen = exit;
      await viewer.toggleFullscreen();
      expect(exit).toHaveBeenCalledTimes(1);
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(viewer.isFullscreen()).toBe(true);
      Reflect.deleteProperty(document, 'fullscreenElement');
    });

    it('a rejected fullscreen request is a warning, not a failure', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { fixture, viewer } = setup();
      await running(fixture);
      (el(fixture).querySelector('.viewer-container') as HTMLElement).requestFullscreen = vi.fn(async () => { throw new Error('denied'); });
      await viewer.toggleFullscreen();
      expect(warn).toHaveBeenCalled();
      expect(viewer.state()).toBe('running');
    });

    it('pagehide ends the telemetry session', async () => {
      const { fixture, telemetry } = setup();
      await running(fixture);
      window.dispatchEvent(new Event('pagehide'));
      expect(telemetry.endSession).toHaveBeenCalled();
    });
  });
});

// Test-plan scenario 196 (DW-3.5): a draft preview - `?draft=<sha256>` plays that version and its exit
// goes back to the admin through a validated `returnTo`.
describe('ViewerComponent draft preview (?draft=)', () => {
  const HASH = 'ab'.repeat(32);

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  function preview(query: Record<string, string>) {
    const made = setup({ query });
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    return { ...made, navigateByUrl };
  }

  it('DW-3.5 asks the service for exactly that version and runs it', async () => {
    const { fixture, service } = preview({ draft: HASH });
    await running(fixture);
    expect(service.fetchScenarioById).toHaveBeenCalledWith('solar-system', HASH);
  });

  it('a normal run asks for no version', async () => {
    const { fixture, service } = preview({});
    await running(fixture);
    expect(service.fetchScenarioById).toHaveBeenCalledWith('solar-system', undefined);
  });

  it('an uppercase hash is lowercased before it is sent', async () => {
    const { fixture, service } = preview({ draft: HASH.toUpperCase() });
    await running(fixture);
    expect(service.fetchScenarioById).toHaveBeenCalledWith('solar-system', HASH);
  });

  it('a malformed ?draft= is an error screen: nothing is fetched and no frame starts', async () => {
    for (const draft of ['abc', HASH.slice(1), `${HASH}0`, `${HASH.slice(1)}g`, '']) {
      const { fixture, viewer, service, host } = preview({ draft });
      await until(fixture, () => viewer.state() === 'error');
      expect(viewer.errorMessage()).toBe('Посилання на чернетку некоректне.');
      expect(service.fetchScenarioById).not.toHaveBeenCalled();
      expect(host.load).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
      vi.restoreAllMocks();
    }
  });

  it('a preview never streams, even with ?stream=1: it is that one ZIP', async () => {
    const { fixture, service, host } = preview({ draft: HASH, stream: '1' });
    await running(fixture);
    expect(service.downloadScenarioZip).toHaveBeenCalled();
    expect(host.load.mock.calls[0][0].kind).toBe('blob');
  });

  it('DW-3.5 exit goes to a relative /admin returnTo', async () => {
    const returnTo = '/admin/scenarios/solar-system?tab=file#top';
    const { fixture, viewer, navigate, navigateByUrl } = preview({ draft: HASH, returnTo });
    await running(fixture);
    viewer.exit();
    expect(navigateByUrl).toHaveBeenCalledWith(returnTo);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('DW-3.5 a returnTo off the site or outside /admin is ignored: exit goes to the scenario page', async () => {
    for (const returnTo of ['https://evil.example', '//evil.example', '/\evil.example', '/catalog', 'admin/x',
      'javascript:alert(1)', '/admin/../catalog', '/administrator']) {
      const { fixture, viewer, navigate, navigateByUrl } = preview({ draft: HASH, returnTo });
      await running(fixture);
      viewer.exit();
      expect(navigateByUrl, returnTo).not.toHaveBeenCalled();
      expect(navigate, returnTo).toHaveBeenCalledWith(['/scenario', 'solar-system']);
      TestBed.resetTestingModule();
      vi.restoreAllMocks();
    }
  });

  it('returnTo without ?draft= is ignored: only a preview exits to the admin', async () => {
    const { fixture, viewer, navigate, navigateByUrl } = preview({ returnTo: '/admin/scenarios' });
    await running(fixture);
    viewer.exit();
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/scenario', 'solar-system']);
  });

  it('the error screen way out is the returnTo too (the lookup 404s for anonymous or foreign drafts)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, viewer } = setup({
      query: { draft: HASH, returnTo: '/admin/x' },
      arrange: d => d.service.fetchScenarioById.mockRejectedValue(new Error('404')),
    });
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    await until(fixture, () => viewer.state() === 'error');
    viewer.goBack();
    expect(navigateByUrl).toHaveBeenCalledWith('/admin/x');
  });
});
