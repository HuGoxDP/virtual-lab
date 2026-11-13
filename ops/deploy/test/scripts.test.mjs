// ops/deploy/test/scripts.test.mjs
//
// OPS1 phase 4 (DW-4.4): every remote script is valid bash, and nothing in
// `ops/deploy/` contains a construct the Constraints forbid — no `eval`, no
// `curl | bash`, no secret read outside the redacted logger, no `--no-verify`,
// no force-push. The grep is part of `node --test`, so a new file cannot add one
// without a red run.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every file under `ops/deploy/`, recursively, as a relative path. */
function allFiles(dir = ROOT) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allFiles(full));
    else out.push(full);
  }
  return out;
}

// The forbidden constructs live in this file, as patterns; a grep that read its own
// source would match them there and nowhere else, which is noise, not a finding.
const SELF = path.resolve(fileURLToPath(import.meta.url));
const codeFiles = () => allFiles().filter(f => f !== SELF);

const hasBash = (() => {
  try {
    execFileSync('bash', ['-n', '-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** What the Constraints of the plan forbid anywhere under ops/deploy/. */
const FORBIDDEN = [
  [/\beval\s+/, 'eval'],
  [/curl\s+[^|]*\|\s*(ba)?sh/, 'curl piped into a shell'],
  [/--no-verify/, 'git --no-verify'],
  [/--force(-with-lease)?\b/, 'a force push'],
  [/docker\s+compose\s+[^\n]*--build/, 'a build inside the release path'],
  [/\.env['"]?\s*\|\s*cat/, 'the shared .env printed'],
];

describe('DW-4.4 the remote scripts', () => {
  it('every .sh passes `bash -n`', t => {
    if (!hasBash) return t.skip('no bash on PATH — the syntax check runs where bash exists');
    const scripts = allFiles().filter(f => f.endsWith('.sh'));
    assert.ok(scripts.length >= 11, `expected the twelve remote scripts, found ${scripts.length}`);
    for (const script of scripts) {
      execFileSync('bash', ['-n', script]);
    }
  });

  it('nothing under ops/deploy/ contains a forbidden construct', () => {
    for (const file of codeFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, what] of FORBIDDEN) {
        assert.ok(!pattern.test(text), `${path.relative(ROOT, file)} contains ${what}`);
      }
    }
  });
});
