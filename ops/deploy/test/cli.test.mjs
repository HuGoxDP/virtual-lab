// ops/deploy/test/cli.test.mjs
//
// OPS1 phase 4 (DW-4.3): the command line's gates and its redaction, through
// `runDeploy` with an injected clock and an injected release repo. Nothing but
// `git` is spawned, so the test proves what the CLI *decides* rather than what
// it runs.
//
// The secret rule is the one under test throughout: a value from `deploy.env`
// must never reach stdout or the log file, not even on the dry run that prints
// every command.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDeploy } from '../deploy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, 'fixtures/deploy.env.sample');

/** The sample's values, which must never appear where the CLI writes. */
function sampleSecrets() {
  return ['deploy.example.invalid', 'deployer', '/srv/virtual-lab', 'platform.example.invalid'];
}

const SATURDAY = '2026-11-14T10:00:00Z';
const MONDAY_NOON = '2026-11-16T10:00:00Z';

/**
 * Tee stdout and stderr into arrays, so an assertion can read what the CLI wrote
 * *and* the test reporter still prints. Swallowing the reporter would hide its
 * own account of a failure, which is how this helper was wrong on the first try.
 */
function captureOutput() {
  const saved = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  const out = [];
  const err = [];
  process.stdout.write = chunk => { out.push(String(chunk)); return saved.out(chunk); };
  process.stderr.write = chunk => { err.push(String(chunk)); return saved.err(chunk); };
  return { out, err, restore: () => { process.stdout.write = saved.out; process.stderr.write = saved.err; } };
}

/** The log file the run wrote, if any. */
function logText(dir) {
  const files = readdirSync(dir).filter(name => name.endsWith('.log'));
  return files.length === 0 ? null : readFileSync(path.join(dir, files[0]), 'utf8');
}

/** A temp repository with one commit, optionally dirtied. */
function tempRepo({ dirty = false, ahead = false } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'vl-cli-repo-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'one');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());
  if (ahead) {
    writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    git('commit', '-qam', 'two');
  }
  if (dirty) writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
  return repo;
}

/**
 * A clean repository to cut the release from, injected so the CLI never depends
 * on the worktree it is being tested inside — which is exactly what makes the
 * first dry run here fail while the phase's own files are uncommitted.
 */
const CLEAN_REPO = tempRepo();
const DRY = argv => runDeploy({
  argv: ['deploy', 'platform', '--dry-run', '--env-file', SAMPLE, ...argv],
  now: () => new Date(SATURDAY),
  repo: CLEAN_REPO,
});

describe('DW-4.3 the CLI', () => {
  it('a dry run inside the window exits 0 and prints the whole plan', async () => {
    const capture = captureOutput();
    try {
      const code = await DRY([]);
      assert.equal(code, 0);
      const written = capture.out.join('');
      for (const step of ['inspect.sh', 'backup.sh', 'migrations.sh', 'up.sh', 'prune.sh']) {
        assert.match(written, new RegExp(step.replace('.', '\\.')), `${step} is in the plan`);
      }
    } finally {
      capture.restore();
    }
  });

  it('no `deploy.env` value reaches stdout or the log file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vl-cli-log-'));
    const capture = captureOutput();
    try {
      await DRY(['--log-dir', dir]);
      const stdout = capture.out.join('');
      const log = logText(dir);
      assert.ok(log !== null, 'a log file was written');
      for (const secret of sampleSecrets()) {
        assert.equal(stdout.includes(secret), false, `${secret} reached stdout`);
        assert.equal(log.includes(secret), false, `${secret} reached the log file`);
      }
      assert.match(log, /deploy platform/);
    } finally {
      capture.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('outside the window it exits 4 naming the window, and prints nothing remote', async () => {
    const capture = captureOutput();
    try {
      const code = await runDeploy({
        argv: ['deploy', 'platform', '--dry-run', '--env-file', SAMPLE],
        now: () => new Date(MONDAY_NOON),
        repo: CLEAN_REPO,
      });
      assert.equal(code, 4);
      assert.match(capture.out.join(''), /21:00–06:00|window/);
    } finally {
      capture.restore();
    }
  });

  it('a dirty worktree is exit 4 naming the fresh-source gate', async () => {
    const repo = tempRepo({ dirty: true });
    const capture = captureOutput();
    try {
      const code = await runDeploy({
        argv: ['deploy', 'platform', '--dry-run', '--env-file', SAMPLE],
        now: () => new Date(SATURDAY),
        repo,
      });
      assert.equal(code, 4);
      assert.match(capture.out.join(''), /fresh|worktree|origin\/main/i);
    } finally {
      capture.restore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a HEAD ahead of its default branch is exit 4, unless --dry-run', async () => {
    const repo = tempRepo({ ahead: true });
    const capture = captureOutput();
    try {
      // A dry run may describe a deploy that has not been pushed (it contacts
      // nothing); a real one may not.
      const dry = await runDeploy({
        argv: ['deploy', 'platform', '--dry-run', '--env-file', SAMPLE],
        now: () => new Date(SATURDAY),
        repo,
      });
      assert.equal(dry, 0);
      const real = await runDeploy({
        argv: ['deploy', 'platform', '--env-file', SAMPLE],
        now: () => new Date(SATURDAY),
        repo,
        transport: { run: async () => ({ code: 0, stdout: '' }) },
      });
      assert.equal(real, 4);
      assert.match(capture.out.join(''), /origin\/main|HEAD/i);
    } finally {
      capture.restore();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
