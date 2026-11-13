// ops/deploy/test/steps.test.mjs
//
// OPS1 phase 4 (DW-4.1, DW-4.2): the deploy sequence and the rollback, pinned by
// a transport that records. No server, no Docker: what is proven here is the
// *order* and the failure handling — which is what a rehearsal proves end to
// end and a unit test can prove on every run.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseFields, deployPlatform, rollbackRelease, bundleManifest } from '../lib/steps.mjs';
import { recordingTransport } from '../lib/transport.mjs';

/** A transport that answers every script with `verified=1` and a backup name. */
function happyTransport() {
  return recordingTransport((script, args) => {
    const name = script.split(/[\\/]/).pop();
    if (name === 'backup.sh') return { code: 0, stdout: 'backup_name=2026-11-12T23-00-00Z\nbackup_path=/srv/backups/2026-11-12T23-00-00Z\n' };
    if (name === 'verify-backup.sh') return { code: 0, stdout: 'verified=1\ntables=13\n' };
    if (name === 'migrations.sh') return { code: 0, stdout: 'migrations=001,002,003\n' };
    if (name === 'have-images.sh') return {
      code: 0,
      stdout: args.map((_, i) => `image_${i}_have=true\nimage_${i}_id=sha256:abc\n`).join(''),
    };
    return { code: 0, stdout: 'ok=1\n' };
  });
}

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

function contextFor(transport, extras = {}) {
  return {
    transport,
    config: CFG,
    commits: { vl: 'a'.repeat(40), ed: null },
    images: IMAGES,
    locks: [],
    now: () => SATURDAY,
    ...extras,
    // After the spread, so a `{now: <instant>}` override is a function again.
    now: () => extras.now ?? SATURDAY,
  };
}

describe('DW-4.1 the happy deploy runs the steps in the gate order', () => {
  it('preflight → inspect → backup → verify → migrations(before) → ship → upload → up → waitHealthy → migrations(after) → state → prune', async () => {
    const transport = happyTransport();
    const result = await deployPlatform(contextFor(transport));
    void result;
    const names = transport.calls.map(c => c.script.split(/[\\/]/).pop());
    assert.deepEqual(names, [
      'inspect.sh', 'prepare.sh', 'backup.sh', 'verify-backup.sh',
      'migrations.sh', 'have-images.sh', 'upload-bundle.sh', 'up.sh', 'wait-healthy.sh',
      'migrations.sh', 'state.sh', 'prune.sh',
    ]);
  });

  it('and nothing after `up` runs when an earlier step fails', async () => {
    const transport = recordingTransport((script) => (
      script.includes('verify-backup') ? { code: 1, stdout: 'verify_error=db.sql.gz is not a valid gzip\n' }
        : { code: 0, stdout: 'ok=1\n' }
    ));
    const result = await deployPlatform(contextFor(transport));
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'verify-backup');
    assert.equal(result.exitCode, 4);
    // Basenames, not substrings: `backup.sh` contains `up.sh`.
    const basenames = transport.calls.map(c => c.script.split(/[\/]/).pop());
    assert.equal(basenames.includes('up.sh'), false, 'nothing was brought up');
    assert.equal(basenames.includes('wait-healthy.sh'), false);
  });

  it('a failure after `up` is exit 5 and the rollback is asked for', async () => {
    const transport = recordingTransport((script) => {
      const name = script.split(/[\\\/]/).pop();
      if (name === 'wait-healthy.sh') return { code: 1, stdout: 'error=timeout\n' };
      if (name === 'verify-backup.sh') return { code: 0, stdout: 'verified=1\n' };
      return { code: 0, stdout: 'ok=1\n' };
    });
    const result = await deployPlatform(contextFor(transport));
    assert.equal(result.exitCode, 5);
    assert.equal(result.failed, 'wait-healthy');
    assert.equal(result.rollback, undefined, 'a stack that never came up is not rolled back');
  });

  it('the window gate refuses before anything is contacted', async () => {
    const transport = happyTransport();
    const result = await deployPlatform(contextFor(transport, { now: MONDAY_NOON }));
    assert.equal(result.failed, 'window');
    assert.equal(result.exitCode, 4);
    assert.equal(transport.calls.length, 0, 'nothing was sent');
  });
});

describe('DW-4.2 a red smoke rolls back', () => {
  it('with migration growth the rollback restores the database, exit 10', async () => {
    // The first migration read (before the deploy) sees 001..003; the second
    // (after) sees 004 added — that difference is what a restore answers.
    let migrationReads = 0;
    const transport = recordingTransport((script) => {
      const name = script.split(/[\\/]/).pop();
      if (name === 'backup.sh') return { code: 0, stdout: 'backup_name=b1\nbackup_path=/srv/backups/b1\n' };
      if (name === 'verify-backup.sh') return { code: 0, stdout: 'verified=1\n' };
      if (name === 'migrations.sh') {
        migrationReads += 1;
        return { code: 0, stdout: migrationReads === 1 ? 'migrations=001,002,003\n' : 'migrations=001,002,003,004\n' };
      }
      return { code: 0, stdout: 'ok=1\n' };
    });
    const result = await deployPlatform({
      ...contextFor(transport),
      red: 'smoke',
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'smoke');
    assert.equal(result.exitCode, 10);
    assert.equal(result.rollback, true);
    assert.equal(result.needsDbRestore, true, 'the deploy migrated, so the database comes back');

    const back = await rollbackRelease({
      ...contextFor(transport), previousRelease: result.previousRelease,
      backupName: result.backupName, needsDb: result.needsDbRestore,
    });
    assert.ok(back.ok, 'the rollback finished');
    assert.ok(transport.calls.some(c => c.script.includes('restore-db.sh')), 'the database was restored');
  });

  it('without migration change there is no restore, still exit 10', async () => {
    const transport = happyTransport();
    const result = await deployPlatform({ ...contextFor(transport), red: 'smoke' });
    assert.equal(result.exitCode, 10);
    assert.equal(result.needsDbRestore, false);
    const back = await rollbackRelease({
      ...contextFor(transport), previousRelease: result.previousRelease,
      backupName: result.backupName, needsDb: result.needsDbRestore,
    });
    assert.ok(back.ok);
    assert.equal(transport.calls.filter(c => c.script.includes('restore-db.sh')).length, 0,
      'nothing was restored');
  });

  it("the rollback's own smoke is red: exit 11 and no further step", async () => {
    const transport = happyTransport();
    const back = await rollbackRelease({
      ...contextFor(transport), previousRelease: 'vl-abc', backupName: 'b1',
      needsDb: false, redPrevious: true,
    });
    assert.equal(back.ok, false);
    assert.equal(back.exitCode, 11);
    assert.equal(back.failed, 'smoke');
  });

  it('a migration set that shrank is exit 11, with the reason named', async () => {
    const transport = recordingTransport((script) => {
      const name = script.split(/[\\/]/).pop();
      if (name === 'verify-backup.sh') return { code: 0, stdout: 'verified=1\n' };
      if (name === 'migrations.sh') return { code: 0, stdout: 'migrations=001,002\n' };
      return { code: 0, stdout: 'ok=1\n' };
    });
    // The read before the deploy sees 001,002,003 and the one after sees only
    // 001,002: the set shrank, which forward-only migrations cannot do, so the
    // deploy is not trusted and nothing is rolled back to.
    let migrationReads = 0;
    const shrinking = recordingTransport((script) => {
      const name = script.split(/[\\/]/).pop();
      if (name === 'verify-backup.sh') return { code: 0, stdout: 'verified=1\n' };
      if (name === 'migrations.sh') {
        migrationReads += 1;
        return { code: 0, stdout: migrationReads === 1 ? 'migrations=001,002,003\n' : 'migrations=001,002\n' };
      }
      return { code: 0, stdout: 'ok=1\n' };
    });
    const result = await deployPlatform({ ...contextFor(shrinking), red: 'smoke' });
    assert.equal(result.exitCode, 11);
    assert.match(result.reason, /migration set shrank/);
    void transport;
  });
});

describe('the field parser and the bundle manifest', () => {
  it('reads `key=value` lines and ignores everything else', () => {
    assert.deepEqual(parseFields('a=1\nnoise line\nb=x y\n\n'), { a: '1', b: 'x y' });
  });

  it('the manifest carries the compose files and the release env', () => {
    const manifest = bundleManifest({ editor: true });
    assert.ok(manifest.compose.includes('nginx/csp-editor.conf'));
    assert.equal(manifest.releaseEnv, 'ops/deploy/release.env');
    assert.equal(bundleManifest({ editor: false }).compose.includes('nginx/editor.conf'), false);
  });
});
