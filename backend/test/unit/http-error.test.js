// backend/test/unit/http-error.test.js
//
// Test-plan scenario 207: `describeError`, the shared reading of a caught error that
// `sendError` and the bulk route's per-id results both use.

const test = require('node:test');
const assert = require('node:assert/strict');

const { httpError, describeError, sendError } = require('../../http-error');

test('207. describeError: a 4xx error is itself; anything else is a generic 500 with the detail logged, not shown', () => {
  assert.deepEqual(describeError(httpError(409, 'Зайнято'), 't'), { status: 409, message: 'Зайнято' });
  assert.deepEqual(describeError(Object.assign(new Error('bad zip'), { status: 400 }), 't'), { status: 400, message: 'bad zip' });

  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.deepEqual(describeError(new Error('relation does not exist'), 'tag'), { status: 500, message: 'Помилка сервера' });
    assert.deepEqual(describeError(httpError(503, 'x'), 'tag'), { status: 500, message: 'Помилка сервера' }, '5xx statuses are not passed through');
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2);
  assert.match(logged[0], /tag error: relation does not exist/);
});

test('207. sendError writes what describeError says', () => {
  const sent = {};
  const res = { status(code) { sent.status = code; return this; }, json(body) { sent.body = body; } };
  sendError(res, httpError(404, 'Немає'), 't');
  assert.deepEqual(sent, { status: 404, body: { error: 'Немає' } });
});
