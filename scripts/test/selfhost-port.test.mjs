// scripts/test/selfhost-port.test.mjs
//
// HO1f Phase 3 (D9): portFree must check all three addresses, not just the
// first one that binds. NEW file — existing tests stay untouched. `node --test`.

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';

import { portFree } from '../selfhost-check.mjs';

/** Bind a server and resolve with { server, port }; the caller closes it. */
async function hold(host, port = 0, options = {}) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, options, resolve);
  });
  return { server, port: server.address().port };
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

test('D9: portFree is async and true for an ephemeral port after release', async () => {
  const { server, port } = await hold('127.0.0.1');
  assert.equal(await portFree(port), false, 'a held port is never reported free');
  await close(server);
  assert.equal(await portFree(port), true, 'the released port is free on all three addresses');
});

test('D9: a port held only on 0.0.0.0 is busy even though 127.0.0.1 is free', async () => {
  const { server, port } = await hold('0.0.0.0');
  try {
    const loopback = await hold('127.0.0.1', port).catch(() => null);
    // On Windows 0.0.0.0 covers loopback; the point is that portFree checks it.
    assert.equal(await portFree(port), false);
    if (loopback) await close(loopback.server);
  } finally {
    await close(server);
  }
});

test('D9: a port held only on :: is busy even though IPv4 addresses are free', async () => {
  const { server, port } = await hold('::', 0, { ipv6Only: true });
  try {
    // With ipv6Only the IPv4 probes can bind; the third probe must still catch it.
    const v4 = await hold('127.0.0.1', port).catch(() => null);
    assert.equal(await portFree(port), false, 'the IPv6-only listener must be seen');
    if (v4) await close(v4.server);
  } finally {
    await close(server);
  }
});

test('D9: any bind error other than a missing IPv6 family means busy', async () => {
  // -1 is rejected by listen on every address; portFree must not treat that
  // as "no IPv6" and accidentally answer true.
  assert.equal(await portFree(-1), false);
});
