// scripts/test/compose-backup-dir.test.mjs
//
// P5c: BACKUP_DIR has two different jobs and must not do both with one value.
// In docker-compose.yml's backup service it is ONLY the host mount source
// (`${BACKUP_DIR:-./backup/out}:/backups`); the container environment must pin
// `BACKUP_DIR: /backups` as a literal. Before the fix the environment line was
// `BACKUP_DIR: ${BACKUP_DIR:-/backups}`, so an admin's `BACKUP_DIR=/mnt/offsite`
// in `.env` made backup.mjs write to /mnt/offsite INSIDE the container while
// the mount sat at /backups — the off-host folder stayed empty and every
// backup vanished on the next container recreate (the update's `up -d --build`).
// The literal `environment:` entry also overrides the same key arriving via
// `env_file: .env` (Compose precedence: environment > env_file).
//
// Pattern: selfhost-doc.test.mjs — fs reads + node:test, no Docker required.
// A live `docker compose config` cross-check (the review's suggested proof)
// runs only when Docker Compose is available, like verify-backup's system-tar
// probe; the fs pins above hold everywhere.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');

/** The `backup:` service block: from its 2-space key to the next top-level key. */
function backupBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^ {2}backup:\s*$/.test(l));
  assert.notEqual(start, -1, 'docker-compose.yml must define the backup service');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) { end = i; break; }        // top-level key (volumes:)
    if (/^ {2}\S/.test(lines[i])) { end = i; break; }    // next service
  }
  return lines.slice(start, end).join('\n');
}

const BLOCK = backupBlock(COMPOSE);

test('P5c: the backup service pins the container BACKUP_DIR to the literal /backups', () => {
  assert.match(BLOCK, /^\s*BACKUP_DIR:\s*\/backups\s*$/m,
    'environment must carry `BACKUP_DIR: /backups` — a literal, not ${BACKUP_DIR:-…}: ' +
    'a host path from .env must never become the in-container backup root');
  assert.doesNotMatch(BLOCK, /BACKUP_DIR:\s*\$\{/,
    'the environment entry must not interpolate BACKUP_DIR (that is the mount source’s job)');
});

test('P5c: BACKUP_DIR interpolates exactly once in the backup service — the host mount source', () => {
  const uses = [...BLOCK.matchAll(/\$\{BACKUP_DIR\b/g)];
  assert.equal(uses.length, 1,
    `BACKUP_DIR must appear as \${…} only in the mount source, found ${uses.length} uses`);
  assert.match(BLOCK, /^\s*-\s+\$\{BACKUP_DIR:-\.\/backup\/out\}:\/backups\s*$/m,
    'the mount must stay `${BACKUP_DIR:-./backup/out}:/backups` — the host folder, default local');
});

test('P5c: selfhost-check keeps the explicit -e BACKUP_DIR=/backups on the backup run child', () => {
  // The workaround is KEPT after the fix (decision: belt and braces — the
  // check must pass even against an older clone whose compose still
  // interpolates). The restore child's flag is already pinned by
  // selfhost-restore.test.mjs; this pins the backup child's flag, which had
  // no test of its own.
  const check = readFileSync(path.join(ROOT, 'scripts', 'selfhost-check.mjs'), 'utf8');
  const backupRun = check.split(/\r?\n/).find(l => l.includes("'run'") && l.includes('BACKUP_RUN_ONCE=1'));
  assert.ok(backupRun, 'the one-shot backup child (run … BACKUP_RUN_ONCE=1 … backup) must exist');
  assert.ok(backupRun.includes("'BACKUP_DIR=/backups'"),
    `the backup run keeps -e BACKUP_DIR=/backups: ${backupRun.trim()}`);
});

// ── Live cross-check: `docker compose config` with BACKUP_DIR=/x ──
// Skipped without Docker Compose or without a local `.env` (the services'
// `env_file: .env` is required by `config`; a bare clone has none). The fs
// pins above are the always-on gate.
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const hasEnvFile = existsSync(path.join(ROOT, '.env'));

test('P5c: compose config with BACKUP_DIR=/x — env stays /backups, mount source becomes /x',
  { skip: !hasCompose || !hasEnvFile }, () => {
    const env = { ...process.env, BACKUP_DIR: '/x' };
    delete env.COMPOSE_FILE; // the base file alone — never the host's overlay list
    const res = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', 'config', '--format', 'json'],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(res.status, 0, `docker compose config failed: ${res.stderr}`);
    const cfg = JSON.parse(res.stdout);
    const backup = cfg.services.backup;
    assert.equal(backup.environment.BACKUP_DIR, '/backups',
      'the resolved container env must be /backups regardless of the host value');
    const mount = backup.volumes.find(v => v.target === '/backups');
    assert.ok(mount, 'a volume mounted at /backups must exist');
    assert.equal(mount.source, '/x',
      'the host mount source must follow BACKUP_DIR — that is its only job');
  });