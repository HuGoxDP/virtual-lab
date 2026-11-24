// scripts/test/https-redirect-blank.test.mjs
//
// P5f: the https overlay must pass a deliberately BLANK HTTPS_REDIRECT_PORT
// through to the frontend container. `${VAR:-fallback}` substitutes on unset
// OR empty, so a blank never reached nginx/10-https-redirect.sh (which already
// treats blank as "no redirect", pinned by https-redirect.test.mjs). The outer
// interpolation must be `${HTTPS_REDIRECT_PORT-...}` (substitute only on
// unset): blank = redirect off, unset = HTTPS_PORT (else 8443). The inner
// fallback keeps `:-` — a blank HTTPS_PORT should still mean 8443.
//
// Runs `docker compose config` (no daemon needed) in a temp dir holding both
// compose files and an .env copied from .env.example. Child env scrubs
// COMPOSE_FILE / HTTPS_PORT / HTTPS_REDIRECT_PORT so only the case's own
// values interpolate. Without a Docker CLI the file returns early, passing.
// `node --test`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });

if (dockerCompose.status !== 0) {
  // No Docker CLI on this machine: the interpolation cannot be exercised.
  // Return early by declaring no tests — the file passes without asserting.
  console.log('https-redirect-blank: Docker CLI unavailable — nothing to run');
} else {
  /**
   * Resolves services.frontend.environment.HTTPS_REDIRECT_PORT via
   * `docker compose -f docker-compose.yml -f docker-compose.https.yml config`.
   * `envVars` go into the child environment (undefined = unset); `envFileLine`,
   * when given, is appended to the temp .env instead.
   */
  function resolvePort(envVars = {}, envFileLine = null) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'https-redirect-blank-'));
    try {
      copyFileSync(path.join(ROOT, 'docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
      copyFileSync(path.join(ROOT, 'docker-compose.https.yml'), path.join(dir, 'docker-compose.https.yml'));
      copyFileSync(path.join(ROOT, '.env.example'), path.join(dir, '.env'));
      if (envFileLine !== null) appendFileSync(path.join(dir, '.env'), `\n${envFileLine}\n`);
      const env = { ...process.env };
      delete env.COMPOSE_FILE;
      delete env.HTTPS_PORT;
      delete env.HTTPS_REDIRECT_PORT;
      for (const [key, value] of Object.entries(envVars)) env[key] = value;
      const res = spawnSync('docker',
        ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.https.yml', 'config', '--format', 'json'],
        { cwd: dir, env, encoding: 'utf8' });
      assert.equal(res.status, 0, `docker compose config must succeed: ${res.stderr}`);
      const config = JSON.parse(res.stdout);
      return config.services.frontend.environment;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('https overlay: nothing set — HTTPS_REDIRECT_PORT defaults to 8443', () => {
    const env = resolvePort();
    assert.equal(env.HTTPS_REDIRECT_PORT, '8443');
  });

  test('https overlay: unset redirect port follows HTTPS_PORT=9000', () => {
    const env = resolvePort({ HTTPS_PORT: '9000' });
    assert.equal(env.HTTPS_REDIRECT_PORT, '9000');
  });

  test('https overlay: blank HTTPS_REDIRECT_PORT in the env reaches the container as empty (redirect off)', () => {
    const env = resolvePort({ HTTPS_REDIRECT_PORT: '' });
    assert.ok(Object.hasOwn(env, 'HTTPS_REDIRECT_PORT'),
      'the key must be PRESENT — absent would leave the old value in the image env');
    assert.equal(env.HTTPS_REDIRECT_PORT, '');
  });

  test('https overlay: blank redirect port stays blank even with HTTPS_PORT=9000', () => {
    const env = resolvePort({ HTTPS_REDIRECT_PORT: '', HTTPS_PORT: '9000' });
    assert.ok(Object.hasOwn(env, 'HTTPS_REDIRECT_PORT'));
    assert.equal(env.HTTPS_REDIRECT_PORT, '');
  });

  test('https overlay: an explicit HTTPS_REDIRECT_PORT=77 wins over HTTPS_PORT', () => {
    const env = resolvePort({ HTTPS_REDIRECT_PORT: '77', HTTPS_PORT: '9000' });
    assert.equal(env.HTTPS_REDIRECT_PORT, '77');
  });

  test('https overlay: the line HTTPS_REDIRECT_PORT= in .env (not the env) also means redirect off', () => {
    const env = resolvePort({}, 'HTTPS_REDIRECT_PORT=');
    assert.ok(Object.hasOwn(env, 'HTTPS_REDIRECT_PORT'));
    assert.equal(env.HTTPS_REDIRECT_PORT, '');
  });
}
