#!/usr/bin/env node
// frontend/scripts/check-csp-assumptions.mjs
//
// Checks that the built SPA still looks the way the platform's Content-Security-Policy
// (nginx/csp.conf) assumes, and fails the build if it does not.
//
// Since player-isolation the platform page runs **no scenario code**: scenarios run in a sandboxed
// frame (`/player/player.html`) on an opaque origin with its own policy. So the page's policy is the
// plainest one it has had, and these are the things that would silently break it or quietly widen it:
//
//   - `index.html` carries no import map. The engine is no longer resolved in the page; an import map
//     (which needs a nonce, which needs `'nonce-…'` in `script-src`) would mean something put engine
//     code back.
//   - no other inline <script> and no inline event handler: `script-src` is `'self'` and
//     `script-src-attr` is `'none'`, so either is blocked at run time and only noticed in a browser.
//   - no bundle imports the bare specifier `"WebEngineTS"` or `"WebEngineTS/…"`. With no import map such
//     an import cannot resolve, and the whole app fails to start. (`angular.json` must not list the
//     engine under `externalDependencies`: esbuild would keep the `player-host` subpath external too.)
//   - when `nginx/csp.conf` is available (it is not inside the Docker build stage): its `script-src`
//     has no `blob:` and no nonce, and `frame-src 'self'` is present.
//
// Run after `ng build`:  node scripts/check-csp-assumptions.mjs [dist-dir] [path/to/csp.conf]

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Inline scripts of any kind: a <script> without `src`. */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>/gi;

/** Inline event-handler attributes, which `script-src-attr 'none'` blocks. */
const INLINE_HANDLER = /\son(load|click|error|submit)\s*=/gi;

/** `from "WebEngineTS"`, `import("WebEngineTS/player-host")`, `import "WebEngineTS"` and the like. */
const BARE_ENGINE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']WebEngineTS(?:\/[^"']*)?["']/;

/** @returns {string[]} what is wrong with the document, empty when it matches the policy */
export function checkIndexHtml(html) {
  const problems = [];

  if (/<script[^>]*\btype\s*=\s*["']importmap["']/i.test(html)) {
    problems.push(
      'index.html has an import map. The page no longer resolves the engine (the sandboxed player ' +
      'does); an import map needs a nonce in script-src, which csp.conf no longer grants'
    );
  }
  if (/\bnonce\s*=/i.test(html)) {
    problems.push('index.html carries a nonce attribute; script-src has no nonce any more');
  }

  const inline = html.match(INLINE_SCRIPT) ?? [];
  if (inline.length > 0) {
    problems.push(`inline script(s), which the CSP blocks: ${inline.join(', ')}`);
  }

  const handlers = [...html.matchAll(INLINE_HANDLER)].map(m => m[0].trim());
  if (handlers.length > 0) {
    problems.push(
      `inline event handler(s) ${handlers.join(', ')} - script-src-attr is 'none'. ` +
      `Angular's critical-CSS inliner emits one; it is disabled in angular.json for this reason`
    );
  }
  return problems;
}

/**
 * @param {Array<{ name: string; text: string }>} files the built JavaScript
 * @returns {string[]}
 */
export function checkBundles(files) {
  return files
    .filter(file => BARE_ENGINE_IMPORT.test(file.text))
    .map(file =>
      `${file.name} imports a bare "WebEngineTS" specifier. With no import map it cannot resolve and the ` +
      `app would not start. Keep the engine out of angular.json's externalDependencies and import only ` +
      `"WebEngineTS/player-host" (which is bundled)`
    );
}

/** @returns {string[]} */
export function checkCsp(cspConf) {
  const problems = [];
  const policy = cspConf.match(/add_header\s+Content-Security-Policy\s+"([^"]*)"/)?.[1] ?? '';
  const scriptSrc = policy.split(';').map(d => d.trim()).find(d => d.startsWith('script-src ')) ?? '';

  if (!policy) problems.push('csp.conf declares no Content-Security-Policy header');
  if (/(^|\s)blob:/.test(scriptSrc)) problems.push(`script-src allows blob: (${scriptSrc}); the page no longer executes scenario scripts`);
  if (/'nonce-/.test(scriptSrc)) problems.push(`script-src carries a nonce (${scriptSrc}); the import map it served is gone`);
  const imgSrc = policy.split(';').map(d => d.trim()).find(d => d.startsWith('img-src ')) ?? '';
  if (/(^|\s)(https?:|\*)(\s|$)/.test(imgSrc)) problems.push(`img-src allows off-origin images (${imgSrc}); covers are uploaded to /previews/ (Nocturne release 2)`);
  if (!/(^|;)\s*frame-src 'self'(\s|;|$)/.test(policy)) problems.push(`frame-src 'self' is missing; the viewer frames /player/player.html`);
  return problems;
}

async function builtScripts(dist) {
  const names = (await readdir(dist)).filter(name => name.endsWith('.js'));
  return Promise.all(names.map(async name => ({ name, text: await readFile(path.join(dist, name), 'utf8') })));
}

async function main() {
  const dist = process.argv[2] ?? 'dist/university-mock/browser';
  const cspPath = process.argv[3] ?? path.resolve('..', 'nginx', 'csp.conf');

  const problems = [
    ...checkIndexHtml(await readFile(path.join(dist, 'index.html'), 'utf8')),
    ...checkBundles(await builtScripts(dist)),
  ];

  let cspNote = 'csp.conf not found (expected inside the Docker build stage), so its directives were not checked.';
  try {
    problems.push(...checkCsp(await readFile(cspPath, 'utf8')));
    cspNote = `${cspPath}: no blob:, no nonce in script-src, frame-src 'self'.`;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  if (problems.length > 0) {
    console.error('The built app does not match the CSP in nginx/csp.conf:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`The built app matches the CSP: no import map, nonce or inline script; no bare engine import. ${cspNote}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
