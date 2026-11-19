// scripts/test/selfhost-check.test.mjs
//
// The check driver's pure parts: argument parsing, `.env` generation, the port
// probe, compose argument assembly, health judging, the wait loop, teardown
// order, and the driver itself over injected exec/probe (no Docker, no git, no
// network). `node --test`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  buildEnv, COMPOSE_INTERPOLATED, composeArgs, DEFAULT_PORT, generateSecrets, judgeHealth, parseArgs,
  portFree, PROJECT, runCheck, scrubComposeEnv, teardownCommands, waitHealthy,
} from '../selfhost-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * A tar with one file entry, hand-built: the checks in verify-backup only need
 * headers with valid checksums and a size field.
 */
function tinyTar(name, content) {
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'latin1');
  header.write('0000644', 100, 'latin1');
  header.write('0000000', 108, 'latin1');
  header.write('0000000', 116, 'latin1');
  header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 'latin1');
  header.write('00000000000 ', 136, 'latin1');
  header.write('        ', 148, 'latin1'); // checksum field as spaces while summing
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');

  const body = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
  Buffer.from(content).copy(body);
  return Buffer.concat([header, body, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)]);
}

/** A backup directory that must pass verifyBackup. */
function makeBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z' }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hi')));
  return dir;
}

test('parseArgs: defaults, and every flag with its value', () => {
  assert.deepEqual(parseArgs([]), { ref: 'main', source: null, port: DEFAULT_PORT, https: false, lock: null, keep: false, help: false });
  assert.deepEqual(parseArgs(['--ref', 'HO1', '--source', '.', '--frontend-port', '8060', '--lock', '/l', '--keep']),
    { ref: 'HO1', source: '.', port: 8060, https: false, lock: '/l', keep: true, help: false });
  assert.equal(parseArgs(['--help']).help, true);
});

test('parseArgs: a typo is a refusal, not a silently ignored flag', () => {
  assert.throws(() => parseArgs(['--frontend_prot', '8051']), /unknown argument/);
  assert.throws(() => parseArgs(['--lock']), /needs a value/);
  assert.throws(() => parseArgs(['--ref', '--keep']), /needs a value/);
  assert.throws(() => parseArgs(['--frontend-port', 'eighty']), /must be a port number/);
  assert.throws(() => parseArgs(['--frontend-port', '70000']), /must be a port number/);
});

test('buildEnv: copies the template verbatim except the four values the check owns', () => {
  const template = readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8');
  const { text, changed } = buildEnv(template, {
    dbPassword: 'pw-from-check', adminToken: 'token-from-check', frontendPort: 8061, backupDir: '/tmp/backups',
  });

  assert.deepEqual(changed.sort(), ['ADMIN_TOKEN', 'BACKUP_DIR', 'DB_PASSWORD', 'FRONTEND_PORT']);
  assert.match(text, /^DB_PASSWORD=pw-from-check$/m);
  assert.match(text, /^ADMIN_TOKEN=token-from-check$/m);
  assert.match(text, /^FRONTEND_PORT=8061$/m);
  assert.match(text, /^BACKUP_DIR=\/tmp\/backups$/m);

  // Everything else survives byte for byte: DB_NAME, the comments, the LTI block.
  assert.match(text, /^DB_NAME=virtual_lab$/m);
  assert.match(text, /^DB_USER=lab_user$/m);
  // BACKUP_DIR is not a template line (compose defaults it) — it is appended
  // before the file's final newline, so the output still ends in one.
  const templateLines = template.split(/\r?\n/);
  const outLines = text.split(/\r?\n/);
  assert.equal(outLines.length, templateLines.length + 1);
  assert.equal(outLines[outLines.length - 1], '');
  assert.equal(outLines[outLines.length - 2], 'BACKUP_DIR=/tmp/backups');
  assert.deepEqual(outLines.slice(0, templateLines.length - 1).filter((l, i) => !/^(DB_PASSWORD|ADMIN_TOKEN|FRONTEND_PORT)=/.test(templateLines[i])),
    templateLines.slice(0, templateLines.length - 1).filter(l => !/^(DB_PASSWORD|ADMIN_TOKEN|FRONTEND_PORT)=/.test(l)));
});

test('buildEnv: DEFAULT_PORT is not the lab stack’s 8044', () => {
  assert.notEqual(DEFAULT_PORT, 8044);
  assert.notEqual(DEFAULT_PORT, 8045);
  assert.notEqual(DEFAULT_PORT, 8046);
});

test('generateSecrets: 32 random bytes hex, never equal to each other', () => {
  const a = generateSecrets();
  const b = generateSecrets();
  assert.match(a.dbPassword, /^[0-9a-f]{64}$/);
  assert.match(a.adminToken, /^[0-9a-f]{64}$/);
  assert.notEqual(a.dbPassword, a.adminToken);
  assert.notEqual(a.dbPassword, b.dbPassword);
});

test('runCheck never returns either secret in its result (a check must not print what it generated)', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  let seenEnv = null;

  // A clone that fails at `up`: enough to reach the .env write, with the .env.example
  // copied from this checkout.
  const exec = (cmd, args, opts = {}) => {
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'git') return { status: 0, stdout: 'abc1234\n', stderr: '' };
    if (opts.cwd) {
      try { seenEnv = readFileSync(path.join(opts.cwd, '.env'), 'utf8'); } catch { /* teardown */ }
    }
    return { status: 1, stdout: '', stderr: 'boom' };
  };

  const result = await runCheck({ lock, tmpRoot, exec, git: exec, log: () => {}, probe: async () => ({ status: 500 }) });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 'up');

  const dump = JSON.stringify(result);
  assert.ok(seenEnv, 'the .env was written');
  const dbPassword = /^DB_PASSWORD=(.*)$/m.exec(seenEnv)[1];
  const adminToken = /^ADMIN_TOKEN=(.*)$/m.exec(seenEnv)[1];
  assert.ok(!dump.includes(dbPassword), 'the db password leaked into the result');
  assert.ok(!dump.includes(adminToken), 'the admin token leaked into the result');

  rmSync(lock, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('portFree: false for a bound port, true for a free one', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const taken = server.address().port;
  try {
    assert.equal(await portFree(taken), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(await portFree(taken), true);
});

test('composeArgs: both -f files, the project name, then the subcommand', () => {
  const args = composeArgs(['up', '-d', '--build']);
  assert.deepEqual(args, [
    'compose', '-p', PROJECT, '-f', 'docker-compose.yml', '-f', 'docker-compose.selfcheck.yml',
    'up', '-d', '--build',
  ]);
  assert.notEqual(PROJECT, 'virtual-lab');
});

test('teardownCommands: the restart policy is disabled before anything is removed', () => {
  const commands = teardownCommands();
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].slice(0, 3), ['docker', 'update', '--restart=no']);
  assert.ok(commands[0].includes('VLCheckFrontend'));
  assert.ok(commands[1].includes('down'));
  assert.ok(commands[1].includes('-v'));
  assert.ok(commands[1].includes('--remove-orphans'));
});

test('judgeHealth: names the half that is wrong', () => {
  assert.deepEqual(judgeHealth({ status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } }),
    { ok: true, reason: 'api 1.0.0' });
  assert.equal(judgeHealth({ status: 200, body: { status: 'ok', db: 'disconnected', build: { version: '1' } } }).ok, false);
  assert.match(judgeHealth({ status: 200, body: { status: 'ok', db: 'disconnected', build: { version: '1' } } }).reason, /db=/);
  assert.equal(judgeHealth({ status: 503, body: {} }).ok, false);
  assert.equal(judgeHealth({ status: 200, body: { status: 'ok', db: 'connected' } }).ok, false);
  assert.equal(judgeHealth({}).ok, false);
});

test('waitHealthy: polls until healthy, one logged line per attempt', async () => {
  const lines = [];
  let calls = 0;
  const probe = async () => {
    calls += 1;
    return calls < 3
      ? { status: 200, body: { status: 'ok', db: 'disconnected' } }
      : { status: 200, body: { status: 'ok', db: 'connected', build: { version: '9' } } };
  };
  const result = await waitHealthy(probe, { baseUrl: 'http://x', sleep: async () => {}, log: l => lines.push(l) });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.equal(lines.length, 3);
});

test('waitHealthy: a thrown probe is a failed attempt, not a crash', async () => {
  let calls = 0;
  const result = await waitHealthy(async () => { calls += 1; throw new Error('ECONNREFUSED'); },
    { baseUrl: 'http://x', timeoutMs: 2500, sleep: async () => {}, log: () => {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ECONNREFUSED/);
  assert.ok(calls > 1);
});

test('runCheck: a missing lock is a refusal before anything is cloned or started', async () => {
  const calls = [];
  const result = await runCheck({
    lock: path.join(os.tmpdir(), 'vl-lock-that-is-not-there'),
    exec: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; },
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 'lock');
  assert.deepEqual(calls, []);
});

test('runCheck: no lock at all is the same refusal (the check never runs unlocked)', async () => {
  const result = await runCheck({ lock: null, exec: () => { throw new Error('must not run'); }, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 'lock');
});

test('runCheck: a port that is taken refuses before the clone', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const taken = server.address().port;
  const calls = [];
  try {
    const result = await runCheck({
      lock, port: taken, log: () => {},
      exec: (cmd, args) => { calls.push(cmd); return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'port');
    assert.deepEqual(calls, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(lock, { recursive: true, force: true });
  }
});

test('runCheck: a green run walks every step and tears the stack down', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const seen = [];

  // P5b D6: the restore step's one-row database. psql INSERT seeds the draft
  // proof row, the backup run snapshots it, DELETE removes it, and the
  // restore.mjs run brings the snapshot back (see selfhost-restore.test.mjs
  // for the sequence and proof assertions).
  let rows = 0;
  let backedUpRows = null;

  const exec = (cmd, args, opts = {}) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('psql')) {
      const sql = args.join(' ');
      if (/insert/i.test(sql)) rows += 1;
      else if (/delete/i.test(sql)) rows = 0;
      else if (/select/i.test(sql)) return { status: 0, stdout: `${rows}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('run')) {
      if (args.includes('restore.mjs')) { rows = backedUpRows ?? 0; return { status: 0, stdout: 'restore done\n', stderr: '' }; }
      // The backup service writes into a directory the check mounts; find it in the args.
      const mount = args[args.indexOf('-v') + 1];
      const hostDir = mount.slice(0, mount.lastIndexOf(':'));
      mkdirSync(hostDir, { recursive: true });
      makeBackup(path.join(hostDir, '2026-11-18T00-00-00Z'));
      backedUpRows = rows;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'run') return { status: 0, stdout: '7 passed (2.1s)\n', stderr: '' };
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const result = await runCheck({
    lock, tmpRoot, exec, git: exec, log: () => {}, sleep: async () => {},
    probe: async () => ({ status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } }),
  });

  assert.equal(result.ok, true, `failed at ${result.failed}`);
  // P5b D6: 11 steps + restore (after the marker, before the smoke — the draft
  // proof row is deleted and restored back before the smoke ever runs).
  assert.deepEqual(result.steps.map(s => s.name), [
    'lock', 'port', 'clone', 'env', 'up', 'healthy', 'backup', 'backup marker', 'restore', 'e2e deps', 'e2e browser', 'smoke',
  ]);
  assert.ok(result.steps.every(s => s.ok));

  // Teardown ran: policy first, then down -v, and the temp tree is gone.
  const teardown = seen.filter(line => line.startsWith('docker update') || line.includes('down -v'));
  assert.equal(teardown.length, 2, seen.join('\n'));
  assert.ok(teardown[0].startsWith('docker update --restart=no'));
  const leftovers = (await import('node:fs')).readdirSync(tmpRoot);
  assert.deepEqual(leftovers, [], 'the temp clone dir is removed on a green run');

  rmSync(lock, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('runCheck: a failed smoke is a named failure and still tears down', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const seen = [];
  // P5b D6: the restore step's one-row database (same shape as the green run).
  let rows = 0;
  let backedUpRows = null;

  const exec = (cmd, args) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('psql')) {
      const sql = args.join(' ');
      if (/insert/i.test(sql)) rows += 1;
      else if (/delete/i.test(sql)) rows = 0;
      else if (/select/i.test(sql)) return { status: 0, stdout: `${rows}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('run')) {
      if (args.includes('restore.mjs')) { rows = backedUpRows ?? 0; return { status: 0, stdout: 'restore done\n', stderr: '' }; }
      const mount = args[args.indexOf('-v') + 1];
      const hostDir = mount.slice(0, mount.lastIndexOf(':'));
      mkdirSync(hostDir, { recursive: true });
      makeBackup(path.join(hostDir, '2026-11-18T00-00-00Z'));
      backedUpRows = rows;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'run') return { status: 1, stdout: '1 failed\n', stderr: 'exit 1' };
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const result = await runCheck({
    lock, tmpRoot, exec, git: exec, log: () => {}, sleep: async () => {},
    probe: async () => ({ status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failed, 'smoke');
  assert.ok(seen.some(line => line.includes('down -v')), 'teardown must run after a failure');

  rmSync(lock, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('runCheck --keep leaves the clone and the stack alone', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const seen = [];

  const exec = (cmd, args) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('up')) return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'stop here' };
  };

  const result = await runCheck({
    lock, tmpRoot, keep: true, exec, git: exec, log: () => {}, sleep: async () => {}, healthTimeoutMs: 0,
    probe: async () => ({ status: 503, body: {} }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 'healthy'); // the stack came up, then failed health — --keep must leave it for inspection
  assert.ok(!seen.some(line => line.includes('down -v')), '--keep must not tear down');
  assert.equal((await import('node:fs')).readdirSync(tmpRoot).length, 1, 'the temp dir survives --keep');

  rmSync(lock, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── D1: teardown whenever up was attempted, even when up itself failed ──

test('runCheck: a failed up still tears down before the clone is removed', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const seen = [];
  let cloneDirAtTeardown = null;

  const exec = (cmd, args, opts = {}) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('up')) return { status: 1, stdout: '', stderr: 'build failed halfway' };
    if (cmd === 'docker' && (args.includes('update') || args.includes('down'))) {
      // Teardown must run while the compose files still exist inside the clone.
      cloneDirAtTeardown = opts.cwd;
      assert.ok(existsSync(path.join(opts.cwd, '.env.example')), 'teardown ran after the clone was removed');
    }
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const result = await runCheck({ lock, tmpRoot, exec, git: exec, log: () => {}, probe: async () => ({ status: 503 }) });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 'up');
  assert.ok(seen.some(line => line.startsWith('docker update --restart=no')), 'restart policy disabled after a failed up');
  assert.ok(seen.some(line => line.includes('down -v')), 'down -v ran after a failed up');
  assert.ok(cloneDirAtTeardown, 'teardown commands were issued');
  assert.deepEqual((await import('node:fs')).readdirSync(tmpRoot), [], 'the temp clone is removed after teardown');

  rmSync(lock, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('runCheck: an up that throws (timeout) still tears down', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const seen = [];

  const exec = (cmd, args) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('up')) throw new Error('spawnSync docker ETIMEDOUT');
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const result = await runCheck({ lock, tmpRoot, exec, git: exec, log: () => {} });
  assert.equal(result.ok, false);
  assert.match(result.failed, /ETIMEDOUT/);
  assert.ok(seen.some(line => line.includes('down -v')), 'a timed-out up can leave containers — teardown must still run');

  rmSync(lock, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── D6: a regular file is not a lock directory ──

test('runCheck: a regular-file lock is a refusal before anything is cloned or started', async () => {
  const lockFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'vl-lockfile-')), 'vl-db.lock');
  writeFileSync(lockFile, 'not a directory');
  const calls = [];
  const result = await runCheck({
    lock: lockFile,
    exec: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; },
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 'lock');
  assert.deepEqual(calls, []);
  rmSync(path.dirname(lockFile), { recursive: true, force: true });
});

// ── D7: compose-interpolated vars never reach a docker child from the shell ──

test('scrubComposeEnv: removes every interpolated name, keeps everything else, never mutates the input', () => {
  const env = { PATH: '/usr/bin', SystemRoot: 'C:\\Windows', HOME: '/home/u' };
  for (const name of COMPOSE_INTERPOLATED) env[name] = `secret-${name}`;
  const scrubbed = scrubComposeEnv(env);
  for (const name of COMPOSE_INTERPOLATED) assert.ok(!(name in scrubbed), `${name} survived the scrub`);
  assert.equal(scrubbed.PATH, '/usr/bin');
  assert.equal(scrubbed.SystemRoot, 'C:\\Windows');
  assert.equal(scrubbed.HOME, '/home/u');
  assert.equal(env.FRONTEND_PORT, 'secret-FRONTEND_PORT', 'the input env is not mutated');
});

test('COMPOSE_INTERPOLATED covers every ${…} the compose files interpolate', () => {
  const text = ['docker-compose.yml', 'docker-compose.selfcheck.yml']
    .map(file => readFileSync(path.join(HERE, '..', '..', file), 'utf8')).join('\n');
  const interpolated = [...new Set([...text.matchAll(/\$\{([A-Z0-9_]+)/g)].map(m => m[1]))];
  for (const name of interpolated) assert.ok(COMPOSE_INTERPOLATED.includes(name), `${name} is interpolated but not scrubbed`);
});

test('runCheck: every docker child runs with the compose vars scrubbed from its env', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const dockerEnvs = [];
  const saved = {};
  // Poison the shell env the way an operator's exported .env would.
  for (const name of ['FRONTEND_PORT', 'DB_PASSWORD', 'ADMIN_TOKEN']) {
    saved[name] = process.env[name];
    process.env[name] = `poison-${name}`;
  }

  const exec = (cmd, args, opts = {}) => {
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker') dockerEnvs.push(opts.env ?? null);
    if (cmd === 'docker' && args.includes('up')) return { status: 1, stdout: '', stderr: 'stop after up' };
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  try {
    const result = await runCheck({ lock, tmpRoot, exec, git: exec, log: () => {} });
    assert.equal(result.failed, 'up');
    assert.ok(dockerEnvs.length >= 3, 'up plus both teardown commands ran');
    for (const env of dockerEnvs) {
      assert.ok(env, 'a docker child ran without an explicit env');
      for (const name of COMPOSE_INTERPOLATED) assert.ok(!(name in env), `${name} reached a docker child`);
      assert.ok(env.PATH, 'PATH survives the scrub');
    }
    // The explicit -e flags on the backup run are compose args, not env: untouched.
    assert.ok(!JSON.stringify(result).includes('poison-'), 'no scrubbed value is printed');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(lock, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── P5b D1: --https selects the https overlay, owns HTTPS_PORT end to end ──

test('parseArgs: --https is a boolean flag, default false, composes with the rest', () => {
  assert.equal(parseArgs([]).https, false);
  assert.equal(parseArgs(['--https']).https, true);
  assert.deepEqual(parseArgs(['--https', '--frontend-port', '8060', '--lock', '/l']),
    { ref: 'main', source: null, port: 8060, https: true, lock: '/l', keep: false, help: false });
});

test('composeArgs: --https adds the https overlay after base + selfcheck', () => {
  assert.deepEqual(composeArgs(['up', '-d', '--build'], { https: true }), [
    'compose', '-p', PROJECT, '-f', 'docker-compose.yml', '-f', 'docker-compose.selfcheck.yml',
    '-f', 'docker-compose.https.yml', 'up', '-d', '--build',
  ]);
  // Plain mode is unchanged (the pinned plain array above stays the contract).
  assert.deepEqual(composeArgs(['up'], { https: false }), composeArgs(['up']));
});

test('buildEnv: https mode owns HTTPS_PORT too — five replaced keys, appended before the final newline', () => {
  const template = readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8');
  const { text, changed } = buildEnv(template, {
    dbPassword: 'pw', adminToken: 'tok', frontendPort: 8061, backupDir: '/tmp/backups', httpsPort: 8462,
  });
  assert.deepEqual(changed.sort(), ['ADMIN_TOKEN', 'BACKUP_DIR', 'DB_PASSWORD', 'FRONTEND_PORT', 'HTTPS_PORT']);
  assert.match(text, /^HTTPS_PORT=8462$/m);
  const outLines = text.split(/\r?\n/);
  assert.equal(outLines[outLines.length - 1], '', 'the file still ends in a newline');
  assert.equal(outLines[outLines.length - 2], 'HTTPS_PORT=8462');
});

test('runCheck --https: the bind check holds the default 8443 too — the overlay’s own default', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(8443, '127.0.0.1', resolve);
    });
  } catch {
    // 8443 is held by something else on this host — the check cannot run on it
    // either way; skipping keeps the suite honest without weakening anything.
    rmSync(lock, { recursive: true, force: true });
    return;
  }
  const calls = [];
  try {
    const result = await runCheck({
      lock, https: true, log: () => {},
      exec: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; },
      git: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; },
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'port');
    assert.deepEqual(calls, [], 'nothing cloned while the https port is taken');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(lock, { recursive: true, force: true });
  }
});

test('COMPOSE_INTERPOLATED covers every ${…} in docker-compose.https.yml too (HTTPS_PORT, HTTPS_REDIRECT_PORT)', () => {
  const text = readFileSync(path.join(HERE, '..', '..', 'docker-compose.https.yml'), 'utf8');
  const interpolated = [...new Set([...text.matchAll(/\$\{([A-Z0-9_]+)/g)].map(m => m[1]))];
  assert.ok(interpolated.includes('HTTPS_PORT'), 'the https overlay interpolates HTTPS_PORT');
  for (const name of interpolated) assert.ok(COMPOSE_INTERPOLATED.includes(name), `${name} is interpolated but not scrubbed`);
  // D2's redirect port is interpolated by the overlay as well.
  assert.ok(COMPOSE_INTERPOLATED.includes('HTTPS_REDIRECT_PORT'), 'HTTPS_REDIRECT_PORT must be scrubbed');
});

test('runCheck --https: a bound HTTPS port refuses before the clone, even with the plain port free', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const taken = server.address().port;
  const calls = [];
  try {
    const result = await runCheck({
      lock, https: true, httpsPort: taken, log: () => {},
      exec: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; },
      git: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; },
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'port');
    assert.deepEqual(calls, [], 'both ports are checked before anything is cloned');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(lock, { recursive: true, force: true });
  }
});

/**
 * The https green-run harness: same shape as the plain green run, plus the
 * one-row database the restore step proves (psql INSERT/DELETE/SELECT), the
 * https redirect/HSTS answers, and recording of every docker child's args/env
 * and the smoke child's env. Returns the runCheck opts and the recorders.
 */
function httpsHarness() {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const seen = [];
  const dockerEnvs = [];
  const smokeEnvs = [];
  const probedUrls = [];
  let envText = null;
  let rows = 0;
  let backedUpRows = null;

  const exec = (cmd, args, opts = {}) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker') {
      dockerEnvs.push(opts.env ?? null);
      if (args.includes('psql')) {
        const sql = args.join(' ');
        if (/insert/i.test(sql)) rows += 1;
        else if (/delete/i.test(sql)) rows = 0;
        else if (/select/i.test(sql)) return { status: 0, stdout: `${rows}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args.includes('run')) {
        if (args.includes('restore.mjs')) { rows = backedUpRows ?? 0; return { status: 0, stdout: 'restore done\n', stderr: '' }; }
        const mount = args[args.indexOf('-v') + 1];
        const hostDir = mount.slice(0, mount.lastIndexOf(':'));
        mkdirSync(hostDir, { recursive: true });
        makeBackup(path.join(hostDir, '2026-11-18T00-00-00Z'));
        backedUpRows = rows;
        return { status: 0, stdout: '', stderr: '' };
      }
    }
    if (cmd === 'npm' && args[0] === 'ci' && opts.cwd) {
      try { envText = readFileSync(path.join(path.dirname(opts.cwd), '.env'), 'utf8'); } catch { /* teardown */ }
    }
    if (cmd === 'npm' && args[0] === 'run') {
      smokeEnvs.push(opts.env ?? null);
      return { status: 0, stdout: '7 passed (2.1s)\n', stderr: '' };
    }
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const probe = async url => {
    probedUrls.push(url);
    if (url.startsWith('https://')) {
      return { status: 200, headers: { 'strict-transport-security': 'max-age=31536000; includeSubDomains' }, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } };
    }
    // With the redirect include active EVERY plain request answers 301 —
    // /api/health included. That is why the https-mode health wait must move
    // to the TLS base (pinned by the probe-urls test below).
    return { status: 301, headers: { location: url.replace(/^http:/, 'https:').replace(/:8051/, ':8462') } };
  };

  const cleanup = () => {
    rmSync(lock, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  };
  return { lock, tmpRoot, seen, dockerEnvs, smokeEnvs, probedUrls, envText: () => envText, exec, probe, cleanup };
}

test('runCheck --https: a green run walks 13 steps — https after healthy, restore after the marker', async () => {
  const h = httpsHarness();
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, https: true, httpsPort: 8462, healthTimeoutMs: 2000,
      exec: h.exec, git: h.exec, log: () => {}, sleep: async () => {}, probe: h.probe,
    });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    assert.deepEqual(result.steps.map(s => s.name), [
      'lock', 'port', 'clone', 'env', 'up', 'healthy', 'https', 'backup', 'backup marker', 'restore', 'e2e deps', 'e2e browser', 'smoke',
    ]);
    assert.ok(result.steps.every(s => s.ok));
    // Every docker compose child carries the https overlay.
    for (const line of h.seen.filter(l => l.startsWith('docker compose'))) {
      assert.ok(line.includes('-f docker-compose.https.yml'), `overlay missing from: ${line}`);
    }
    // Teardown still ran, temp tree gone.
    assert.equal(h.seen.filter(l => l.startsWith('docker update') || l.includes('down -v')).length, 2);
    assert.deepEqual((await import('node:fs')).readdirSync(h.tmpRoot), []);
  } finally { h.cleanup(); }
});

test('runCheck --https: the env write owns HTTPS_PORT and every docker child has it scrubbed', async () => {
  const h = httpsHarness();
  const saved = process.env.HTTPS_PORT;
  process.env.HTTPS_PORT = 'poison-HTTPS_PORT';
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, https: true, httpsPort: 8462, healthTimeoutMs: 2000,
      exec: h.exec, git: h.exec, log: () => {}, sleep: async () => {}, probe: h.probe,
    });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    assert.match(h.envText(), /^HTTPS_PORT=8462$/m);
    assert.ok(h.dockerEnvs.length >= 3);
    for (const env of h.dockerEnvs) {
      assert.ok(env, 'a docker child ran without an explicit env');
      assert.ok(!('HTTPS_PORT' in env), 'HTTPS_PORT reached a docker child from the shell');
    }
    assert.ok(!JSON.stringify(result).includes('poison-'), 'no scrubbed value is printed');
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PORT; else process.env.HTTPS_PORT = saved;
    h.cleanup();
  }
});

test('runCheck --https: the https step probes the redirect and HSTS on both listeners', async () => {
  const h = httpsHarness();
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, https: true, httpsPort: 8462, healthTimeoutMs: 2000,
      exec: h.exec, git: h.exec, log: () => {}, sleep: async () => {}, probe: h.probe,
    });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    const httpsStep = result.steps.find(s => s.name === 'https');
    assert.ok(httpsStep && httpsStep.ok);
    // Both listeners were probed: the plain one for the redirect, the TLS one
    // for health + HSTS. With the redirect on, plain /api/health answers 301
    // too, so in https mode the health wait itself moves to the TLS base.
    assert.ok(h.probedUrls.some(u => u === 'https://127.0.0.1:8462/api/health'), `health wait must use the TLS base: ${h.probedUrls.join(', ')}`);
    assert.ok(h.probedUrls.some(u => u.startsWith('http://127.0.0.1:8051')), 'the plain listener was probed for the redirect');
  } finally { h.cleanup(); }
});

test('runCheck --https: the smoke child gets the https base URL and NODE_TLS_REJECT_UNAUTHORIZED=0 (D8)', async () => {
  const h = httpsHarness();
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, https: true, httpsPort: 8462, healthTimeoutMs: 2000,
      exec: h.exec, git: h.exec, log: () => {}, sleep: async () => {}, probe: h.probe,
    });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    assert.ok(h.smokeEnvs.length >= 1, 'the smoke ran');
    for (const env of h.smokeEnvs) {
      assert.equal(env.E2E_BASE_URL, 'https://127.0.0.1:8462');
      assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
      assert.match(env.ADMIN_TOKEN, /^[0-9a-f]{64}$/);
    }
  } finally { h.cleanup(); }
});

test('runCheck (plain): the smoke child keeps the http base URL and no TLS override', async () => {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const smokeEnvs = [];
  let rows = 0;
  let backedUpRows = null;
  const exec = (cmd, args, opts = {}) => {
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('psql')) {
      const sql = args.join(' ');
      if (/insert/i.test(sql)) rows += 1;
      else if (/delete/i.test(sql)) rows = 0;
      else if (/select/i.test(sql)) return { status: 0, stdout: `${rows}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('run')) {
      if (args.includes('restore.mjs')) { rows = backedUpRows ?? 0; return { status: 0, stdout: 'restore done\n', stderr: '' }; }
      const mount = args[args.indexOf('-v') + 1];
      const hostDir = mount.slice(0, mount.lastIndexOf(':'));
      mkdirSync(hostDir, { recursive: true });
      makeBackup(path.join(hostDir, '2026-11-18T00-00-00Z'));
      backedUpRows = rows;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'run') { smokeEnvs.push(opts.env ?? null); return { status: 0, stdout: '7 passed\n', stderr: '' }; }
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };
  try {
    const result = await runCheck({
      lock, tmpRoot, exec, git: exec, log: () => {}, sleep: async () => {},
      probe: async () => ({ status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } }),
    });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    assert.ok(smokeEnvs.length >= 1);
    for (const env of smokeEnvs) {
      assert.equal(env.E2E_BASE_URL, `http://127.0.0.1:${DEFAULT_PORT}`);
      assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined, 'plain mode must not disable TLS verification');
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runCheck --https: a stack that does not redirect fails at the https step, named', async () => {
  const h = httpsHarness();
  const noRedirect = async url => {
    if (url.startsWith('https://') || url.endsWith('/api/health')) {
      return { status: 200, headers: { 'strict-transport-security': 'max-age=31536000' }, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } };
    }
    return { status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } }; // plain answers 200, no redirect
  };
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, https: true, httpsPort: 8462, healthTimeoutMs: 2000,
      exec: h.exec, git: h.exec, log: () => {}, sleep: async () => {}, probe: noRedirect,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'https');
    assert.ok(h.seen.some(l => l.includes('down -v')), 'teardown ran after the https failure');
  } finally { h.cleanup(); }
});
