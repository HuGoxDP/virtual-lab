// path: src/app/pages/viewer/viewer-profiler.ts

import { MemoryProfiler } from 'WebEngineTS';

/** How often a running scenario is checked for having re-opened the profiler. */
export const PROFILER_GUARD_INTERVAL_MS = 1000;

/**
 * Keeps the engine's `MemoryProfiler` overlay off the platform.
 *
 * The profiler is engine API and a measurement tool, not a student control, and it is being developed
 * separately. A scenario is arbitrary engine code (`solar-system` calls `enableToggle()` and
 * `showOverlay()` itself), so the host decides: `?diag=1` never reaches this module.
 */

/**
 * Closes the engine's gate. Call before every scenario load: while it is shut, `showOverlay`,
 * `toggleOverlay` and `enableToggle` (the Backquote hotkey) do nothing, so a scenario's calls are
 * inert rather than merely undone afterwards.
 */
export function lockProfiler(): void {
  MemoryProfiler.diagnosticsAllowed = false;
}

/**
 * Undoes whatever a scenario did to the gate or the overlay. With today's engine the
 * `diagnosticsAllowed` setter is two-way, so a scenario can re-open it after load; the engine's
 * latching setter will make this a no-op. Returns whether anything had to be undone.
 */
export function enforceProfilerOff(): boolean {
  const tampered = MemoryProfiler.diagnosticsAllowed || MemoryProfiler.isOverlayVisible;
  if (tampered) {
    lockProfiler();
    MemoryProfiler.hideOverlay();
  }
  return tampered;
}
