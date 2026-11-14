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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

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

// The scripts that phase 5 had to fix, run for real against a temp directory.
// Each of these was a bug the rehearsal would have hit: a `write` action that
// did not exist, a `current` pointer nothing maintained, a `.env` nobody could
// create, a `verified` marker nobody wrote, a keep-list nothing split and a
// bundle named as a path. A unit test proves the script; the rehearsal proves
// the pipeline.
describe('DW-5.5 the scripts the rehearsal would have hit', () => {
  /** A bash run of a script with `args`, stdin as given, in `cwd`. */
  const bash = (script, args, { stdin = null, cwd = null } = {}) => execFileSync('bash', [
    path.join(ROOT, 'remote', script), ...args,
  ], { encoding: 'utf8', input: stdin ?? '', cwd: cwd ?? undefined });

  const A = 'a'.repeat(40);

  /**
   * A path in the form the scripts get on this machine: POSIX (`/c/…`), because
   * this `tar` reads a drive letter as a remote host and exits 128 before doing
   * anything. This is the plan's phase-5 edge case ("record the form that works"):
   * every path the rehearsal hands a script is in exactly this shape, and Docker
   * Desktop resolves it the same way.
   */
  const posix = file => file.replace(/^([A-Za-z]):/, '/$1').split(path.sep).join('/');

  it('state.sh writes the record a rollback reads back, atomically', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vl-state-'));
    try {
      assert.equal(bash('state.sh', [dir, 'read']).trim(), '{"current":null,"previous":null,"history":[]}');
      bash('state.sh', [dir, 'write', 'vl-aaaa111', A, A, 'false', '']);
      const written = JSON.parse(bash('state.sh', [dir, 'read']));
      assert.equal(written.current.id, 'vl-aaaa111');
      assert.equal(written.current.commit, A);
      assert.equal(written.current.migrated, false);
      assert.equal(written.previous, null, 'the first record has nothing before it');
      bash('state.sh', [dir, 'write', 'vl-bbbb222', 'b'.repeat(40), 'b'.repeat(40), 'true', 'b1']);
      const next = JSON.parse(bash('state.sh', [dir, 'read']));
      assert.equal(next.current.id, 'vl-bbbb222');
      assert.equal(next.previous.id, 'vl-aaaa111', 'current → previous, which is what a rollback uses');
      assert.equal(next.current.backup, 'b1', 'the verified backup travels with the record (D-10)');
      assert.equal(next.history.length, 1);
      // No leftover temp file: the write is a rename, so a partial record is
      // never what a reader sees.
      assert.equal(readdirSync(dir).includes('state.json.tmp'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare.sh generates a .env from the template and never overwrites one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vl-prepare-'));
    try {
      mkdirSync(path.join(dir, 'releases'), { recursive: true });
      cpSync(path.join(ROOT, 'shared.env.template'), path.join(dir, 'releases', 'shared.env.template'));
      bash('prepare.sh', [dir]);
      const env = readFileSync(path.join(dir, 'shared', '.env'), 'utf8');
      // The placeholders are gone, and the secrets are 64 hex characters.
      assert.equal(env.includes('${GENERATED}'), false, 'no placeholder survives');
      const password = /^DB_PASSWORD=([0-9a-f]{64})$/m.exec(env);
      const token = /^ADMIN_TOKEN=([0-9a-f]{64})$/m.exec(env);
      assert.ok(password && token, 'DB_PASSWORD and ADMIN_TOKEN are generated');
      assert.notEqual(password[1], token[1], 'and they are not the same secret');
      // A host that already has one keeps it byte for byte (D-12).
      writeFileSync(path.join(dir, 'shared', '.env'), 'DB_PASSWORD=kept\n');
      bash('prepare.sh', [dir]);
      assert.equal(readFileSync(path.join(dir, 'shared', '.env'), 'utf8'), 'DB_PASSWORD=kept\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verify-backup.sh writes the marker restore-db.sh refuses to work without', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vl-verify-'));
    try {
      mkdirSync(path.join(dir, 'volumes'), { recursive: true });
      // Node writes the fixture: a Windows path inside a `bash -c` string is a
      // quoting problem a backup does not have.
      writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\n'));
      writeFileSync(path.join(dir, 'manifest.json'), '{"created":"2026-11-14"}\n');
      // A real tar, because `tar -tzf` reads it as one: gzipped text is a valid
      // gzip and an invalid archive, and the script says so by name. It is made
      // with a relative name beside its directory — a drive-letter path is a
      // remote host to this machine's `tar` (see `writeBundle`).
      const volume = mkdtempSync(path.join(tmpdir(), 'vl-verify-vol-'));
      writeFileSync(path.join(volume, 'a.txt'), 'assets\n');
      execFileSync('tar', ['-czf', '../assets.tar.gz', '.'], { cwd: volume, maxBuffer: 1 << 20 });
      renameSync(path.join(path.dirname(volume), 'assets.tar.gz'),
        path.join(dir, 'volumes', 'assets.tar.gz'));
      rmSync(volume, { recursive: true, force: true });
      const out = bash('verify-backup.sh', [posix(dir)]);
      assert.match(out, /verified=1/);
      assert.equal(existsSync(path.join(dir, 'verified')), true,
        'restore-db.sh refuses an unverified backup, so the marker is the point');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prune.sh keeps the comma-separated tags, not one unkeepable word', () => {
    // Tags, not release ids: an image is `repo/service:<tag>` (OPS1 phase 5).
    const out = bash('prune.sh', ['dry', `${A},${'b'.repeat(40)}`,
      `virtual-lab/backend:${A}`, `virtual-lab/backend:${'b'.repeat(40)}`, `virtual-lab/backend:${'c'.repeat(40)}`]);
    assert.match(out, new RegExp(`keep=virtual-lab/backend:${A}`));
    assert.match(out, new RegExp(`keep=virtual-lab/backend:${'b'.repeat(40)}`));
    assert.match(out, /would_remove=virtual-lab\/backend:cccccccc/);
    assert.doesNotMatch(out, new RegExp(`would_remove=virtual-lab/backend:${A}`));
  });

  it('upload-bundle.sh unpacks the tar from stdin and renames when complete', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vl-upload-'));
    const releases = path.join(dir, 'releases');
    try {
      mkdirSync(releases, { recursive: true });
      const stage = mkdtempSync(path.join(tmpdir(), 'vl-upload-src-'));
      writeFileSync(path.join(stage, 'docker-compose.yml'), 'services: {}\n');
      writeFileSync(path.join(stage, 'release.env'), `VL_TAG=${A}\n`);
      // A relative archive name beside the stage, then read from there: this
      // machine's `tar` reads a drive-letter path as a remote host (see
      // `writeBundle`), which is the whole reason the bundle writer is shaped
      // the way it is.
      execFileSync('tar', ['-czf', '../vl-upload.tar.gz', '.'], { cwd: stage, maxBuffer: 1 << 20 });
      const tarFile = path.join(path.dirname(stage), 'vl-upload.tar.gz');
      const out = execFileSync('bash', [path.join(ROOT, 'remote', 'upload-bundle.sh'), posix(releases), 'vl-aaaa111'], {
        encoding: 'utf8', input: readFileSync(tarFile), maxBuffer: 1 << 20,
      });
      assert.match(out, /upload_ok=1/);
      // The release directory the scripts then run compose from.
      assert.equal(readFileSync(path.join(releases, 'vl-aaaa111', 'release.env'), 'utf8'), `VL_TAG=${A}\n`);
      rmSync(stage, { recursive: true, force: true });
      rmSync(tarFile, { force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
