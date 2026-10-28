// path: src/app/player/test-run-report.ts
//
// The trust boundary for a moderator's test run. The numbers come from the player frame, which runs
// untrusted scenario code: they are advisory, and nothing from there is posted as it arrived. Figures
// are checked and clamped into the ranges the server accepts (`backend/test-run-input.js`), text is
// truncated to the server's caps, and a report that cannot be made honest becomes a failure.

import type { PlayerMetrics } from 'WebEngineTS/player-host';

import { TestRun } from '../models/admin.model';

const GIB = 1024 ** 3;

/** Server caps and ranges, mirrored: the server stays the authority and answers 400 beyond them. */
export const REPORT_LIMITS = {
  engineBuild: 100,
  userAgent: 300,
  error: 1000,
  timeToFirstFrameMs: 600_000,
  avgFps: 1000,
  gpuMemoryBytes: 64 * GIB,
  consoleErrors: 100_000,
} as const;

/** How long the scenario is measured once it runs. */
export const MEASURE_SECONDS = 10;

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value : '').slice(0, max);
const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

/** What went wrong, in the failure shape: no numbers, a bounded message. */
export function buildFailedRunReport(message: string, userAgent: string, engineBuild?: string): TestRun {
  const report: TestRun = { error: text(message, REPORT_LIMITS.error) || 'Невідома помилка', userAgent: text(userAgent, REPORT_LIMITS.userAgent) };
  const build = text(engineBuild, REPORT_LIMITS.engineBuild);
  if (build) report.engineBuild = build;
  return report;
}

/**
 * A measurement as the report to save. A figure that is not a finite number cannot be trusted at all,
 * so the whole run is reported as a failure; finite ones are clamped (negatives to 0, beyond the server's
 * range to its maximum) and the error count is made a whole number.
 */
export function buildTestRunReport(metrics: PlayerMetrics, userAgent: string): TestRun {
  const figures = [metrics?.timeToFirstFrameMs, metrics?.avgFps, metrics?.gpuMemoryBytes, metrics?.consoleErrors];
  if (!figures.every(value => typeof value === 'number' && Number.isFinite(value))) {
    return buildFailedRunReport('Сценарій повернув некоректні показники.', userAgent, metrics?.engineBuild);
  }
  return {
    timeToFirstFrameMs: clamp(metrics.timeToFirstFrameMs, REPORT_LIMITS.timeToFirstFrameMs),
    avgFps: clamp(metrics.avgFps, REPORT_LIMITS.avgFps),
    gpuMemoryBytes: clamp(metrics.gpuMemoryBytes, REPORT_LIMITS.gpuMemoryBytes),
    consoleErrors: Math.round(clamp(metrics.consoleErrors, REPORT_LIMITS.consoleErrors)),
    engineBuild: text(metrics.engineBuild, REPORT_LIMITS.engineBuild),
    userAgent: text(userAgent, REPORT_LIMITS.userAgent),
  };
}
