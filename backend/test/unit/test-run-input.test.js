// backend/test/unit/test-run-input.test.js
//
// Test-plan scenarios 203 (DW-4.4) and 207: `validateTestRun` - the numeric result, the error
// result Phase 7 stores when a run fails, the range edges, and the dirty bodies.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateTestRun, NUMERIC_RANGES, MAX_ENGINE_BUILD, MAX_USER_AGENT, MAX_RUN_ERROR } = require('../../test-run-input');

const GOOD = {
  timeToFirstFrameMs: 1200, avgFps: 58.5, gpuMemoryBytes: 250_000_000, consoleErrors: 0,
  engineBuild: '0.1.0-local.1792706134341', userAgent: 'Mozilla/5.0 (X11) Chrome/130',
};

const refused = body => {
  const result = validateTestRun(body);
  assert.equal(typeof result.error, 'string', JSON.stringify(body));
  assert.equal(result.value, undefined);
  return result.error;
};

test('203. DW-4.4 a complete numeric result is accepted and cleaned of unknown keys', () => {
  assert.deepEqual(validateTestRun({ ...GOOD, extra: 'dropped', ranBy: 'forged' }), { value: GOOD });
});

test('203. DW-4.4 every numeric field accepts both ends of its range and refuses just beyond', () => {
  for (const [name, [min, max]] of Object.entries(NUMERIC_RANGES)) {
    assert.equal(validateTestRun({ ...GOOD, [name]: min }).value[name], min, `${name} min`);
    assert.equal(validateTestRun({ ...GOOD, [name]: max }).value[name], max, `${name} max`);
    assert.match(refused({ ...GOOD, [name]: min - 1 }), new RegExp(name), `${name} below`);
    assert.match(refused({ ...GOOD, [name]: max + 1 }), new RegExp(name), `${name} above`);
  }
});

test('203. DW-4.4 the stated limits are the plan limits', () => {
  assert.deepEqual(NUMERIC_RANGES, {
    timeToFirstFrameMs: [0, 600_000], avgFps: [0, 1000], gpuMemoryBytes: [0, 64 * 1024 ** 3], consoleErrors: [0, 100_000],
  });
  assert.deepEqual([MAX_ENGINE_BUILD, MAX_USER_AGENT], [100, 300]);
});

test('203. DW-4.4 dirty numbers: negative, NaN-like, Infinity, 10^12 ms, strings, null, a fraction of an error count', () => {
  for (const bad of [-1, 1e12, Infinity, -Infinity, '1200', null, true, [], {}]) {
    refused({ ...GOOD, timeToFirstFrameMs: bad });
  }
  refused({ ...GOOD, avgFps: 'NaN' });
  refused({ ...GOOD, avgFps: NaN });
  refused({ ...GOOD, consoleErrors: 1.5 });
});

test('203. DW-4.4 strings: 100 / 300 characters pass, 101 / 301 do not; non-strings and missing fields do not', () => {
  assert.ok(validateTestRun({ ...GOOD, engineBuild: 'b'.repeat(100) }).value);
  assert.ok(validateTestRun({ ...GOOD, userAgent: 'u'.repeat(300) }).value);
  assert.ok(validateTestRun({ ...GOOD, userAgent: '' }).value, 'an empty user agent is still a string');
  refused({ ...GOOD, engineBuild: 'b'.repeat(101) });
  refused({ ...GOOD, userAgent: 'u'.repeat(301) });
  refused({ ...GOOD, engineBuild: 5 });
  for (const name of Object.keys(GOOD)) {
    const { [name]: _omitted, ...rest } = GOOD;
    refused(rest);
  }
});

test('203. DW-4.4 a body that is not an object is refused', () => {
  for (const bad of [undefined, null, 'x', 5, [], [GOOD]]) refused(bad);
});

test('203. DW-4.4 an error result: text alone, with optional build and agent; numbers beside it are refused', () => {
  assert.deepEqual(validateTestRun({ error: 'WebGL context lost' }), { value: { error: 'WebGL context lost' } });
  assert.deepEqual(
    validateTestRun({ error: 'timeout', engineBuild: 'b', userAgent: 'u', unknown: 1 }),
    { value: { error: 'timeout', engineBuild: 'b', userAgent: 'u' } },
  );
  assert.ok(validateTestRun({ error: 'e'.repeat(MAX_RUN_ERROR) }).value);
  refused({ error: 'e'.repeat(MAX_RUN_ERROR + 1) });
  refused({ error: 5 });
  refused({ error: ['x'] });
  assert.match(refused({ error: 'x', avgFps: 60 }), /avgFps/);
  refused({ error: 'x', engineBuild: 'b'.repeat(101) });
  refused({ error: 'x', userAgent: 5 });
});
