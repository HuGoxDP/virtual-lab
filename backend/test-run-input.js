// backend/test-run-input.js
//
// Validation of a moderator's test-run report for one version. The numbers come from a browser
// the moderator drove, so they are external input like any other: range-checked and the strings
// capped before anything is stored or later rendered.
//
// Two shapes are accepted:
//   result  { timeToFirstFrameMs, avgFps, gpuMemoryBytes, consoleErrors, engineBuild, userAgent }
//   failure { error, engineBuild?, userAgent? }   - the run itself failed, so there are no numbers
// Mixing them is refused: a failure that also carries numbers would be read as a measurement.

const GIB = 1024 ** 3;

/** `[min, max]` inclusive, per numeric field. */
const NUMERIC_RANGES = {
  timeToFirstFrameMs: [0, 600_000],
  avgFps: [0, 1000],
  gpuMemoryBytes: [0, 64 * GIB],
  consoleErrors: [0, 100_000],
};

const MAX_ENGINE_BUILD = 100;
const MAX_USER_AGENT = 300;
const MAX_RUN_ERROR = 1000;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A message when `value` is not a text of at most `max` characters, else null. */
const textProblem = (name, value, max) =>
  typeof value !== 'string' || value.length > max ? `${name}: рядок не довший за ${max} символів` : null;

/**
 * Checks a test-run body and returns `{ value }` (only the known fields) or `{ error }`
 * (a Ukrainian message for the client).
 */
function validateTestRun(body) {
  if (!isPlainObject(body)) return { error: 'Очікується JSON-об\'єкт' };

  const value = {};
  const numericGiven = Object.keys(NUMERIC_RANGES).filter(name => body[name] !== undefined);

  if (body.error !== undefined) {
    if (numericGiven.length > 0) return { error: `Результат із помилкою не може містити числа: ${numericGiven.join(', ')}` };
    const problem = textProblem('error', body.error, MAX_RUN_ERROR);
    if (problem) return { error: problem };
    value.error = body.error;
    for (const [name, max] of [['engineBuild', MAX_ENGINE_BUILD], ['userAgent', MAX_USER_AGENT]]) {
      if (body[name] === undefined) continue;
      const bad = textProblem(name, body[name], max);
      if (bad) return { error: bad };
      value[name] = body[name];
    }
    return { value };
  }

  for (const [name, [min, max]] of Object.entries(NUMERIC_RANGES)) {
    const number = body[name];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
      return { error: `${name}: число від ${min} до ${max}` };
    }
    value[name] = number;
  }
  if (!Number.isInteger(value.consoleErrors)) return { error: 'consoleErrors: ціле число' };

  for (const [name, max] of [['engineBuild', MAX_ENGINE_BUILD], ['userAgent', MAX_USER_AGENT]]) {
    const problem = textProblem(name, body[name], max);
    if (problem) return { error: problem };
    value[name] = body[name];
  }
  return { value };
}

module.exports = { validateTestRun, NUMERIC_RANGES, MAX_ENGINE_BUILD, MAX_USER_AGENT, MAX_RUN_ERROR };
