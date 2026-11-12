// ops/deploy/test/build.test.mjs
//
// OPS1 phase 2 (DW-2.1..2.6): what a release is made of, and what the images are
// built from. Docker is used where the answer depends on it and *skipped with a
// message* where it is absent — never silently, so a machine without Docker gets
// a gray box that says why rather than a green run that proved nothing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCommands, checkFreshSource, imageIds, saveCommand } from '../lib/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const VL = 'a'.repeat(40);
const ED = 'b'.repeat(40);

const hasDocker = (() => {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('DW-2.1 the release compose runs images, not builds', t => {
  if (!hasDocker) return t.skip('no docker on PATH — the compose assertions run where Docker is');

  it('shows the three platform images with the required tag and pull_policy', () => {
    const json = execFileSync('docker', [
      'compose', '-f', 'docker-compose.yml', '-f', 'ops/deploy/compose.release.yml',
      'config', '--format', 'json',
    ], { cwd: REPO, encoding: 'utf8', env: { ...process.env, VL_TAG: 'abc', VL_COMMIT: 'abc' } });
    const services = JSON.parse(json).services;
    assert.equal(services.backend.image, 'virtual-lab/backend:abc');
    assert.equal(services.frontend.image, 'virtual-lab/frontend:abc');
    assert.equal(services.backup.image, 'virtual-lab/backup:abc');
    assert.equal(services.backend.pull_policy, 'never');
    assert.equal(services.backend.environment.API_COMMIT, 'abc', 'the smoke can name the release');
  });

  it('refuses to configure without VL_TAG, naming the variable', () => {
    assert.throws(() => execFileSync('docker', [
      'compose', '-f', 'docker-compose.yml', '-f', 'ops/deploy/compose.release.yml', 'config',
    ], { cwd: REPO, encoding: 'utf8' }), /VL_TAG/);
  });
});

describe('DW-2.2 the backup service writes inside the container and mounts the host directory', t => {
  if (!hasDocker) return t.skip('no docker on PATH — the compose assertions run where Docker is');

  const config = extra => JSON.parse(execFileSync('docker', [
    'compose', '-f', 'docker-compose.yml', '-f', 'ops/deploy/compose.release.yml',
    'config', '--format', 'json',
  ], { cwd: REPO, encoding: 'utf8', env: { ...process.env, VL_TAG: 'abc', VL_COMMIT: 'abc', ...extra } }))
    .services.backup;

  it('a host backup directory is mounted at the container path the backup writes to', () => {
    const svc = config({ BACKUP_HOST_DIR: '/tmp/vlb' });
    assert.ok(svc.volumes.some(v => v.source === '/tmp/vlb' && v.target === '/backups'));
    // The regression F-4: one name for two things. The container's BACKUP_DIR is
    // fixed, so setting the host variable cannot move where the backup writes
    // *inside* the container any more.
    assert.equal(svc.environment.BACKUP_DIR, '/backups');
    assert.equal(svc.environment.BACKUP_HOST_DIR, '/tmp/vlb');
  });

  it('without the variable the host source is the old default', () => {
    const svc = config({});
    // Compose resolves a relative bind source against the project directory, so
    // the assertion is on the resolved path and not on the literal string.
    const source = svc.volumes.find(v => v.target === '/backups').source;
    const forwardSlashed = source.split('\\').join('/');
    assert.ok(forwardSlashed.endsWith('backup/out'), source);
  });
});

describe('DW-2.4 checkFreshSource', () => {
  /** A throwaway git repository with one commit, to be dirty or fresh at will. */
  function scratchRepo() {
    const dir = mkdtempSync(path.join(tmpdir(), 'vl-fresh-'));
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'one');
    return {
      dir,
      git,
      modify: () => writeFileSync(path.join(dir, 'a.txt'), 'two\n'),
      untrack: () => writeFileSync(path.join(dir, 'b.txt'), 'new\n'),
      ahead: () => writeFileSync(path.join(dir, 'a.txt'), 'three\n'),
    };
  }

  it('refuses a modified file, an untracked file, and a HEAD away from the default', () => {
    const dirty = scratchRepo();
    try {
      dirty.modify();
      assert.equal(checkFreshSource(dirty.dir, 'main').ok, false);
      assert.match(checkFreshSource(dirty.dir, 'main').reason, /uncommitted or untracked/);

      const dust = scratchRepo();
      try {
        dust.untrack();
        assert.equal(checkFreshSource(dust.dir, 'main').ok, false, 'an untracked file is refused too');
      } finally {
        rmSync(dust.dir, { recursive: true, force: true });
      }

      const ahead = scratchRepo();
      try {
        // An untracked file is refused before the HEAD comparison, so a
        // rehearsal that skips the HEAD check still cannot run a dirty tree.
        ahead.ahead();
        assert.equal(checkFreshSource(ahead.dir, 'main', { rehearsal: true }).ok, false);
      } finally {
        rmSync(ahead.dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dirty.dir, { recursive: true, force: true });
    }
  });

  it('passes on a clean tree at the default branch, and rehearsal skips only the HEAD check', () => {
    const clean = scratchRepo();
    const git = (...args) => execFileSync('git', ['-C', clean.dir, ...args], { encoding: 'utf8' });
    try {
      // HEAD is the (unborn-then-born) main; there is no origin/*, so the default
      // comparison is against itself through a tag the test creates.
      git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());
      assert.equal(checkFreshSource(clean.dir, 'main').ok, true);

      // A rehearsal may run an unpushed commit, but never a dirty one.
      clean.ahead();
      git('commit', '-qam', 'three');
      assert.equal(checkFreshSource(clean.dir, 'main').ok, false);
      assert.equal(checkFreshSource(clean.dir, 'main', { rehearsal: true }).ok, true);
    } finally {
      rmSync(clean.dir, { recursive: true, force: true });
    }
  });
});

describe('DW-2.5 buildCommands', () => {
  it('names the three platform images and their exact argv', () => {
    const commands = buildCommands({ vlRepo: REPO, edRepo: REPO, vl: VL, ed: null, editor: false });
    assert.deepEqual(commands.map(c => c.service), ['backend', 'frontend', 'backup']);
    assert.deepEqual(commands[0].argv, [
      'build', '-t', `virtual-lab/backend:${VL}`,
      '--label', `org.opencontainers.image.revision=${VL}`,
      '-f', 'Dockerfile', './backend',
    ]);
    // Dockerfile paths are forward-slashed even on Windows.
    assert.equal(commands[0].argv.at(-2), 'Dockerfile');
    assert.equal(commands[1].argv.at(-2), 'Dockerfile.frontend');
    assert.equal(commands[1].argv.at(-1), '.');
  });

  it('the editor image is built from its own checkout, and only when it ships', () => {
    const without = buildCommands({ vlRepo: REPO, edRepo: '/ed', vl: VL, ed: ED, editor: false });
    assert.equal(without.length, 3);

    const withEditor = buildCommands({ vlRepo: REPO, edRepo: '/ed', vl: VL, ed: ED, editor: true });
    assert.equal(withEditor.length, 4);
    assert.equal(withEditor.at(-1).name, `webengine-editor/editor:${ED}`);
    assert.equal(withEditor.at(-1).argv.at(-1), '/ed');
    // Never through the editor override's build context (research F-8).
    assert.equal(withEditor.at(-1).argv.includes('docker-compose.editor.yml'), false);
  });

  it('saveCommand pipes the images it was given', () => {
    assert.deepEqual(saveCommand(['virtual-lab/backend:x']).argv, ['save', 'virtual-lab/backend:x']);
    assert.match(saveCommand([]).note, /gunzip \| docker load/);
  });
});

describe('imageIds', t => {
  if (!hasDocker) return t.skip('no docker on PATH — image inspection runs where Docker is');

  it('returns one id per named image, in order', () => {
    // hello-world is not present by default; a deliberately absent name must
    // throw rather than invent an id, which is what makes the id meaningful.
    assert.throws(() => imageIds(['virtual-lab/backend:does-not-exist']));
    const id = imageIds(['postgres:16-alpine']);
    assert.match(id[0], /^sha256:[0-9a-f]{64}$/);
  });
});

// DW-2.3 is the one assertion in this file that needs a running stack, and a
// compose stack of virtual-lab needs `vl-db.lock` (two projects cannot share the
// fixed container names). The pipeline itself runs it inside the lock; the unit
// suite here pins the two facts that cost a debug cycle on 2026-11-13:
describe('DW-2.3 the backup writes where the host directory points (the run behind it)', () => {
  it('the host directory reaches the mount from the environment; `-e` is too late', () => {
    // `docker compose run -e BACKUP_HOST_DIR=…` sets the *container's*
    // environment, after compose has resolved the volume source, so the mount
    // still points at the default. The documented runs pass `-v` by hand, which
    // is why research F-4 never showed. The pipeline therefore passes the
    // variable in its own environment, and this test is the memo that says so.
    const mountSees = env => env.BACKUP_HOST_DIR;             // compose's ${VAR:-…}
    const containerGets = (env, runFlags) => runFlags.BACKUP_HOST_DIR ?? env.BACKUP_HOST_DIR;

    assert.equal(mountSees({ BACKUP_HOST_DIR: '/tmp/vlb' }), '/tmp/vlb',
      'in the environment it reaches the mount');
    assert.equal(mountSees(containerGets({}, { BACKUP_HOST_DIR: '/tmp/vlb' })), undefined,
      'in -e it reaches only the container');
    assert.equal(mountSees({}), undefined, 'unset, compose applies its own default');
  });
});
