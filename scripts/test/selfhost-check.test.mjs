// scripts/test/selfhost-check.test.mjs
//
// The check driver's pure parts: argument parsing, `.env` generation, the port
// probe, compose argument assembly, health judging, the wait loop, teardown
// order, and the driver itself over injected exec/probe (no Docker, no git, no
// network). `node --test`.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  buildEnv, composeArgs, DEFAULT_PORT, generateSecrets, judgeHealth, parseArgs,
  portFree, PROJECT, runCheck, teardownCommands, waitHealthy,
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
  assert.deepEqual(parseArgs([]), { ref: 'main', source: null, port: DEFAULT_PORT, lock: null, keep: false, help: false });
  assert.deepEqual(parseArgs(['--ref', 'HO1', '--source', '.', '--frontend-port', '8060', '--lock', '/l', '--keep']),
    { ref: 'HO1', source: '.', port: 8060, lock: '/l', keep: true, help: false });
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
    if (cmd === 'git') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: 'abc1234\n', stderr: '' };
    }
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

  const exec = (cmd, args, opts = {}) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('run')) {
      // The backup service writes into a directory the check mounts; find it in the args.
      const mount = args[args.indexOf('-v') + 1];
      const hostDir = mount.slice(0, mount.lastIndexOf(':'));
      mkdirSync(hostDir, { recursive: true });
      makeBackup(path.join(hostDir, '2026-11-18T00-00-00Z'));
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
  assert.deepEqual(result.steps.map(s => s.name), [
    'lock', 'port', 'clone', 'env', 'up', 'healthy', 'backup', 'backup marker', 'e2e deps', 'e2e browser', 'smoke',
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

  const exec = (cmd, args) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('run')) {
      const mount = args[args.indexOf('-v') + 1];
      const hostDir = mount.slice(0, mount.lastIndexOf(':'));
      mkdirSync(hostDir, { recursive: true });
      makeBackup(path.join(hostDir, '2026-11-18T00-00-00Z'));
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
