// ops/deploy/test/steps.test.mjs
//
// OPS1 phase 4 (DW-4.1, DW-4.2), extended in phase 5 for what the rehearsal
// exposed: the release record, the fresh-install path and the streamed upload.
// No server, no Docker: what is proven here is the *order* and the failure
// handling — which is what a rehearsal proves end to end and a unit test can
// prove on every run.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFields, deployPlatform, rollbackRelease, bundleManifest, composeFilesFor, writeBundle } from '../lib/steps.mjs';
import { recordingTransport } from '../lib/transport.mjs';

/** A bundle tar to upload; the step only needs the file to exist. */
const bundleDir = mkdtempSync(path.join(tmpdir(), 'vl-steps-'));
const bundle = path.join(bundleDir, 'bundle.tar.gz');
writeFileSync(bundle, 'not really a tar');

/**
 * What a transport call was, as the step name. A streamed step is a `pipeIn`:
 * with arguments it is the bundle upload, without them it is an image load. The
 * mock releases the stream it was handed — a transport that does not consume it
 * must not leave a read pending after the test (which is what the shipped
 * pipeline's own step would open).
 */
const callName = call => {
  const base = call.script.split(/[\\/]/).pop();
  if (base !== 'pipeIn') return base;
  return call.args?.length ? 'upload-bundle.sh' : 'ship';
};

const CFG = {
  DEPLOY_HOST: 'deploy.example.invalid',
  DEPLOY_USER: 'deployer',
  DEPLOY_KEY: '/keys/k.pem',
  DEPLOY_DOMAIN: 'platform.example.invalid',
  DEPLOY_PATH: '/srv/virtual-lab',
  DEPLOY_PORT: '22',
  DEPLOY_HOSTKEY: '',
  FRONTEND_PORT: '80',
};

const IMAGES = ['virtual-lab/backend:t', 'virtual-lab/frontend:t', 'virtual-lab/backup:t'];
/** Saturday: the deploy window is open. */
const SATURDAY = new Date('2026-11-14T10:00:00Z');
/** Monday 12:00 in Kyiv: outside the window. */
const MONDAY_NOON = new Date('2026-11-16T10:00:00Z');

/** The A commit, as a full sha: the release id is derived from it. */
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const RELEASE_A = 'vl-aaaaaaa';

/** The release record a host that already runs something has. */
const INSTALLED = JSON.stringify({
  current: { id: 'vl-bbbb222', tag: B, commit: B, migrated: true, backup: 'b1' },
  previous: { id: 'vl-aaaa111', tag: A, commit: A, migrated: false },
  history: [],
});
/** A host that has never run a release: the fresh install (R-1). */
const EMPTY = '{"current":null,"previous":null,"history":[]}';

/**
 * A transport that answers the scripts a deploy meets, with the answers each
 * case needs. `options.images` is the per-image `have` answer, so the shipping
 * path is provable without Docker.
 */
function transportFor(options = {}) {
  const {
    // One migration read, unless a case gives more (the "grew" and "shrank" ones).
    migrations = [['001', '002', '003']],
    state = INSTALLED, images = [true, true, true], red = null,
  } = options;
  let migrationReads = 0;
  const transport = recordingTransport((script, args) => {
    const name = script.split(/[\\/]/).pop();
    if (name === 'state.sh' && args[1] === 'read') return { code: 0, stdout: `${state}\n` };
    if (name === 'backup.sh') return {
      code: 0,
      stdout: 'backup_name=2026-11-12T23-00-00Z\nbackup_path=/srv/backups/2026-11-12T23-00-00Z\n',
    };
    if (name === 'verify-backup.sh') return { code: 0, stdout: 'verified=1\ntables=13\n' };
    if (name === 'migrations.sh') {
      migrationReads += 1;
      const set = migrations[migrationReads - 1] ?? migrations[migrations.length - 1];
      return { code: 0, stdout: `migrations=${set.join(',')}\n` };
    }
    if (name === 'have-images.sh') {
      return { code: 0, stdout: args.map((n, i) => `image_${i}_have=${images[i] ? 'true' : 'false'}\n`).join('') };
    }
    if (name === 'wait-healthy.sh' && red === 'waitHealthy') return { code: 1, stdout: 'error=timeout\n' };
    return { code: 0, stdout: 'ok=1\n' };
  });
  // A mock that does not consume the bundle stream must still close it, or the
  // read stays pending long after the step that opened it (seen as an
  // "asynchronous activity after the test ended" error).
  const piped = transport.pipeIn.bind(transport);
  transport.pipeIn = async (readable, fixedCommand, args = []) => {
    readable?.destroy?.();
    return piped(readable, fixedCommand, args);
  };
  return transport;
}

function contextFor(transport, extras = {}) {
  return {
    transport,
    config: CFG,
    commits: { vl: A, ed: null },
    images: IMAGES,
    locks: [],
    now: () => SATURDAY,
    bundlePath: bundle,
    ...extras,
    // After the spread, so a `{now: <instant>}` override is a function again.
    now: () => extras.now ?? SATURDAY,
  };
}

describe('DW-4.1 the happy deploy runs the steps in the gate order', () => {
  it('state(read) → inspect → ship → upload → prepare → backup → verify → migrations(before) → up → waitHealthy → migrations(after) → state(write) → prune', async () => {
    const transport = transportFor();
    const result = await deployPlatform(contextFor(transport));
    assert.ok(result.ok, JSON.stringify(result));
    const names = transport.calls.map(callName);
    assert.deepEqual(names, [
      'state.sh', 'inspect.sh', 'have-images.sh', 'upload-bundle.sh', 'prepare.sh', 'backup.sh',
      'verify-backup.sh', 'migrations.sh', 'up.sh', 'wait-healthy.sh',
      'migrations.sh', 'state.sh', 'prune.sh',
    ]);
  });

  it('the upload comes before prepare, because the .env template travels in the bundle', async () => {
    // A fresh host has no `.env`, and `prepare` makes one from the template the
    // bundle carries: running it first could only ever answer `env=absent`, which
    // is how the rehearsal's first run failed (OPS1 phase 5).
    const transport = transportFor({ state: EMPTY });
    await deployPlatform(contextFor(transport));
    const names = transport.calls.map(callName);
    assert.ok(names.includes('upload-bundle.sh'), 'the bundle was uploaded');
    assert.ok(names.indexOf('prepare.sh') > names.indexOf('upload-bundle.sh'),
      `prepare runs after the upload (${names.join(', ')})`);
  });

  it('the release record is written with what a rollback needs', async () => {
    const transport = transportFor();
    const result = await deployPlatform(contextFor(transport));
    assert.ok(result.ok);
    const writes = transport.calls.filter(c => callName(c) === 'state.sh' && c.args[1] === 'write');
    assert.equal(writes.length, 1);
    // id, tag, commit, migrated, backup — the facts a rollback reads (D-10).
    assert.deepEqual(writes[0].args.slice(2), [
      RELEASE_A, A, A, 'false', '2026-11-12T23-00-00Z',
    ]);
  });

  it('the prune keeps the releases the record names, and never prunes for real', async () => {
    const transport = transportFor();
    await deployPlatform(contextFor(transport));
    const prune = transport.calls.find(c => callName(c) === 'prune.sh');
    assert.equal(prune.args[0], 'dry', 'a deploy never deletes an image');
    // Tags, not release ids: an image is named `repo/service:<tag>`, and keeping
    // ids kept nothing (OPS1 phase 5).
    assert.equal(prune.args[1], `${A},${B}`, 'the current release and the one before');
  });

  it('the compose list is joined for the host the scripts run on', () => {
    const linux = { listSeparator: ':' };
    const windows = { listSeparator: ';' };
    assert.equal(composeFilesFor({ transport: linux }),
      'docker-compose.yml:docker-compose.restore.yml:ops/deploy/compose.release.yml');
    assert.equal(composeFilesFor({ transport: windows }),
      'docker-compose.yml;docker-compose.restore.yml;ops/deploy/compose.release.yml');
    // `db/init.sql` travels in the bundle but is not a `-f` argument: a list
    // containing it is one path that does not exist on any host.
    assert.equal(composeFilesFor({ transport: linux }).includes('init.sql'), false);
  });

  it('the images the host lacks are shipped, the rest are not', async () => {
    const transport = transportFor({ images: [true, false, false] });
    // The ship is injected: a real `docker save` would need the images to exist
    // locally, and what is under test here is *which* images travel and through
    // what command — not Docker's own behaviour.
    const saved = [];
    const result = await deployPlatform(contextFor(transport, {
      save: async name => { saved.push(name); return Readable.from([`image ${name}`]); },
    }));
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(saved, [IMAGES[1], IMAGES[2]], 'the two missing images, in order');
    const piped = transport.calls.filter(c => c.script === 'pipeIn');
    const loads = piped.filter(p => p.fixedCommand === 'gunzip | docker load');
    assert.equal(loads.length, 2, 'the two missing images are shipped');
    const upload = piped.find(p => p.fixedCommand !== 'gunzip | docker load');
    assert.ok(upload, 'the bundle is streamed, not named as a path');
    assert.deepEqual(upload.args, [path.join(CFG.DEPLOY_PATH, 'releases'), RELEASE_A]);
  });

  it('an image the local Docker does not have refuses the ship, naming it', async () => {
    const transport = transportFor({ images: [false, false, false] });
    const result = await deployPlatform(contextFor(transport, {
      save: async () => { throw new Error('Error response from daemon: No such image: virtual-lab/backend:t'); },
    }));
    assert.equal(result.failed, 'ship');
    assert.equal(result.exitCode, 4);
    assert.match(result.reason, /No such image: virtual-lab\/backend:t/);
    const names = transport.calls.map(callName);
    assert.equal(names.includes('up.sh'), false, 'nothing was brought up');
  });

  it('and nothing after `up` runs when an earlier step fails', async () => {
    const transport = transportFor({ red: 'verify' });
    const answer = transport.run.bind(transport);
    transport.run = async (script, args) => (
      script.endsWith('verify-backup.sh')
        ? { code: 1, stdout: 'verify_error=db.sql.gz is not a valid gzip\n' }
        : answer(script, args)
    );
    const result = await deployPlatform(contextFor(transport));
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'verify-backup');
    assert.equal(result.exitCode, 4);
    // Basenames, not substrings: `backup.sh` contains `up.sh`.
    const names = transport.calls.map(callName);
    assert.equal(names.includes('up.sh'), false, 'nothing was brought up');
    assert.equal(names.includes('wait-healthy.sh'), false);
  });

  it('a stack that never becomes healthy rolls back like a red smoke (exit 10)', async () => {
    // The induced failure applies once: the rollback's own wait-healthy must be
    // able to answer, or the rollback would fail for the same reason the deploy
    // did and nothing would be proved.
    let unhealthyCalls = 0;
    const transport = transportFor();
    const answer = transport.run.bind(transport);
    transport.run = async (script, args) => {
      if (callName({ script }) === 'wait-healthy.sh' && unhealthyCalls === 0) {
        unhealthyCalls += 1;
        return { code: 1, stdout: 'error=timeout\n' };
      }
      return answer(script, args);
    };
    const result = await deployPlatform(contextFor(transport));
    assert.equal(result.exitCode, 10);
    assert.equal(result.failed, 'wait-healthy');
    assert.equal(result.rollback, true, 'the stack was replaced, so it has to come back');
    // No "after" migration read is possible, so the database comes back: the
    // backend applies migrations at start and it may have applied some.
    assert.equal(result.needsDbRestore, true);

    const back = await rollbackRelease({
      ...contextFor(transport), previousRelease: result.previousRelease,
      previousCommit: result.previousCommit,
      backupName: result.backupName, needsDb: result.needsDbRestore,
    });
    assert.ok(back.ok, 'the rollback finished');
    assert.ok(transport.calls.some(c => c.script.includes('restore-db.sh')), 'the database was restored');
  });

  it('`up` itself failing is exit 5, and nothing after it runs', async () => {
    const transport = transportFor();
    const answer = transport.run.bind(transport);
    // Basename, never `endsWith`: `backup.sh` ends with `up.sh`, which is how
    // this test first failed the backup instead of the up step.
    transport.run = async (script, args) => (
      callName({ script }) === 'up.sh' ? { code: 1, stdout: 'error=no-release\n' } : answer(script, args)
    );
    const result = await deployPlatform(contextFor(transport));
    assert.equal(result.exitCode, 5, 'failed before up: the running release is untouched');
    assert.equal(result.failed, 'up');
    assert.equal(result.rollback, undefined);
    const names = transport.calls.map(callName);
    assert.equal(names.includes('wait-healthy.sh'), false);
    assert.equal(names.includes('state.sh' ) && names.filter(n => n === 'state.sh').length > 1, false,
      'no state write happened');
  });

  it('the window gate refuses before anything is contacted', async () => {
    const transport = transportFor();
    const result = await deployPlatform(contextFor(transport, { now: MONDAY_NOON }));
    assert.equal(result.failed, 'window');
    assert.equal(result.exitCode, 4);
    assert.equal(transport.calls.length, 0, 'nothing was sent');
  });
});

describe('DW-4.3 a fresh install has nothing to back up', () => {
  it('skips the backup, the verify and the before-migrations, and records it', async () => {
    const transport = transportFor({ state: EMPTY });
    const result = await deployPlatform(contextFor(transport));
    assert.ok(result.ok, JSON.stringify(result));
    const names = transport.calls.map(callName);
    // A fresh install has no "before" to compare against, but the "after" read
    // still happens: the record carries what the release actually applied.
    assert.deepEqual(names, [
      'state.sh', 'inspect.sh', 'have-images.sh', 'upload-bundle.sh', 'prepare.sh',
      'up.sh', 'wait-healthy.sh', 'migrations.sh', 'state.sh', 'prune.sh',
    ]);
    assert.equal(result.backupName, null, 'a fresh install has no backup, and the record says so');
  });

  it('a fresh install never restores a database on a red smoke', async () => {
    const transport = transportFor({ state: EMPTY });
    const result = await deployPlatform({ ...contextFor(transport), red: 'smoke' });
    assert.equal(result.exitCode, 10);
    assert.equal(result.needsDbRestore, false, 'there is no older database to come back to');
    assert.equal(result.previousRelease, null);
  });

  it('a missing bundle is a refusal, not a crash on a stream that cannot open', async () => {
    const transport = transportFor();
    const result = await deployPlatform(contextFor(transport, {
      bundlePath: path.join(tmpdir(), 'vl-no-such-bundle.tar.gz'),
    }));
    assert.equal(result.failed, 'upload-bundle');
    assert.equal(result.exitCode, 4);
    assert.match(result.reason, /release bundle is missing/);
  });
});

describe('DW-4.2 a red smoke rolls back', () => {
  it('with migration growth the rollback restores the database, exit 10', async () => {
    // The migration reads see 001..003 before and 001..004 after: that
    // difference is what a restore answers.
    const transport = transportFor({ migrations: [['001', '002', '003'], ['001', '002', '003', '004']] });
    const result = await deployPlatform({ ...contextFor(transport), red: 'smoke' });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'smoke');
    assert.equal(result.exitCode, 10);
    assert.equal(result.rollback, true);
    assert.equal(result.needsDbRestore, true, 'the deploy migrated, so the database comes back');
    // The rollback goes back to what was running, never to the release that failed.
    assert.equal(result.previousRelease, 'vl-bbbb222');
    assert.equal(result.previousCommit, B, 'the smoke of the rolled-back release pins its commit');

    const back = await rollbackRelease({
      ...contextFor(transport), previousRelease: result.previousRelease,
      previousCommit: result.previousCommit,
      backupName: result.backupName, needsDb: result.needsDbRestore,
    });
    assert.ok(back.ok, 'the rollback finished');
    assert.ok(transport.calls.some(c => c.script.includes('restore-db.sh')), 'the database was restored');
  });

  it('without migration change there is no restore, still exit 10', async () => {
    const transport = transportFor();
    const result = await deployPlatform({ ...contextFor(transport), red: 'smoke' });
    assert.equal(result.exitCode, 10);
    assert.equal(result.needsDbRestore, false);
    const back = await rollbackRelease({
      ...contextFor(transport), previousRelease: result.previousRelease,
      previousCommit: result.previousCommit,
      backupName: result.backupName, needsDb: result.needsDbRestore,
    });
    assert.ok(back.ok);
    assert.equal(transport.calls.filter(c => c.script.includes('restore-db.sh')).length, 0,
      'nothing was restored');
  });

  it('the rollback records the release it came back to', async () => {
    const transport = transportFor();
    const back = await rollbackRelease({
      ...contextFor(transport), previousRelease: 'vl-bbbb222', previousCommit: B,
      backupName: 'b1', needsDb: false,
      previousRecord: { id: 'vl-bbbb222', tag: B, commit: B, migrated: true },
    });
    assert.ok(back.ok);
    const write = transport.calls.find(c => callName(c) === 'state.sh' && c.args[1] === 'write');
    assert.deepEqual(write.args.slice(2), ['vl-bbbb222', B, B, 'false', 'b1'],
      'the record points at the release that is running again');
  });

  it("the rollback's own smoke is red: exit 11 and no further step", async () => {
    const transport = transportFor();
    const back = await rollbackRelease({
      ...contextFor(transport), previousRelease: 'vl-abc', previousCommit: B, backupName: 'b1',
      needsDb: false, redPrevious: true,
    });
    assert.equal(back.ok, false);
    assert.equal(back.exitCode, 11);
    assert.equal(back.failed, 'smoke');
  });

  it('a migration set that shrank is exit 11, and the database comes back', async () => {
    const transport = transportFor({ migrations: [['001', '002', '003'], ['001', '002']] });
    // The read before the deploy sees 001,002,003 and the one after sees only
    // 001,002: the set shrank, which forward-only migrations cannot do, so the
    // deploy is not trusted — the database is restored anyway (DW-4.2), because
    // a schema that lost a migration is the one thing no rollback can fix later.
    const result = await deployPlatform({ ...contextFor(transport), red: 'smoke' });
    assert.equal(result.exitCode, 11);
    assert.equal(result.failed, 'migrations');
    assert.match(result.reason, /migration set shrank/);
    assert.equal(result.rollback, true);
    assert.equal(result.needsDbRestore, true);

    const back = await rollbackRelease({
      ...contextFor(transport), previousRelease: result.previousRelease,
      previousCommit: result.previousCommit,
      backupName: result.backupName, needsDb: result.needsDbRestore,
    });
    assert.ok(back.ok, 'the stack came back');
    assert.ok(transport.calls.some(c => c.script.includes('restore-db.sh')), 'the database was restored');
    const names = transport.calls.map(callName);
    assert.equal(names.includes('prune.sh'), false, 'and nothing was pruned');
    assert.equal(names.filter(n => n === 'migrations.sh').length, 2,
      'the before-migrations read happened and so did the after one');
  });
});

describe('the field parser and the bundle manifest', () => {
  it('reads `key=value` lines and ignores everything else', () => {
    assert.deepEqual(parseFields('a=1\nnoise line\nb=x y\n\n'), { a: '1', b: 'x y' });
  });

  it('writes a bundle tar that outlives the function that made it', () => {
    // The bug the rehearsal's first runs found: the tar was written into the same
    // temp directory the `finally` then deleted, so the bundle was always missing
    // at the upload step (OPS1 phase 5). It exists after the call, and it holds
    // what a release declares.
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const bundle = writeBundle(repo, {
      vlTag: A, vlCommit: A, editor: false, extra: [], edTag: null,
    });
    try {
      assert.ok(existsSync(bundle.path), `${bundle.path} exists after the call`);
      // A POSIX path for the listing: this machine's `tar` reads a drive letter as
      // a remote host (the same rule the bundle writer itself follows).
      const listed = bundle.path
        .replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
        .split(path.sep).join('/');
      const tar = spawnSync('tar', ['-tzf', listed], { encoding: 'utf8', maxBuffer: 1 << 26 });
      assert.equal(tar.status, 0, tar.stderr);
      const members = tar.stdout.trim().split('\n').map(m => m.replace(/^\.\//, ''));
      assert.ok(members.includes('release.env'), 'the release env is in the bundle');
      assert.ok(members.includes('docker-compose.yml'), 'and so are the compose files');
      assert.ok(members.includes('ops/deploy/compose.release.yml'));
      // The env names the release, and never a secret.
      const contents = spawnSync('tar', ['-xzOf', listed, './release.env'], { encoding: 'utf8' });
      assert.match(contents.stdout, new RegExp(`VL_TAG=${A}`));
      assert.doesNotMatch(contents.stdout, /PASSWORD|TOKEN/);
    } finally {
      rmSync(bundle.path, { force: true });
    }
  });

  it('the manifest carries the compose files and the release env', () => {
    const manifest = bundleManifest({ editor: true });
    assert.ok(manifest.compose.includes('nginx/csp-editor.conf'));
    assert.equal(manifest.releaseEnv, 'ops/deploy/release.env');
    assert.equal(bundleManifest({ editor: false }).compose.includes('nginx/editor.conf'), false);
  });
});

after(() => rmSync(bundleDir, { recursive: true, force: true }));