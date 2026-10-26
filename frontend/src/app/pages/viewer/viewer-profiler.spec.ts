// path: src/app/pages/viewer/viewer-profiler.spec.ts
//
// Release 1, phase 5 - DW-5.3 (unit part). Runs against the real engine MemoryProfiler: the point is
// that its gate and overlay really end up closed, not that a mock was called.

import { MemoryProfiler } from 'WebEngineTS';

import { enforceProfilerOff, lockProfiler } from './viewer-profiler';

/** jsdom has no canvas: the overlay's graphs only need a 2D context that accepts every call. */
function fakeContext2d(): CanvasRenderingContext2D {
  const noop = () => ({ width: 0 });
  return new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : noop),
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as CanvasRenderingContext2D;
}

function reset(): void {
  MemoryProfiler.diagnosticsAllowed = true;
  MemoryProfiler.disableToggle();
  MemoryProfiler.hideOverlay();
}

describe('viewer-profiler', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(fakeContext2d as never);
    reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    reset();
    MemoryProfiler.diagnosticsAllowed = true;
  });

  it('DW-5.3 lockProfiler closes the engine gate', () => {
    expect(MemoryProfiler.diagnosticsAllowed).toBe(true);
    lockProfiler();
    expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
  });

  it('DW-5.3 with the gate locked, a scenario\'s showOverlay / toggleOverlay / enableToggle are inert', () => {
    lockProfiler();
    MemoryProfiler.showOverlay();
    MemoryProfiler.toggleOverlay();
    MemoryProfiler.enableToggle();
    expect(MemoryProfiler.isOverlayVisible).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', key: '`' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', key: '`' }));
    expect(MemoryProfiler.isOverlayVisible).toBe(false);
  });

  it('DW-5.3 enforceProfilerOff closes an overlay that is already open and re-locks the gate', () => {
    MemoryProfiler.showOverlay();
    expect(MemoryProfiler.isOverlayVisible).toBe(true);

    expect(enforceProfilerOff()).toBe(true);
    expect(MemoryProfiler.isOverlayVisible).toBe(false);
    expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
  });

  it('DW-5.3 enforceProfilerOff catches a scenario that re-opened the gate after load, then its overlay', () => {
    lockProfiler();
    MemoryProfiler.diagnosticsAllowed = true; // scenario code re-opening the (two-way) setter
    MemoryProfiler.showOverlay();

    expect(enforceProfilerOff()).toBe(true);
    expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
    expect(MemoryProfiler.isOverlayVisible).toBe(false);
  });

  it('enforceProfilerOff reports nothing to undo when the profiler is already off', () => {
    lockProfiler();
    expect(enforceProfilerOff()).toBe(false);
    expect(MemoryProfiler.diagnosticsAllowed).toBe(false);
  });

  it('enforceProfilerOff is idempotent', () => {
    MemoryProfiler.showOverlay();
    enforceProfilerOff();
    expect(enforceProfilerOff()).toBe(false);
  });
});
