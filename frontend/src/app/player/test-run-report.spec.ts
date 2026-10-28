// path: src/app/player/test-run-report.spec.ts
//
// Test-plan scenario 228 (DW-7.5): what the host posts after a test run. The numbers come from an untrusted
// realm, so the report is bounded and sanitised here, before the server's own checks.

import type { PlayerMetrics } from 'WebEngineTS/player-host';

import { REPORT_LIMITS, buildFailedRunReport, buildTestRunReport } from './test-run-report';

const metrics = (overrides: Partial<PlayerMetrics> = {}): PlayerMetrics => ({
  timeToFirstFrameMs: 1800, avgFps: 58.4, gpuMemoryBytes: 300_000_000, consoleErrors: 0, engineBuild: 'build-1', ...overrides,
});

describe('buildTestRunReport', () => {
  it('DW-7.5 carries the four figures, the engine build and the device', () => {
    expect(buildTestRunReport(metrics(), 'UA/1')).toEqual({
      timeToFirstFrameMs: 1800, avgFps: 58.4, gpuMemoryBytes: 300_000_000, consoleErrors: 0, engineBuild: 'build-1', userAgent: 'UA/1',
    });
  });

  it('DW-7.5 truncates a 500-character engine build to 100 and a long user agent to 300', () => {
    const report = buildTestRunReport(metrics({ engineBuild: 'e'.repeat(500) }), 'u'.repeat(900));
    expect(report.engineBuild).toHaveLength(100);
    expect(report.userAgent).toHaveLength(300);
  });

  it('clamps figures into the server ranges and makes the error count a whole number', () => {
    const report = buildTestRunReport(metrics({ timeToFirstFrameMs: -5, avgFps: 5000, gpuMemoryBytes: 1e15, consoleErrors: 2.6 }), 'UA');
    expect(report).toMatchObject({ timeToFirstFrameMs: 0, avgFps: REPORT_LIMITS.avgFps, gpuMemoryBytes: REPORT_LIMITS.gpuMemoryBytes, consoleErrors: 3 });
  });

  it.each([NaN, Infinity, '12' as unknown as number, undefined as unknown as number])(
    'a non-finite figure (%s) makes the whole run a failure, with no numbers', bad => {
      const report = buildTestRunReport(metrics({ avgFps: bad }), 'UA');
      expect(report.error).toBeTruthy();
      expect(report.avgFps).toBeUndefined();
      expect(report.timeToFirstFrameMs).toBeUndefined();
      expect(report.engineBuild).toBe('build-1');
    });

  it('a metrics value that is not an object at all is a failure rather than a throw', () => {
    expect(buildTestRunReport(null as unknown as PlayerMetrics, 'UA').error).toBeTruthy();
  });

  it('a non-string engine build is stored as empty text', () => {
    expect(buildTestRunReport(metrics({ engineBuild: 7 as unknown as string }), 'UA').engineBuild).toBe('');
  });
});

describe('buildFailedRunReport', () => {
  it('DW-7.5 stores the error instead of numbers, bounded to 1000 characters', () => {
    const report = buildFailedRunReport('x'.repeat(5000), 'UA', 'b');
    expect(report.error).toHaveLength(REPORT_LIMITS.error);
    expect(report).toEqual({ error: 'x'.repeat(1000), userAgent: 'UA', engineBuild: 'b' });
  });

  it('omits an unknown engine build and falls back to a message when the error is empty', () => {
    expect(buildFailedRunReport('', 'UA')).toEqual({ error: 'Невідома помилка', userAgent: 'UA' });
  });

  it('truncates the device and build text like a result does', () => {
    const report = buildFailedRunReport('boom', 'u'.repeat(400), 'e'.repeat(400));
    expect(report.userAgent).toHaveLength(300);
    expect(report.engineBuild).toHaveLength(100);
  });
});
