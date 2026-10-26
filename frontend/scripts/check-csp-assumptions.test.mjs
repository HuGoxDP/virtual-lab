// frontend/scripts/check-csp-assumptions.test.mjs
// Player isolation, phase 5 (DW-5.3): the checks that keep the platform page free of scenario code.
// Run: npm run test:scripts   (node's built-in runner; no extra dependency)

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkBundles, checkCsp, checkIndexHtml } from './check-csp-assumptions.mjs';

const CLEAN_HTML = '<!doctype html><html><head><base href="/"><script src="main-ABC.js" type="module"></script></head><body><app-root></app-root></body></html>';
const CLEAN_CSP =
  `add_header Content-Security-Policy "default-src 'self'; script-src 'self'; script-src-attr 'none'; frame-src 'self'; frame-ancestors 'self'" always;`;

test('DW-5.3 index.html: a clean document passes', () => {
  assert.deepEqual(checkIndexHtml(CLEAN_HTML), []);
});

test('DW-5.3 index.html: an import map is rejected, with or without a nonce', () => {
  assert.equal(checkIndexHtml('<script type="importmap">{"imports":{}}</script>').length >= 1, true);
  const nonced = checkIndexHtml('<script type="importmap" nonce="x">{}</script>');
  assert.ok(nonced.some(p => p.includes('import map')));
  assert.ok(nonced.some(p => p.includes('nonce')));
});

test('DW-5.3 index.html: any other inline script or event handler is rejected', () => {
  assert.equal(checkIndexHtml('<script>alert(1)</script>').length, 1);
  assert.equal(checkIndexHtml('<link rel="stylesheet" href="s.css" onload="this.media=\'all\'">').length, 1);
});

test('DW-5.3 bundles: bare WebEngineTS specifiers are rejected, relative and unrelated ones are not', () => {
  const bad = ['import{A}from"WebEngineTS";', "import { P } from 'WebEngineTS/player-host';", 'const m=await import("WebEngineTS/player-host");', 'import"WebEngineTS";'];
  for (const text of bad) assert.equal(checkBundles([{ name: 'a.js', text }]).length, 1, text);
  const fine = ['import{x}from"./chunk-1.js";', 'const s = "WebEngineTS is a name in a string";', 'x.from("WebEngineTS-notes")'];
  for (const text of fine) assert.deepEqual(checkBundles([{ name: 'a.js', text }]), [], text);
});

test('DW-5.3 csp.conf: the policy of record passes', () => {
  assert.deepEqual(checkCsp(CLEAN_CSP), []);
});

test('DW-5.3 csp.conf: blob:, a nonce, a missing frame-src or a missing header are each reported', () => {
  assert.equal(checkCsp(CLEAN_CSP.replace(`script-src 'self'`, `script-src 'self' blob:`)).length, 1);
  assert.equal(checkCsp(CLEAN_CSP.replace(`script-src 'self'`, `script-src 'self' 'nonce-$request_id'`)).length, 1);
  assert.equal(checkCsp(CLEAN_CSP.replace(` frame-src 'self';`, '')).length, 1);
  assert.equal(checkCsp('# nothing').length >= 1, true);
});

test('DW-5.3 csp.conf: blob: in img-src or worker-src is not a script-src finding', () => {
  const csp = CLEAN_CSP.replace(`frame-src`, `img-src 'self' data: blob:; worker-src 'self' blob:; frame-src`);
  assert.deepEqual(checkCsp(csp), []);
});
