#!/usr/bin/env node
// frontend/scripts/build-csp.mjs
//
// Checks that index.html still looks the way the Content-Security-Policy in
// nginx.conf assumes, and fails the build if it does not.
//
// It does not generate the policy. An earlier version did, because the plan was
// to allow the inline import map by hash — but **Chromium matches import maps
// against `script-src` by nonce only and ignores hashes**, so a hash-based
// policy blocks the import map, "WebEngineTS" never resolves and every scenario
// fails while the header looks perfectly correct. nginx therefore injects a
// per-request nonce with `sub_filter`, and the policy is a literal in
// `nginx/nginx.conf`.
//
// What is left to verify is that the two still agree: the `sub_filter` pattern
// matches the exact opening tag Angular emits, and nothing else inline crept
// into the document. Both are silent failures at run time, so they are caught
// here at build time.
//
// Run after `ng build`.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DIST = process.argv[2] ?? 'dist/university-mock/browser';

/** Exactly what `sub_filter` in nginx.conf looks for, byte for byte. */
const IMPORTMAP_TAG = '<script type="importmap">';

async function main() {
  const indexPath = path.join(DIST, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const problems = [];

  // ── the nonce injection point ─────────────────────
  const tags = html.split(IMPORTMAP_TAG).length - 1;

  if (tags === 0) {
    problems.push(
      `no \`${IMPORTMAP_TAG}\` in index.html — nginx's sub_filter has nothing to add a nonce to, ` +
      `so the import map would be blocked and no scenario would run`
    );
  } else if (tags > 1) {
    // sub_filter_once is on: only the first occurrence gets a nonce.
    problems.push(`${tags} import map tags — only the first would receive a nonce`);
  }

  // ── anything else inline ──────────────────────────
  // The policy allows exactly one inline script, the nonced import map. Any
  // other inline <script> or event-handler attribute would be blocked.
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)]
    .map(m => m[0])
    .filter(tag => !tag.includes('type="importmap"'));

  if (inlineScripts.length > 0) {
    problems.push(
      `unexpected inline script(s), which the CSP will block: ${inlineScripts.join(', ')}`
    );
  }

  const handlers = [...html.matchAll(/\son(load|click|error|submit)\s*=/gi)].map(m => m[0].trim());
  if (handlers.length > 0) {
    problems.push(
      `inline event handler(s) ${handlers.join(', ')} — script-src-attr is 'none'. ` +
      `Angular's critical-CSS inliner emits one; it is disabled in angular.json for this reason`
    );
  }

  if (problems.length > 0) {
    console.error(`index.html does not match the CSP in nginx/nginx.conf:\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log('index.html matches the CSP: one import map to nonce, nothing else inline.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
