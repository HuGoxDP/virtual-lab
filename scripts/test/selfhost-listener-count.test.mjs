// scripts/test/selfhost-listener-count.test.mjs
//
// HO1d review item 1: the old `controller.signal.listenerCount?.('abort') ?? 0`
// assertion in selfhost-interrupt.test.mjs is vacuous — Node's AbortSignal is
// not an EventEmitter, so `listenerCount` is undefined and 0 === 0 always.
// This file measures the real lifecycle with an EventEmitter-backed signal
// whose addEventListener/removeEventListener count calls and dispatch a manual
// abort(). It would fail if sleepInterruptible leaked a listener on either the
// natural-completion or the abort exit (debug: predict → log → run → resolve).
// `node --test`, fake probe/sleep — no Docker, no network, no real signals.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { waitHealthy } from '../selfhost-check.mjs';

/** A counting stand-in for AbortSignal: EventEmitter transport + the DOM API. */
function countingSignal() {
  const emitter = new EventEmitter();
  const signal = {
    aborted: false,
    addCount: 0,
    removeCount: 0,
    addEventListener(type, listener) {
      assert.equal(type, 'abort');
      this.addCount += 1;
      emitter.on(type, listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort');
      this.removeCount += 1;
      emitter.off(type, listener);
    },
    abort() {
      this.aborted = true;
      emitter.emit('abort');
    },
    liveCount: () => emitter.listenerCount('abort'),
  };
  return signal;
}

const healthy = { status: 200, body: { status: 'ok', db: 'connected', build: { version: '1' } } };

test('waitHealthy removes every abort listener across non-healthy → healthy attempts', async () => {
  const signal = countingSignal();
  let attempts = 0;
  const probe = async () => {
    attempts += 1;
    return attempts < 4 ? { status: 503 } : healthy;
  };
  const result = await waitHealthy(probe, {
    baseUrl: 'http://x', sleep: async () => {}, signal, log: () => {},
  });

  assert.equal(result.ok, true);
  assert.ok(signal.addCount >= 3, 'one listener per failing attempt must be registered');
  assert.equal(signal.addCount - signal.removeCount, 0, 'no listener may accumulate after completion');
});

test('waitHealthy removes the pending abort listener when aborted mid-sleep', async () => {
  const signal = countingSignal();
  let finishSleep;
  const sleep = () => new Promise(resolve => { finishSleep = resolve; });
  const pending = waitHealthy(async () => ({ status: 503 }), {
    baseUrl: 'http://x', sleep, signal, log: () => {},
  });

  // waitHealthy begins with an awaited probe: give that microtask a turn
  // before asserting the sleep listener is parked.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishSleep, 'function', 'the first attempt is parked in the injected sleep');
  assert.equal(signal.addCount, 1, 'one pending sleep listener');
  signal.abort();
  finishSleep();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'interrupted');
  // With `{ once: true }` an abort dispatch consumes the registration itself,
  // so the second removal is a harmless no-op. The invariant that matters is
  // the one the vacuous old assertion could not check: no live listener left
  // on the signal after the run.
  assert.ok(signal.addCount - signal.removeCount <= 0, 'the pending listener must be gone after abort');
  assert.equal(signal.liveCount(), 0, 'no live abort listener on the signal after the abort exit');
});
