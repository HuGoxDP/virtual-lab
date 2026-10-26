// path: src/app/pages/viewer/viewer-lifecycle.spec.ts
//
// Release 1, phase 4 fix-forward - test-plan scenarios 149-153: the viewer's load pipeline, restart,
// exit and byte-signal reset, driven with the engine and the services replaced by doubles (jsdom has no
// WebGL2). Seams: `ViewerComponent.supportsWebGL2` is stubbed to true and the protected
// `createApplication` returns a fake `Application`. DW-4.1, DW-4.2, DW-4.4.
//
// Release 1, phase 5 fix-forward - test-plan scenarios 154-157: the profiler gate before each load path
// (ZIP, streamed, restart; with and without ?diag=1), the post-load enforce, the 1000 ms guard, the guard
// armed at load start, and its clear on destroy. DW-5.3.

import { TestBed, ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { MemoryProfiler } from 'WebEngineTS';

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

type Progress = (p: { progress: number }) => void;
type DownloadProgress = (p: { loaded: number; total: number; percent: number }) => void;

function makeApp() {
  return {
    loadScenarioFromBuffer: vi.fn(async (_b: ArrayBuffer, onProgress?: Progress) => { onProgress?.({ progress: 0.5 }); }),
    loadScenarioFromManifest: vi.fn(async (_u: string, onProgress?: Progress) => { onProgress?.({ progress: 0.5 }); }),
    stop: vi.fn(),
    dispose: vi.fn(),
  };
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
  app: ReturnType<typeof makeApp>;
  service: ReturnType<typeof makeService>;
  telemetry: ReturnType<typeof makeTelemetry>;
}

function setup(opts: {
  query?: Record<string, string>;
  id?: string | null;
  item?: Partial<typeof ITEM>;
  /** Runs before the first change detection, i.e. before the load starts. */
  arrange?: (d: Doubles) => void;
} = {}) {
  const app = makeApp();
  const service = makeService(opts.item);
  const telemetry = makeTelemetry();
  opts.arrange?.({ app, service, telemetry });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(ViewerComponent as any, 'supportsWebGL2').mockReturnValue(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(ViewerComponent.prototype as any, 'createApplication').mockReturnValue(app);

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
  return { fixture, viewer: fixture.componentInstance, app, service, telemetry, navigate };
}

async function until(fixture: ComponentFixture<ViewerComponent>, check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true));
  fixture.detectChanges();
}
const running = (f: ComponentFixture<ViewerComponent>) => until(f, () => f.componentInstance.state() === 'running');
const el = (f: ComponentFixture<ViewerComponent>) => f.nativeElement as HTMLElement;

describe('ViewerComponent load pipeline (scenarios 149-153)', () => {
  beforeEach(() => { MemoryProfiler.diagnosticsAllowed = true; });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    MemoryProfiler.diagnosticsAllowed = true;
  });

  describe('149 exit()', () => {
    it('DW-4.2 goes to /scenario/:id when the URL carried an id', async () => {
      const { fixture, viewer, navigate } = setup();
      await running(fixture);
      viewer.exit();
      expect(navigate).toHaveBeenCalledWith(['/scenario', 'solar-system']);
    });

    it('DW-4.2 goes to /catalog without a route id', async () => {
      const { fixture, viewer, navigate } = setup({ id: null });
      await until(fixture, () => viewer.state() === 'error');
      expect(viewer.errorMessage()).toBe('Сценарій не вказано.');
      viewer.exit();
      expect(navigate).toHaveBeenCalledWith(['/catalog']);
    });

    it('DW-4.2 still targets /scenario/:id when the lookup failed', async () => {
      const { fixture, viewer, navigate } = setup({ arrange: d => d.service.fetchScenarioById.mockRejectedValue(new Error('404')) });
      await until(fixture, () => viewer.state() === 'error');
      viewer.exit();
      expect(navigate).toHaveBeenCalledWith(['/scenario', 'solar-system']);
    });

    it('DW-4.1 the loader "Скасувати" exits, and destroying the view aborts the archive download', async () => {
      let signal: AbortSignal | undefined;
      const pending = deferred<ArrayBuffer>();
      const { fixture, viewer, navigate } = setup({
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
      await Promise.resolve();
      await Promise.resolve();
      expect(viewer.state()).not.toBe('error'); // an abort is not a failure to show
    });
  });

  describe('150 ZIP run and canRestart', () => {
    it('DW-4.4 a ZIP run reaches running with canRestart true and an enabled restart button', async () => {
      const { fixture, viewer, app, service, telemetry } = setup();
      await running(fixture);
      expect(service.downloadScenarioZip).toHaveBeenCalledTimes(1);
      expect(app.loadScenarioFromBuffer).toHaveBeenCalledTimes(1);
      expect(app.loadScenarioFromManifest).not.toHaveBeenCalled();
      expect(telemetry.startSession).toHaveBeenCalledWith('solar-system');
      expect(viewer.canRestart()).toBe(true);
      expect(el(fixture).querySelector<HTMLButtonElement>('vl-viewer-hud .restart')!.disabled).toBe(false);
    });

    it('DW-4.4 a streamed run (?stream=1) has no buffer: canRestart false, restart button disabled', async () => {
      const { fixture, viewer, app, service, telemetry } = setup({ query: { stream: '1' } });
      await running(fixture);
      expect(app.loadScenarioFromManifest).toHaveBeenCalledWith('/a/solar-system.json', expect.any(Function));
      expect(service.downloadScenarioZip).not.toHaveBeenCalled();
      expect(telemetry.startSession).toHaveBeenCalledWith('solar-system');
      expect(viewer.canRestart()).toBe(false);
      expect(el(fixture).querySelector<HTMLButtonElement>('vl-viewer-hud .restart')!.disabled).toBe(true);
    });

    it('DW-4.4 restart() on a streamed run does nothing', async () => {
      const { fixture, viewer, app, service } = setup({ query: { stream: '1' } });
      await running(fixture);
      await viewer.restart();
      expect(app.loadScenarioFromManifest).toHaveBeenCalledTimes(1);
      expect(app.loadScenarioFromBuffer).not.toHaveBeenCalled();
      expect(service.downloadScenarioZip).not.toHaveBeenCalled();
      expect(viewer.state()).toBe('running');
    });

    it('?stream=1 on a scenario without a manifestUrl falls back to the ZIP', async () => {
      const { fixture, viewer, app, service } = setup({ query: { stream: '1' }, item: { manifestUrl: null as never } });
      await running(fixture);
      expect(service.downloadScenarioZip).toHaveBeenCalledTimes(1);
      expect(app.loadScenarioFromManifest).not.toHaveBeenCalled();
      expect(viewer.canRestart()).toBe(true);
    });

    it('canRestart is false after the context is lost, and the engine is stopped', async () => {
      const { fixture, viewer, app } = setup();
      await running(fixture);
      el(fixture).querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      expect(app.stop).toHaveBeenCalled();
      expect(viewer.contextLost()).toBe(true);
      expect(viewer.canRestart()).toBe(false);
    });

    it('canRestart is false while a restart is loading, true again once it is running', async () => {
      const { fixture, viewer, app } = setup();
      await running(fixture);
      const hold = deferred<void>();
      app.loadScenarioFromBuffer.mockImplementationOnce(() => hold.promise);
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
    it('DW-4.4 re-runs the same buffer with no second download and a second telemetry launch', async () => {
      const { fixture, viewer, app, service, telemetry } = setup();
      await running(fixture);
      const first = app.loadScenarioFromBuffer.mock.calls[0][0];
      await viewer.restart();
      expect(app.loadScenarioFromBuffer).toHaveBeenCalledTimes(2);
      expect(app.loadScenarioFromBuffer.mock.calls[1][0]).toBe(first);
      expect(service.downloadScenarioZip).toHaveBeenCalledTimes(1);
      expect(telemetry.startSession).toHaveBeenCalledTimes(2);
      expect(viewer.state()).toBe('running');
    });

    it('shows the error screen with the engine message when the re-run fails', async () => {
      const { fixture, viewer, app } = setup();
      await running(fixture);
      app.loadScenarioFromBuffer.mockRejectedValueOnce(new Error('boom'));
      await viewer.restart();
      expect(viewer.state()).toBe('error');
      expect(viewer.errorMessage()).toBe('boom');
    });

    it('uses the Ukrainian fallback message when the re-run rejects with a non-Error', async () => {
      const { fixture, viewer, app } = setup();
      await running(fixture);
      app.loadScenarioFromBuffer.mockRejectedValueOnce('nope');
      await viewer.restart();
      expect(viewer.errorMessage()).toBe('Не вдалося перезапустити сценарій');
    });

    it('is a no-op before any archive has loaded', async () => {
      const hold = deferred<ArrayBuffer>();
      const { fixture, viewer, app } = setup({ arrange: d => d.service.downloadScenarioZip.mockReturnValue(hold.promise) });
      await until(fixture, () => viewer.state() === 'downloading');
      await viewer.restart();
      expect(app.loadScenarioFromBuffer).not.toHaveBeenCalled();
      hold.resolve(zip());
      await running(fixture);
    });
  });

  describe('152 setState byte-signal reset', () => {
    it('DW-4.1 engine stage shows "N з N" while loading, then every byte signal resets on running', async () => {
      const hold = deferred<void>();
      const { fixture, viewer, service } = setup({ arrange: d => d.app.loadScenarioFromBuffer.mockImplementationOnce(() => hold.promise) });
      await until(fixture, () => viewer.state() === 'loading-engine');

      expect(viewer.stage()).toBe(STAGE_ENGINE);
      expect(viewer.loadedBytes()).toBe(2_000_000);
      expect(viewer.totalBytes()).toBe(2_000_000);
      expect(el(fixture).querySelector('.loader-bytes')!.textContent).toMatch(/МБ/);
      expect(el(fixture).querySelector('.loader-stage')!.textContent).toBe(STAGE_ENGINE);
      expect(service.downloadScenarioZip).toHaveBeenCalledTimes(1);

      hold.resolve();
      await running(fixture);
      expect(viewer.stage()).toBe('');
      expect(viewer.loadedBytes()).toBeNull();
      expect(viewer.totalBytes()).toBeNull();
      expect(viewer.progressPercent()).toBe(100);
      expect(el(fixture).querySelector('vl-viewer-loading')).toBeNull();
    });

    it('DW-4.1 the download phase shows the fetch stage, the byte progress and the ring percent', async () => {
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
      expect(viewer.totalBytes()).toBe(2_000_000);
      expect(viewer.progressPercent()).toBe(50);
      expect(el(fixture).querySelector('.loader-percent')!.textContent).toContain('50%');
      hold.resolve(zip());
      await running(fixture);
    });

    it('an unknown total (percent -1) leaves the ring at 0 and the total at 0', async () => {
      const hold = deferred<ArrayBuffer>();
      const { fixture, viewer } = setup({
        arrange: d => d.service.downloadScenarioZip.mockImplementation(async (_s, onProgress) => {
          onProgress?.({ loaded: 300, total: 0, percent: -1 });
          return hold.promise;
        }),
      });
      await until(fixture, () => viewer.loadedBytes() === 300);
      expect(viewer.progressPercent()).toBe(0);
      expect(viewer.totalBytes()).toBe(0);
      hold.resolve(zip());
      await running(fixture);
    });

    it('the streamed path has no archive download: byte signals stay null and the engine stage shows', async () => {
      const hold = deferred<void>();
      const { fixture, viewer } = setup({
        query: { stream: '1' },
        arrange: d => d.app.loadScenarioFromManifest.mockImplementationOnce(() => hold.promise),
      });
      await until(fixture, () => viewer.state() === 'loading-engine');
      expect(viewer.stage()).toBe(STAGE_ENGINE);
      expect(viewer.loadedBytes()).toBeNull();
      expect(viewer.totalBytes()).toBeNull();
      expect(el(fixture).querySelector('.loader-bytes')).toBeNull();
      hold.resolve();
      await running(fixture);
      expect(viewer.stage()).toBe('');
    });

    it('the engine progress callback drives the ring percent', async () => {
      const hold = deferred<void>();
      const { fixture, viewer } = setup({
        arrange: d => d.app.loadScenarioFromBuffer.mockImplementationOnce(async (_b, onProgress) => {
          onProgress?.({ progress: 0.42 });
          return hold.promise;
        }),
      });
      await until(fixture, () => viewer.progressPercent() === 42);
      hold.resolve();
      await running(fixture);
    });
  });

  describe('153 failures and stale loads', () => {
    it('a lookup failure shows "Сценарій не знайдено." and never starts the engine', async () => {
      const { fixture, viewer, app } = setup({ arrange: d => d.service.fetchScenarioById.mockRejectedValue(new Error('404')) });
      await until(fixture, () => viewer.state() === 'error');
      expect(viewer.errorMessage()).toBe('Сценарій не знайдено.');
      expect(app.loadScenarioFromBuffer).not.toHaveBeenCalled();
    });

    it('a scenario without an archive shows the "no archive" message', async () => {
      const { fixture, viewer, service } = setup({ item: { scenarioUrl: '' } });
      await until(fixture, () => viewer.state() === 'error');
      expect(viewer.errorMessage()).toBe('Для цього сценарію ще не завантажено архів.');
      expect(service.downloadScenarioZip).not.toHaveBeenCalled();
    });

    it('a failed download shows its message and starts no telemetry', async () => {
      const { fixture, viewer, telemetry } = setup({
        arrange: d => d.service.downloadScenarioZip.mockRejectedValue(new Error('HTTP 500')),
      });
      await until(fixture, () => viewer.state() === 'error');
      expect(viewer.errorMessage()).toBe('HTTP 500');
      expect(telemetry.startSession).not.toHaveBeenCalled();
      expect(el(fixture).querySelector('.error-content h1')!.textContent).toBe('Помилка завантаження');
    });

    it('an engine failure on the ZIP path shows the error screen and no telemetry launch', async () => {
      const { fixture, viewer, telemetry } = setup({
        arrange: d => d.app.loadScenarioFromBuffer.mockRejectedValue(new Error('bad manifest')),
      });
      await until(fixture, () => viewer.state() === 'error');
      expect(viewer.errorMessage()).toBe('bad manifest');
      expect(telemetry.startSession).not.toHaveBeenCalled();
      expect(viewer.canRestart()).toBe(false);
    });

    it('a streamed failure shows the error screen', async () => {
      const { fixture, viewer, telemetry } = setup({
        query: { stream: '1' },
        arrange: d => d.app.loadScenarioFromManifest.mockRejectedValue(new Error('manifest 404')),
      });
      await until(fixture, () => viewer.state() === 'error');
      expect(viewer.errorMessage()).toBe('manifest 404');
      expect(telemetry.startSession).not.toHaveBeenCalled();
    });

    it('a restart superseded by a newer one cannot overwrite its result', async () => {
      const { fixture, viewer, app } = setup();
      await running(fixture);
      const slow = deferred<void>();
      app.loadScenarioFromBuffer.mockImplementationOnce(() => slow.promise);
      const first = viewer.restart();
      app.loadScenarioFromBuffer.mockRejectedValueOnce(new Error('late'));
      await viewer.restart(); // the newer restart fails -> error
      expect(viewer.state()).toBe('error');
      slow.resolve(); // the stale one finishes afterwards and must not flip it back to running
      await first;
      expect(viewer.state()).toBe('error');
    });
  });

  describe('154-157 profiler lock and guard', () => {
    // Only the guard's interval is faked: `vi.waitFor` and the promise chain keep real time.
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
    afterEach(() => {
      TestBed.resetTestingModule(); // destroys the fixture while the fake clock is still installed
      vi.useRealTimers();
    });

    // `vi.waitFor` advances fake timers while it polls, which would tick the guard under the test's feet.
    const settle = async (f: ComponentFixture<ViewerComponent>, check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise<void>(r => setTimeout(r));
      expect(check()).toBe(true);
      f.detectChanges();
    };
    const running = (f: ComponentFixture<ViewerComponent>) => settle(f, () => f.componentInstance.state() === 'running');
    const until = settle;

    /** Spy on the guard's own interval (the 1000 ms one); other faked timers are not ours to count. */
    const guardIntervals = () => vi.spyOn(globalThis, 'setInterval');
    const guardCalls = (spy: ReturnType<typeof guardIntervals>) => spy.mock.calls.filter(c => c[1] === 1000);

    /** Records the gate at the moment the engine is asked to load. */
    const gateAtLoad = (seen: boolean[]) => async () => { seen.push(MemoryProfiler.diagnosticsAllowed); };

    describe('154 the gate is shut before every load path, with and without ?diag=1', () => {
      for (const query of [{}, { diag: '1' }] as Record<string, string>[]) {
        const label = 'diag' in query ? 'with ?diag=1' : 'without ?diag=1';

        it(`DW-5.3 ZIP load ${label}`, async () => {
          const seen: boolean[] = [];
          const { fixture } = setup({ query, arrange: d => d.app.loadScenarioFromBuffer.mockImplementation(gateAtLoad(seen)) });
          await running(fixture);
          expect(seen).toEqual([false]);
        });

        it(`DW-5.3 streamed load ${label}`, async () => {
          const seen: boolean[] = [];
          const { fixture } = setup({
            query: { ...query, stream: '1' },
            arrange: d => d.app.loadScenarioFromManifest.mockImplementation(gateAtLoad(seen)),
          });
          await running(fixture);
          expect(seen).toEqual([false]);
        });

        it(`DW-5.3 restart ${label}`, async () => {
          const seen: boolean[] = [];
          const { fixture, viewer, app } = setup({ query });
          await running(fixture);
          MemoryProfiler.diagnosticsAllowed = true; // a scenario re-opened it while running
          app.loadScenarioFromBuffer.mockImplementationOnce(gateAtLoad(seen));
          await viewer.restart();
          expect(seen).toEqual([false]);
        });
      }

      it('DW-5.3 ?diag=1 still shows the build stamp while the gate stays shut', async () => {
        const { fixture, viewer } = setup({ query: { diag: '1' } });
        await running(fixture);
        expect(viewer.buildStampVisible()).toBe(true);
        expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
      });
    });

    describe('155 post-load enforcement', () => {
      it('DW-5.3 a scenario that re-opened the gate during load is closed the moment it is running, with a warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { fixture } = setup({
          arrange: d => d.app.loadScenarioFromBuffer.mockImplementation(async () => { MemoryProfiler.diagnosticsAllowed = true; }),
        });
        await running(fixture);
        expect(MemoryProfiler.diagnosticsAllowed).toBe(false); // no timer has ticked
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('opened the profiler'));
      });

      it('DW-5.3 a streamed scenario that re-opened the gate during load is closed the moment it is running', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { fixture } = setup({
          query: { stream: '1' },
          arrange: d => d.app.loadScenarioFromManifest.mockImplementation(async () => { MemoryProfiler.diagnosticsAllowed = true; }),
        });
        await running(fixture);
        expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
      });

      it('a well-behaved scenario produces no warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { fixture } = setup();
        await running(fixture);
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('opened the profiler'));
      });
    });

    describe('156 the 1000 ms guard', () => {
      it('DW-5.3 re-closes a gate re-opened while running, on the next 1000 ms tick and not before', async () => {
        const { fixture } = setup();
        await running(fixture);
        MemoryProfiler.diagnosticsAllowed = true;
        vi.advanceTimersByTime(999);
        expect(MemoryProfiler.diagnosticsAllowed).toBe(true);
        vi.advanceTimersByTime(1);
        expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
      });

      it('DW-5.3 hides an overlay a running scenario opened', async () => {
        const { fixture } = setup();
        await running(fixture);
        // jsdom has no canvas 2D context for the real overlay, so its visibility is simulated.
        let visible = true;
        vi.spyOn(MemoryProfiler, 'isOverlayVisible', 'get').mockImplementation(() => visible);
        const hide = vi.spyOn(MemoryProfiler, 'hideOverlay').mockImplementation(() => { visible = false; });
        vi.advanceTimersByTime(999);
        expect(hide).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(hide).toHaveBeenCalled();
        expect(visible).toBe(false);
        expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
      });

      it('keeps guarding on every later tick', async () => {
        const { fixture } = setup();
        await running(fixture);
        for (let i = 0; i < 3; i++) {
          MemoryProfiler.diagnosticsAllowed = true;
          vi.advanceTimersByTime(1000);
          expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
        }
      });

      it('one interval serves the load and every restart', async () => {
        const spy = guardIntervals();
        const { fixture, viewer } = setup();
        await running(fixture);
        await viewer.restart();
        await viewer.restart();
        expect(guardCalls(spy)).toHaveLength(1);
      });

      it('DW-5.3 the guard runs from load start: a gate re-opened by a load that then fails is closed on the tick', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { fixture, viewer } = setup({
          arrange: d => d.app.loadScenarioFromBuffer.mockImplementation(async () => {
            MemoryProfiler.diagnosticsAllowed = true;
            throw new Error('entry point failed');
          }),
        });
        await until(fixture, () => viewer.state() === 'error');
        expect(MemoryProfiler.diagnosticsAllowed).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
      });

      it('DW-5.3 the same for a streamed load that fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { fixture, viewer } = setup({
          query: { stream: '1' },
          arrange: d => d.app.loadScenarioFromManifest.mockImplementation(async () => {
            MemoryProfiler.diagnosticsAllowed = true;
            throw new Error('entry point failed');
          }),
        });
        await until(fixture, () => viewer.state() === 'error');
        vi.advanceTimersByTime(1000);
        expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
      });

      it('no interval is started before a scenario load begins (lookup failure)', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const spy = guardIntervals();
        const { fixture, viewer } = setup({ arrange: d => d.service.fetchScenarioById.mockRejectedValue(new Error('404')) });
        await until(fixture, () => viewer.state() === 'error');
        expect(guardCalls(spy)).toHaveLength(0);
      });
    });

    describe('157 destroy clears the guard', () => {
      it('DW-5.3 no interval remains and a gate re-opened after destroy is not re-closed', async () => {
        const spy = guardIntervals();
        const clear = vi.spyOn(globalThis, 'clearInterval');
        const { fixture } = setup();
        await running(fixture);
        expect(guardCalls(spy)).toHaveLength(1);
        const id = spy.mock.results[spy.mock.calls.findIndex(c => c[1] === 1000)].value;
        expect(clear).not.toHaveBeenCalledWith(id);

        fixture.destroy();
        expect(clear).toHaveBeenCalledWith(id); // exactly the guard's interval is cleared
        expect(vi.getTimerCount()).toBe(0);

        MemoryProfiler.diagnosticsAllowed = true;
        vi.advanceTimersByTime(5000);
        expect(MemoryProfiler.diagnosticsAllowed).toBe(true);
      });

      it('destroy leaves the gate shut', async () => {
        const { fixture } = setup();
        await running(fixture);
        MemoryProfiler.diagnosticsAllowed = true;
        fixture.destroy();
        expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
      });

      it('a streamed load still in flight at destroy cannot re-arm the guard afterwards', async () => {
        const spy = guardIntervals();
        const hold = deferred<void>();
        const { fixture, viewer } = setup({
          query: { stream: '1' },
          arrange: d => d.app.loadScenarioFromManifest.mockImplementationOnce(() => hold.promise),
        });
        await until(fixture, () => viewer.state() === 'loading-engine');
        fixture.destroy();
        expect(vi.getTimerCount()).toBe(0);
        hold.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(vi.getTimerCount()).toBe(0);
        expect(guardCalls(spy)).toHaveLength(1); // armed at load start only, never again after destroy
      });
    });
  });
});
