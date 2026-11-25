// scripts/test/selfhost-port-ipv6.test.mjs
//
// HO1f2 close: portFree must notice a port held on '::' by an IPv6-only
// listener (server.listen({ port, host: '::', ipv6Only: true })). The old
// positional form `listen(port, address, { ipv6Only: true })` passes the object
// as `backlog`, so ipv6Only was silently ignored and the '::' probe bound
// alongside the IPv6-only holder, wrongly reporting the port as free.
//
// NEW file — existing tests stay untouched. `node --test`.

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createServer } from 'node:net';
import { test } from 'node:test';

import { portFree } from '../selfhost-check.mjs';

// A loader hook swaps node:net only for fresh instances of selfhost-check.mjs,
// so the error-code cases below need no experimental --test-module-mocks flag.
const fakeNetModule = 'data:text/javascript,' + encodeURIComponent(
  'export const createServer = (...args) => globalThis.__fakeCreateServer(...args);'
);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'node:net' && context.parentURL?.includes('selfhost-check.mjs')) {
      return { url: ${JSON.stringify(fakeNetModule)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`));

/** Bind a real listener with the single-options form, so ipv6Only is applied. */
async function hold(options) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options, resolve);
  });
  return { server, port: server.address().port };
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

test('portFree: a port held on :: with ipv6Only is busy', async () => {
  const { server, port } = await hold({ port: 0, host: '::', ipv6Only: true });
  try {
    // The IPv4 addresses can still bind; only the '::' probe can see this holder.
    const v4 = await hold({ port, host: '127.0.0.1' }).catch(() => null);
    assert.ok(v4, 'the holder is IPv6-only, so 127.0.0.1 must be bindable');
    await close(v4.server);
    assert.equal(await portFree(port), false, 'an IPv6-only holder must make the port busy');
  } finally {
    await close(server);
  }
});

test('portFree: a port held on 0.0.0.0 is busy', async () => {
  const { server, port } = await hold({ port: 0, host: '0.0.0.0' });
  try {
    assert.equal(await portFree(port), false);
  } finally {
    await close(server);
  }
});

test('portFree: a port held nowhere is free', async () => {
  const { server, port } = await hold({ port: 0, host: '127.0.0.1' });
  await close(server);
  assert.equal(await portFree(port), true);
});

/**
 * Run portFree against a fake node:net.createServer that fails only the '::'
 * bind with `code`. A fresh module instance (query suffix) picks up the hook.
 */
async function portFreeWithIpv6Error(code) {
  globalThis.__fakeCreateServer = () => {
    const listeners = new Map();
    const server = {
      once(event, listener) {
        listeners.set(event, listener);
        return server;
      },
      listen(...args) {
        // Detect both forms: listen(options) and listen(port, host, backlog, cb).
        const options = args[0] && typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
        queueMicrotask(() => {
          if (options.host === '::') {
            const err = new Error(`simulated ${code}`);
            err.code = code;
            listeners.get('error')?.(err);
          } else {
            listeners.get('listening')?.();
          }
        });
        return server;
      },
      close(cb) {
        cb();
      },
    };
    return server;
  };
  const fresh = await import(`../selfhost-check.mjs?ipv6-error=${code}`);
  return await fresh.portFree(12345);
}

test('portFree: EAFNOSUPPORT on :: still means free', async () => {
  assert.equal(await portFreeWithIpv6Error('EAFNOSUPPORT'), true);
});

test('portFree: EADDRNOTAVAIL on :: still means free', async () => {
  assert.equal(await portFreeWithIpv6Error('EADDRNOTAVAIL'), true);
});

test('portFree: other bind errors on :: still mean busy', async () => {
  assert.equal(await portFreeWithIpv6Error('EADDRINUSE'), false);
});
