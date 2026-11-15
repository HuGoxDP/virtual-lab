// ops/deploy/test/rehearse.test.mjs
//
// OPS1 phase 5 (DW-5.4): the rehearsal driver's own rules, without Docker. The
// run itself is what proves the pipeline; what is proven here is the part that
// would make the run meaningless if it were wrong — the table's verdict, the
// teardown's guard, the scratch branch's shape, the path form, and that nothing a
// rehearsal prints can be a secret.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROJECT, REHEARSAL_COMPOSE, SCRATCH_BRANCH, COMPOSE_FILES, PORT,
  posix, sha256, teardownGuard, createRecorder, createLog, envValue, readRecord,
  scratchCommits, writeEnv, mkdtemp, deployArgv,
} from '../rehearse.mjs';

/** A temporary git repo with one commit and an `origin/main` pointing at it. */
function tempRepo() {
  const repo = mkdtemp('vl-rehearse-');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  mkdirSync(path.join(repo, 'backend', 'migrations'), { recursive: true });
  writeFileSync(path.join(repo, 'backend', 'server.js'), "// the server\n");
  writeFileSync(path.join(repo, 'backend', 'migrations', '001_base.sql'), '-- base\n');
  writeFileSync(path.join(repo, 'docker-compose.yml'), 'services: {}\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());
  // The rehearsal's guard asks the remote, so the repo needs one: it is itself,
  // which is enough for `ls-remote` to answer.
  git('remote', 'add', 'origin', repo);
  return repo;
}

describe('DW-5.4 the rehearsal driver', () => {
  it('hands the scripts the host form, and converts to POSIX only for tar', () => {
    // A drive letter is a remote host to this machine's `tar` (OPS1 phase 5), and
    // docker's `--env-file` resolves a POSIX path through the current directory:
    // so the host form is the Windows one, and the one script that reads a tar
    // from a path converts (see `remote/verify-backup.sh`).
    assert.equal(posix('C:\\Users\\HuGox\\AppData\\Local\\Temp\\vl-rehearsal-1'),
      '/c/Users/HuGox/AppData/Local/Temp/vl-rehearsal-1');
    assert.equal(posix('/c/Users/HuGox/x'), '/c/Users/HuGox/x');
  });

  it('commands the deploy with the host form for every path it owns', () => {
    // `--local-root` becomes DEPLOY_PATH for the scripts, and on this machine that
    // is the form docker accepts (`C:/…`): a POSIX path is resolved to `C:\c\…`,
    // which does not exist (OPS1 phase 5).
    const root = mkdtemp('vl-rehearsal-');
    const envFile = writeEnv(root);
    try {
      const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      const argv = deployArgv({ envFile, localRoot: root, repo }, 'deploy');
      const flag = name => argv[argv.indexOf(name) + 1];
      assert.equal(flag('--local-root'), root, 'the scripts get the host form');
      assert.equal(flag('--env-file'), envFile, 'and so does the file Node reads');
      assert.equal(flag('--repo'), repo, 'and the repository git runs in');
      assert.equal(flag('--project'), PROJECT);
      assert.deepEqual(argv.slice(argv.indexOf('--compose-file') + 1, argv.indexOf('--repo')),
        [REHEARSAL_COMPOSE], 'the rehearsal compose file is added to the release list');
      assert.ok(argv.includes('--rehearsal'), 'local commits are allowed');
    } finally {
      rmSync(path.dirname(envFile), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints a digest of a file, never its contents', () => {
    const dir = mkdtemp('vl-sha-');
    try {
      const file = path.join(dir, '.env');
      writeFileSync(file, 'DB_PASSWORD=0123456789abcdef\n');
      assert.equal(sha256(file), sha256(file), 'a digest is stable');
      assert.equal(sha256(file), createHash('sha256')
        .update('DB_PASSWORD=0123456789abcdef\n').digest('hex'));
      // A different secret is a different digest, which is what "byte-identical"
      // means without ever showing a byte.
      writeFileSync(file, 'DB_PASSWORD=fedcba9876543210\n');
      assert.notEqual(sha256(file), createHash('sha256')
        .update('DB_PASSWORD=0123456789abcdef\n').digest('hex'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks the run red when a row answers an unexpected exit code', async () => {
    const recorder = createRecorder();
    await recorder.row('R-4 deploy C', 10, async () => 10);
    assert.equal(recorder.failed, false);
    await recorder.row('R-5 deploy D', 10, async () => 4);
    assert.equal(recorder.failed, true, 'one wrong row is a red rehearsal (DW-5.1)');
    assert.equal(recorder.rows.length, 2);
    assert.deepEqual(recorder.rows.map(r => r.ok), [true, false]);
  });

  it('records every command a step ran, so the notes carry the output', () => {
    const log = createLog();
    log.push('node ops/deploy/deploy.mjs deploy platform', { stdout: 'inspect → ok\n', stderr: '' });
    const text = log.text();
    assert.match(text, /deploy\.mjs deploy platform/);
    assert.match(text, /inspect → ok/);
  });

  it('refuses to tear down a project that owns a volume it did not create', () => {
    assert.deepEqual(teardownGuard('vlrehearsal',
      ['rehearsal_virtual_lab_pgdata', 'rehearsal_virtual_lab_archives']),
    { allowed: true, foreign: [] });
    // The teardown is the only `down -v` in the task, so it must never be able to
    // name a volume outside its own prefix — not even one that happens to sit on
    // the same machine as the rehearsal.
    assert.deepEqual(teardownGuard('vlrehearsal', ['vlrehearsal_stray', 'virtual_lab_pgdata']),
    { allowed: false, foreign: ['vlrehearsal_stray'] });
    assert.equal(teardownGuard('vlrehearsal', []).allowed, true, 'a project with no volumes has nothing to refuse');
  });

  it('runs the release compose list with the rehearsal file last', () => {
    assert.deepEqual(COMPOSE_FILES.split(';'), [
      'docker-compose.yml', 'docker-compose.restore.yml', 'ops/deploy/compose.release.yml', REHEARSAL_COMPOSE,
    ]);
    assert.equal(REHEARSAL_COMPOSE, 'ops/deploy/compose.rehearsal.yml', 'the file that renames the volumes and the port');
    assert.equal(PORT, '8047', 'the live local stack keeps 8044');
    assert.equal(PROJECT, 'vlrehearsal');
  });

  it('cuts the four rehearsal commits on a local branch that origin does not have', () => {
    const repo = tempRepo();
    try {
      const commits = scratchCommits('main', repo);
      assert.equal(commits.branch, SCRATCH_BRANCH);
      // A, B, C and D are four different commits, and A is what origin/main points at.
      assert.notEqual(commits.A, commits.B);
      assert.notEqual(commits.B, commits.C);
      assert.notEqual(commits.C, commits.D);
      assert.equal(commits.A, execFileSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim());
      // B changes only a comment, so the rehearsal's second release is a release
      // in every way the pipeline can tell.
      const diff = execFileSync('git', ['-C', repo, 'diff', commits.A, commits.B], { encoding: 'utf8' });
      assert.match(diff, /a visible no-op/);
      // C is a migration the smoke refuses, and it is the file rollback proves.
      const files = execFileSync('git', ['-C', repo, 'show', '--name-only', '--format=', commits.C], { encoding: 'utf8' });
      assert.match(files, /999_rehearsal_probe\.sql/);
      // D makes the backend exit at start, and it is the only commit that does.
      const d = execFileSync('git', ['-C', repo, 'show', commits.D], { encoding: 'utf8' });
      assert.match(d, /the backend exits at start/);
      // The branch is left on B, which is where the runs start.
      assert.equal(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commits.B);
    } finally {
      execFileSync('git', ['-C', repo, 'switch', '-q', '--detach', 'HEAD'], { encoding: 'utf8' });
      // The scratch branch is gone already: `scratchCommits` leaves the repo on B.
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('writes a deploy.env whose values cannot rewrite its own paths', () => {
    // The pipeline's redactor replaces every configured value in every log line, so
    // a value that also appears in a path makes that path unreadable in the log —
    // a `rehearsal` user turned `vl-rehearsal-XXX` into `vl-<DEPLOY_USER>-XXX`
    // (OPS1 phase 5). The rehearsal's own words are chosen not to collide.
    const root = mkdtemp('vl-rehearsal-');
    let file = null;
    try {
      file = writeEnv(root);
      for (const key of ['DEPLOY_USER', 'DEPLOY_HOST', 'DEPLOY_DOMAIN']) {
        const value = envValue(file, key);
        assert.equal(root.includes(value), false,
          `${key}'s value ${value} is not part of the rehearsal's own paths`);
      }
      assert.equal(envValue(file, 'DEPLOY_PATH'), root);
    } finally {
      if (file) rmSync(path.dirname(file), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a deploy.env with no secret and the host form of DEPLOY_PATH', () => {
    const root = mkdtemp('vl-env-');
    let file = null;
    try {
      file = writeEnv(root);
      const text = readFileSync(file, 'utf8');
      // The host's own form, which on this machine is the drive form docker accepts.
      assert.equal(envValue(file, 'DEPLOY_PATH'), root);
      assert.equal(envValue(file, 'FRONTEND_PORT'), PORT);
      assert.equal(envValue(file, 'DEPLOY_HOST'), '127.0.0.1');
      // The generated secrets are the *stack's*, never the deploy.env's: a value
      // the pipeline reads is a value that could reach a log (D-13).
      for (const forbidden of ['DB_PASSWORD', 'ADMIN_TOKEN']) {
        assert.equal(text.includes(forbidden), false, `${forbidden} is not in the rehearsal's deploy.env`);
      }
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the release record a rehearsal root holds, and says so when there is none', () => {
    const root = mkdtemp('vl-record-');
    try {
      assert.equal(readRecord(root).current, null, 'an empty root has no release');
      mkdirSync(path.join(root, 'releases'), { recursive: true });
      writeFileSync(path.join(root, 'releases', 'state.json'),
        JSON.stringify({ current: { id: 'vl-bbbb222', commit: 'b'.repeat(40), backup: 'b1' }, previous: null, history: [] }));
      assert.equal(readRecord(root).current.id, 'vl-bbbb222');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});