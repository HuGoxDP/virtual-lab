// ops/deploy/test/scripts.test.mjs
//
// OPS1 phase 4 (DW-4.4): every remote script is valid bash, and nothing in
// `ops/deploy/` contains a construct the Constraints forbid — no `eval`, no
// `curl | bash`, no secret read outside the redacted logger, no `--no-verify`,
// no force-push. The grep is part of `node --test`, so a new file cannot add one
// without a red run.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
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

/** What the Constraints of the plan forbid anywhere under ops/deploy/. The build
 * rule is separate (below), because the rehearsal driver legitimately builds its
 * hand-made stack while the release path never may (decision D-2). */
const FORBIDDEN = [
  [/\beval\s+/, 'eval'],
  [/curl\s+[^|]*\|\s*(ba)?sh/, 'curl piped into a shell'],
  [/--no-verify/, 'git --no-verify'],
  [/--force(-with-lease)?\b/, 'a force push'],
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

  /**
 * The release path: the pipeline's entry point, every remote script it runs and
 * every library it runs them through. A release runs images (decision D-2), so
 * this is the set of files that must never build.
 *
 * The rehearsal driver is deliberately not in it: R-7's hand-made stack is built
 * on purpose, so that `up --no-build` has something real to point at.
 */
function releaseFiles() {
  return [
    path.join(ROOT, 'deploy.mjs'),
    ...allFiles(path.join(ROOT, 'remote')),
    ...allFiles(path.join(ROOT, 'lib')).filter(f => f.endsWith('.mjs')),
  ];
}

it('every script that runs the stack points compose at the shared env', () => {
    // The base compose reads its `env_file` from `VL_SHARED_ENV`, because a release
    // directory has no `.env` of its own. A script that runs compose without it
    // answers "env file …/releases/<id>/.env not found", which is how the
    // rehearsal's backup step failed (OPS1 phase 5). `inspect` asks compose for its
    // *version* and runs no stack, so it is not in this set.
    const runs = /docker compose\s+--project-name/;
    const scripts = allFiles().filter(f => f.endsWith('.sh') && runs.test(readFileSync(f, 'utf8')));
    assert.ok(scripts.length >= 5, `expected the stack-touching scripts, found ${scripts.length}`);
    for (const file of scripts) {
      assert.ok(/VL_SHARED_ENV=/.test(readFileSync(file, 'utf8')),
        `${path.relative(ROOT, file)} runs the stack but never sets VL_SHARED_ENV`);
    }
  });

  it('no child inside a command substitution can eat the script it came in on', () => {
    // A remote script travels on stdin (`bash -s --`, decision D-14), and a child
    // that inherits that stdin reads the *rest of the script*: the rehearsal's
    // backup answered `ok` while its own `backup_name=` line never arrived, so the
    // next step could not find the backup (OPS1 phase 5). Nothing in these scripts
    // reads stdin, so every such child gets `< /dev/null`.
    for (const file of allFiles().filter(f => f.endsWith('.sh'))) {
      const text = readFileSync(file, 'utf8');
      for (const [index, substitution] of [...text.matchAll(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].entries()) {
        const body = substitution[1];
        if (!/docker|node|npm/.test(body)) continue;
        assert.ok(/<\s*\/dev\/null/.test(body),
          `${path.relative(ROOT, file)} runs a child inside $( ) #${index + 1} that can read the script's stdin`);
      }
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

  it('the release path builds nothing, and only the rehearsal build is a hand-made one', () => {
    const files = releaseFiles();
    assert.ok(files.length >= 14, `expected the whole release path, found ${files.length} files`);
    for (const file of files) {
      assert.ok(!/--build/.test(readFileSync(file, 'utf8')),
        `${path.relative(ROOT, file)} builds inside the release path`);
    }
    // The one build in the tree is the rehearsal's own hand-made stack (R-7), and
    // it is not part of the release path.
    const driver = readFileSync(path.join(ROOT, 'rehearse.mjs'), 'utf8');
    assert.match(driver, /up', '-d', '--build/, "the hand-made stack is built (R-7)");
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

  /** A temp directory in the form *this process* can use. */
  const mkdtemp = prefix => mkdtempSync(path.join(tmpdir(), prefix)).split(path.sep).join('/');

  /**
   * A path in the form the scripts get on this machine: POSIX (`/c/…`), because
   * this `tar` reads a drive letter as a remote host and exits 128 before doing
   * anything. This is the plan's phase-5 edge case ("record the form that works"):
   * every path the rehearsal hands a script is in exactly this shape, and Docker
   * Desktop resolves it the same way.
   */
  const posix = file => file.replace(/^([A-Za-z]):/, '/$1').split(path.sep).join('/');

  it('a script that needs the running release reads it from the current file', () => {
    // `releases/current` is a FILE with the release id in it, not a symlink: this
    // machine's `ln -s` *copies* (MSYS without winsymlinks), so a symlink swap
    // answered "cannot move current.tmp to current: Directory not empty" and every
    // deploy after the first failed at `up` (OPS1 phase 5).
    const dir = mkdtemp('vl-current-');
    try {
      mkdirSync(path.join(dir, 'releases'), { recursive: true });
      // Before any deploy there is no running release, and the scripts say so by
      // name rather than asking docker about a directory that is not there.
      for (const [script, marker] of [['migrations.sh', 'no-current-release'], ['backup.sh', 'no-current-release']]) {
        const answer = spawnSync('bash', [path.join(ROOT, 'remote', script), posix(dir), 'vlprobe', 'docker-compose.yml'], {
          encoding: 'utf8',
        });
        assert.equal(answer.status, 1, `${script} refuses`);
        assert.match(answer.stderr, new RegExp(marker), `${script} names it`);
      }
      // With the file written, the same scripts proceed past that gate — and then
      // fail for want of the release directory it names, which is a different,
      // equally honest refusal.
      writeFileSync(path.join(dir, 'releases', 'current'), 'vl-aaaa111\n');
      const withCurrent = spawnSync('bash', [path.join(ROOT, 'remote', 'migrations.sh'), posix(dir), 'vlprobe', 'docker-compose.yml'], {
        encoding: 'utf8',
      });
      assert.equal(withCurrent.status, 1);
      assert.match(withCurrent.stderr, /no-current-release/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

/** A bundle tar uploaded through the script, exactly as the pipeline does it. */
  const uploadViaScript = (releases, release, tarFile) => execFileSync('bash',
    [path.join(ROOT, 'remote', 'upload-bundle.sh'), releases, release], {
      encoding: 'utf8', input: readFileSync(tarFile), maxBuffer: 1 << 20,
    });

  it('prepare.sh generates a .env from the template and never overwrites one', () => {
    const dir = mkdtemp('vl-prepare-');
    try {
      mkdirSync(path.join(dir, 'releases'), { recursive: true });
      cpSync(path.join(ROOT, 'shared.env.template'), path.join(dir, 'releases', 'shared.env.template'));
      bash('prepare.sh', [posix(dir)]);
      const env = readFileSync(path.join(dir, 'shared', '.env'), 'utf8');
      // The placeholders are gone, and the secrets are 64 hex characters.
      assert.equal(env.includes('${GENERATED}'), false, 'no placeholder survives');
      const password = /^DB_PASSWORD=([0-9a-f]{64})$/m.exec(env);
      const token = /^ADMIN_TOKEN=([0-9a-f]{64})$/m.exec(env);
      assert.ok(password && token, 'DB_PASSWORD and ADMIN_TOKEN are generated');
      assert.notEqual(password[1], token[1], 'and they are not the same secret');
      // A host that already has one keeps it byte for byte (D-12).
      writeFileSync(path.join(dir, 'shared', '.env'), 'DB_PASSWORD=kept\n');
      bash('prepare.sh', [posix(dir)]);
      assert.equal(readFileSync(path.join(dir, 'shared', '.env'), 'utf8'), 'DB_PASSWORD=kept\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the upload puts the template beside the releases, where prepare finds it', () => {
    // A fresh host has no `.env`, and `prepare` runs before `up` — so
    // `releases/current` does not exist yet and the template has to be at the
    // stable `releases/` path. Inside the release directory it was invisible, and
    // every first deploy answered `env=absent` (OPS1 phase 5).
    const dir = mkdtemp('vl-upload-');
    const releases = path.join(dir, 'releases');
    const stage = mkdtemp('vl-upload-src-');
    const nested = path.join(stage, 'ops', 'deploy');
    try {
      mkdirSync(releases, { recursive: true });
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(stage, 'docker-compose.yml'), 'services: {}\n');
      writeFileSync(path.join(stage, 'release.env'), 'VL_TAG=vl-aaaa111\n');
      writeFileSync(path.join(nested, 'shared.env.template'), 'DB_PASSWORD=${GENERATED}\n');
      execFileSync('tar', ['-czf', '../vl-upload.tar.gz', '.'], { cwd: stage, maxBuffer: 1 << 20 });
      const tarFile = path.join(path.dirname(stage), 'vl-upload.tar.gz');
      const out = execFileSync('bash', [path.join(ROOT, 'remote', 'upload-bundle.sh'), posix(releases), 'vl-aaaa111'], {
        encoding: 'utf8', input: readFileSync(tarFile), maxBuffer: 1 << 20,
      });
      assert.match(out, /template=shared\.env\.template/);
      assert.equal(readFileSync(path.join(releases, 'shared.env.template'), 'utf8'), 'DB_PASSWORD=${GENERATED}\n');
      assert.equal(readFileSync(path.join(releases, 'vl-aaaa111', 'release.env'), 'utf8'), 'VL_TAG=vl-aaaa111\n');
      // And `prepare` then finds it, without anyone putting it there by hand.
      const prepared = execFileSync('bash', [path.join(ROOT, 'remote', 'prepare.sh'), posix(dir)], { encoding: 'utf8' });
      assert.match(prepared, /env=created/);
      assert.match(readFileSync(path.join(dir, 'shared', '.env'), 'utf8'), /DB_PASSWORD=[0-9a-f]{64}/);
      rmSync(stage, { recursive: true, force: true });
      rmSync(tarFile, { force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a bundle without the template refuses the upload', () => {
    // A release that cannot start a fresh host must not be uploaded as one.
    const dir = mkdtemp('vl-upload-');
    const releases = path.join(dir, 'releases');
    const stage = mkdtemp('vl-upload-src-');
    try {
      mkdirSync(releases, { recursive: true });
      writeFileSync(path.join(stage, 'docker-compose.yml'), 'services: {}\n');
      execFileSync('tar', ['-czf', '../vl-upload.tar.gz', '.'], { cwd: stage, maxBuffer: 1 << 20 });
      const tarFile = path.join(path.dirname(stage), 'vl-upload.tar.gz');
      assert.throws(() => uploadViaScript(posix(releases), 'vl-aaaa111', tarFile), /no-shared-env-template/);
      assert.equal(existsSync(path.join(releases, 'vl-aaaa111')), false, 'nothing was left behind');
      rmSync(stage, { recursive: true, force: true });
      rmSync(tarFile, { force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the fixed upload command and the script are the same procedure', async () => {
    // The pipeline runs the fixed one-liner (D-14: one procedure for both
    // transports), and the script is the same steps in file form. They must not
    // drift: a one-liner that forgot the `.env` template would leave every fresh
    // install without one, which is how the rehearsal's first runs failed
    // (OPS1 phase 5).
    const { localTransport, UPLOAD_BUNDLE_COMMAND } = await import('../lib/transport.mjs');
    const stage = mkdtemp('vl-upload-src-');
    const nested = path.join(stage, 'ops', 'deploy');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(stage, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(path.join(stage, 'release.env'), 'VL_TAG=vl-aaaa111\n');
    writeFileSync(path.join(nested, 'shared.env.template'), 'DB_PASSWORD=${GENERATED}\n');
    execFileSync('tar', ['-czf', '../vl-upload.tar.gz', '.'], { cwd: stage, maxBuffer: 1 << 20 });
    const tarFile = path.join(path.dirname(stage), 'vl-upload.tar.gz');
    const tar = readFileSync(tarFile);

    // The script, in one root; the fixed command, in another.
    const viaScript = mkdtemp('vl-upload-');
    const viaCommand = mkdtemp('vl-upload-');
    try {
      uploadViaScript(posix(path.join(viaScript, 'releases')), 'vl-aaaa111', tarFile);
      mkdirSync(path.join(viaCommand, 'releases'), { recursive: true });
      const transport = localTransport();
      const answer = await transport.pipeIn(
        Readable.from([tar]),
        UPLOAD_BUNDLE_COMMAND,
        [posix(path.join(viaCommand, 'releases')), 'vl-aaaa111'],
      );
      assert.equal(answer.code, 0, answer.stderr);
      const members = root => {
        const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true })
          .flatMap(entry => (entry.isDirectory()
            ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
            : [`${prefix}${entry.name}`]))
          .filter(name => name !== 'releases/');
        return walk(root).sort();
      };
      // The same files, in the same places: the release, the release env, and the
      // template beside the releases.
      assert.deepEqual(members(viaScript), members(viaCommand));
      assert.ok(members(viaScript).includes('releases/shared.env.template'),
        'and both put the template where prepare finds it');
    } finally {
      rmSync(stage, { recursive: true, force: true });
      rmSync(tarFile, { force: true });
      rmSync(viaScript, { recursive: true, force: true });
      rmSync(viaCommand, { recursive: true, force: true });
    }
  });

  it('verify-backup.sh reads a Windows volume archive through its POSIX path', () => {
    // The scripts get the *host's* path form; on this machine `tar` reads a drive
    // letter as a remote host, so the volume archives are checked through their
    // POSIX form. `C:/rest` becomes `/c/rest` — keeping the colon (`/c:/rest`) is a
    // path nothing reads, which is how the first Windows rehearsal called a good
    // backup unreadable (OPS1 phase 5).
    const dir = mkdtemp('vl-verify-');
    try {
      mkdirSync(path.join(dir, 'volumes'), { recursive: true });
      writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\n'));
      writeFileSync(path.join(dir, 'manifest.json'), '{"created":"2026-11-16"}\n');
      const stage = mkdtemp('vl-verify-vol-');
      writeFileSync(path.join(stage, 'a.txt'), 'assets\n');
      mkdirSync(path.join(stage, 'sub'), { recursive: true });
      writeFileSync(path.join(stage, 'sub', 'b.txt'), 'more\n');
      execFileSync('tar', ['-czf', '../archives.tar.gz', '.'], { cwd: stage, maxBuffer: 1 << 20 });
      renameSync(path.join(path.dirname(stage), 'archives.tar.gz'),
        path.join(dir, 'volumes', 'archives.tar.gz'));
      rmSync(stage, { recursive: true, force: true });
      // The Windows form — the form the pipeline passes on this host.
      const windows = posix(dir).replace(/^\/([A-Za-z])\//, (_, drive) => `${drive.toUpperCase()}:/`);
      assert.ok(/^[A-Za-z]:\//.test(windows), `a drive path, not a POSIX one: ${windows}`);
      const out = bash('verify-backup.sh', [windows]);
      assert.match(out, /verified=1/);
      assert.equal(existsSync(path.join(dir, 'verified')), true);
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
    const dir = mkdtemp('vl-upload-');
    const releases = path.join(dir, 'releases');
    try {
      mkdirSync(releases, { recursive: true });
      const stage = mkdtemp('vl-upload-src-');
      writeFileSync(path.join(stage, 'docker-compose.yml'), 'services: {}\n');
      writeFileSync(path.join(stage, 'release.env'), `VL_TAG=${A}\n`);
      // The template the bundle has to carry, or `prepare` on a fresh host could
      // never make an `.env` (OPS1 phase 5).
      mkdirSync(path.join(stage, 'ops', 'deploy'), { recursive: true });
      writeFileSync(path.join(stage, 'ops', 'deploy', 'shared.env.template'), 'DB_PASSWORD=${GENERATED}\n');
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
