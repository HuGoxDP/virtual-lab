// backup/restore.test.mjs
//
// The restore's gate over a real child process: a backup without the `verified`
// marker is refused — dry run and --yes alike — before anything is read or
// spawned; a marked backup dry-runs, and --yes reaches the mount check. No
// Docker, no database: BACKUP_DIR points at a temp fixture. Run with
// `node --test backup/restore.test.mjs`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESTORE = path.join(HERE, 'restore.mjs');

/** A backup fixture under a fresh root; `marked` decides whether the gate passes. */
function fixture({ marked, brokenManifest = false }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vl-restore-'));
  const name = '2026-11-18T00-00-00Z';
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\n'));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync('fixture'));
  writeFileSync(path.join(dir, 'manifest.json'), brokenManifest ? '{ not json' : JSON.stringify({
    createdAt: '2026-11-18T00:00:00Z',
    database: { name: 'virtual_lab', host: 'database', port: 5432 },
    volumes: [{ name: 'archives', mount: path.join(root, 'not-mounted'), bytes: 7 }],
  }));
  if (marked) writeFileSync(path.join(dir, 'verified'), '');
  return { root, name, dir };
}

function run(root, args) {
  return spawnSync(process.execPath, [RESTORE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BACKUP_DIR: root },
  });
}

test('a backup without the verified marker is refused on a dry run, named', () => {
  const { root, name } = fixture({ marked: false });
  const res = run(root, [name]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /verified/);
  assert.match(res.stderr, /verify-backup\.mjs/);
  assert.ok(!res.stdout.includes('dry run'), 'the refusal comes before the dry-run listing');
  rmSync(root, { recursive: true, force: true });
});

test('a backup without the marker is refused with --yes too, before any spawn', () => {
  // The manifest is deliberately broken: if the gate ran after the manifest
  // read, this would crash with a JSON error instead of the named refusal.
  const { root, name } = fixture({ marked: false, brokenManifest: true });
  const res = run(root, [name, '--yes']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /verified/);
  assert.ok(!/JSON/i.test(res.stderr), 'the gate must run before the manifest is read');
  assert.ok(!res.stdout.includes('restored'), 'nothing was restored');
  rmSync(root, { recursive: true, force: true });
});

test('a marked backup dry-runs: it lists the contents and stops without --yes', () => {
  const { root, name } = fixture({ marked: true });
  const res = run(root, [name]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dry run/);
  assert.match(res.stdout, /archives/);
  rmSync(root, { recursive: true, force: true });
});

test('a marked backup with --yes passes the gate and reaches the mount check', () => {
  const { root, name } = fixture({ marked: true });
  const res = run(root, [name, '--yes']);
  // The fixture's volume mount does not exist here: the refusal must be the
  // mount check's, which sits after the gate and before any gzip/psql spawn.
  assert.equal(res.status, 1);
  assert.match(res.stderr, /is not mounted here/);
  rmSync(root, { recursive: true, force: true });
});
