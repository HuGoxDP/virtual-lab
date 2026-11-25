// scripts/test/selfhost-interrupt.test.mjs
//
// HO1d (MS-1, AC-12): Ctrl+C tears the check down, a second Ctrl+C stops at
// once. D3 - runCheck({signal}) yields between steps and observes the abort
// (yield-then-check); an abort ends {ok:false, failed:'interrupted'} and the
// normal teardown runs; waitHealthy stops mid-sleep, never waiting out its
// timeout. D4 - installSignalHandlers: first signal aborts + one line, second
// prints the manual command and exit(130); SIGBREAK only on win32. D5 -
// manualTeardownCommand is the exact `cd ... && docker compose -p vl-selfcheck
// ... down -v --remove-orphans`; --keep still wins on abort and prints it.
// D14 - the docs teach Ctrl+C and the manual command. `node --test`, fake
// exec/git/probe/sleep - no Docker, no network, no real signals.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  composeArgs, installSignalHandlers, manualTeardownCommand, runCheck, waitHealthy,
} from '../selfhost-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');

/** Same hand-built tar as selfhost-check.test.mjs: headers with valid checksums. */
function tinyTar(name, content) {
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'latin1');
  header.write('0000644', 100, 'latin1');
  header.write('0000000', 108, 'latin1');
  header.write('0000000', 116, 'latin1');
  header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 'latin1');
  header.write('00000000000 ', 136, 'latin1');
  header.write('        ', 148, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const body = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
  Buffer.from(content).copy(body);
  return Buffer.concat([header, body, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)]);
}

/** A backup directory that passes verifyBackup (same shape as the green-run tests). */
function makeBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-23T00:00:00Z' }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hi')));
  return dir;
}

/**
 * The green-run harness (same shape as selfhost-check.test.mjs), plus an
 * `onCall` hook fired on every exec - a test aborts the signal from inside it,
 * the way a real Ctrl+C lands while a child is running.
 */
function harness({ onCall = () => {} } = {}) {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const seen = [];
  const lines = [];
  let rows = 0;
  let backedUpRows = null;

  const exec = (cmd, args, opts = {}) => {
    const line = [cmd, ...args].join(' ');
    seen.push(line);
    onCall(line);
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8'));
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
      makeBackup(path.join(hostDir, '2026-11-23T00-00-00Z'));
      backedUpRows = rows;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'run') return { status: 0, stdout: '7 passed (2.1s)\n', stderr: '' };
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const probe = async () => ({ status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } });
  const log = l => lines.push(l);
  const cleanup = () => {
    rmSync(lock, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  };
  return { lock, tmpRoot, seen, lines, exec, probe, log, cleanup };
}

// -- D5: manualTeardownCommand - the exact command, same -f files as the up --

test('manualTeardownCommand: cd <cloneDir> && the exact compose down -v (D5)', () => {
  const cloneDir = path.join('tmp', 'vl-selfcheck-x', 'app');
  assert.equal(manualTeardownCommand({ cloneDir }),
    `cd ${cloneDir} && docker ${composeArgs(['down', '-v', '--remove-orphans']).join(' ')}`);
  const plain = manualTeardownCommand({ cloneDir });
  assert.ok(plain.includes('docker compose -p vl-selfcheck'));
  assert.ok(plain.includes('-f docker-compose.yml -f docker-compose.selfcheck.yml'));
  assert.ok(plain.includes('down -v --remove-orphans'));
  assert.ok(!plain.includes('docker-compose.https.yml'), 'plain mode carries no https overlay');
});

test('manualTeardownCommand: https mode appends docker-compose.https.yml last (D5)', () => {
  const cmd = manualTeardownCommand({ https: true, cloneDir: '/tmp/app' });
  assert.equal(cmd, `cd /tmp/app && docker ${composeArgs(['down', '-v', '--remove-orphans'], { https: true }).join(' ')}`);
  assert.ok(cmd.includes('-f docker-compose.yml -f docker-compose.selfcheck.yml -f docker-compose.https.yml down -v --remove-orphans'));
});

// -- D4: installSignalHandlers over a fake process --

/** A fake process: EventEmitter + a platform field. */
function fakeProc(platform) {
  const proc = new EventEmitter();
  proc.platform = platform;
  return proc;
}

test('installSignalHandlers: first SIGINT aborts + one line; second prints the command and exit(130) (DW-2.5)', () => {
  const proc = fakeProc('linux');
  const controller = new AbortController();
  const printed = [];
  const exits = [];
  installSignalHandlers(proc, controller, {
    print: l => printed.push(l), exit: code => exits.push(code), command: () => 'cd /tmp/app && docker compose down',
  });
  assert.equal(controller.signal.aborted, false);
  proc.emit('SIGINT');
  assert.equal(controller.signal.aborted, true, 'the first signal aborts the controller');
  assert.equal(printed.length, 1, 'exactly one line on the first signal');
  assert.match(printed[0], /interrupted/);
  assert.deepEqual(exits, [], 'the first signal does not exit - the normal teardown runs');
  proc.emit('SIGINT');
  assert.equal(printed.length, 2);
  assert.ok(printed[1].includes('cd /tmp/app && docker compose down'), 'the second signal prints the manual command');
  assert.deepEqual(exits, [130], 'the second signal exits 130');
});

test('installSignalHandlers: SIGTERM behaves like SIGINT - the second of either stops (D4)', () => {
  const proc = fakeProc('linux');
  const controller = new AbortController();
  const printed = [];
  const exits = [];
  installSignalHandlers(proc, controller, { print: l => printed.push(l), exit: c => exits.push(c), command: () => 'cmd' });
  proc.emit('SIGTERM');
  assert.equal(controller.signal.aborted, true);
  assert.equal(printed.length, 1);
  proc.emit('SIGINT'); // a second signal of the other kind is still the second
  assert.deepEqual(exits, [130]);
});

test('installSignalHandlers: SIGBREAK is registered only on win32 (DW-2.5)', () => {
  const win = fakeProc('win32');
  const linux = fakeProc('linux');
  installSignalHandlers(win, new AbortController(), { print: () => {}, exit: () => {}, command: () => null });
  installSignalHandlers(linux, new AbortController(), { print: () => {}, exit: () => {}, command: () => null });
  assert.equal(win.listenerCount('SIGBREAK'), 1);
  assert.equal(linux.listenerCount('SIGBREAK'), 0);
  assert.equal(win.listenerCount('SIGINT'), 1);
  assert.equal(win.listenerCount('SIGTERM'), 1);
  assert.equal(linux.listenerCount('SIGINT'), 1);
  assert.equal(linux.listenerCount('SIGTERM'), 1);
});

test('installSignalHandlers: a second signal with nothing to tear down exits 130 without a command line', () => {
  const proc = fakeProc('linux');
  const printed = [];
  const exits = [];
  installSignalHandlers(proc, new AbortController(), { print: l => printed.push(l), exit: c => exits.push(c), command: () => null });
  proc.emit('SIGINT');
  proc.emit('SIGINT');
  assert.equal(printed.length, 1, 'no command line when command() is null');
  assert.deepEqual(exits, [130]);
});

test('installSignalHandlers: a second signal DURING teardown reads command() at that moment (DW-2.5 edge)', () => {
  const proc = fakeProc('linux');
  const printed = [];
  const exits = [];
  let target = null; // becomes known only once the up child runs
  installSignalHandlers(proc, new AbortController(), {
    print: l => printed.push(l), exit: c => exits.push(c), command: () => target,
  });
  proc.emit('SIGINT'); // teardown starts; target not yet known
  target = 'cd /tmp/app && docker compose -p vl-selfcheck down -v --remove-orphans'; // the up child ran meanwhile
  proc.emit('SIGINT'); // second signal mid-teardown: the command is read fresh
  assert.ok(printed[1].includes(target), 'command() must be evaluated on the second signal, not captured at install');
  assert.deepEqual(exits, [130]);
});

// -- D3: waitHealthy with a signal --

test('waitHealthy: an abort mid-sleep resolves at once, never waiting out the timeout (DW-2.1)', async () => {
  const controller = new AbortController();
  let probes = 0;
  let sleeps = 0;
  const probe = async () => { probes += 1; return { status: 503 }; };
  const sleep = ms => new Promise(resolve => {
    sleeps += 1;
    // The abort lands while the sleep is pending, the way Ctrl+C lands mid-wait.
    controller.abort();
    setTimeout(resolve, ms); // a real timer: without early resolution this would hold the full ms
  });
  const started = Date.now();
  const result = await waitHealthy(probe, { baseUrl: 'http://x', timeoutMs: 300_000, sleep, signal: controller.signal, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'interrupted');
  assert.equal(probes, 1, 'no probe after the abort');
  assert.equal(sleeps, 1, 'the sleep was entered, then cut short');
  assert.ok(Date.now() - started < 500, 'the wait must not hold the sleep or the timeout');
});

test('waitHealthy: an already-aborted signal never probes', async () => {
  const controller = new AbortController();
  controller.abort();
  let probes = 0;
  const result = await waitHealthy(async () => { probes += 1; return { status: 200 }; },
    { baseUrl: 'http://x', sleep: async () => {}, signal: controller.signal, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'interrupted');
  assert.equal(probes, 0);
});

test('waitHealthy: an abort wins over a healthy answer in the same attempt', async () => {
  const controller = new AbortController();
  const probe = async () => {
    controller.abort();
    return { status: 200, body: { status: 'ok', db: 'connected', build: { version: '1' } } };
  };
  const result = await waitHealthy(probe, { baseUrl: 'http://x', sleep: async () => {}, signal: controller.signal, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'interrupted');
});

test('waitHealthy: the abort listener is removed on every exit - no accumulation over attempts', async () => {
  const controller = new AbortController();
  let calls = 0;
  const probe = async () => {
    calls += 1;
    return calls < 4
      ? { status: 503 }
      : { status: 200, body: { status: 'ok', db: 'connected', build: { version: '1' } } };
  };
  const result = await waitHealthy(probe, { baseUrl: 'http://x', sleep: async () => {}, signal: controller.signal, log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(controller.signal.listenerCount?.('abort') ?? 0, 0, 'each sleep must remove its abort listener');
});

// -- D3: runCheck checkpoints - an abort at each step boundary --

test('runCheck: an abort inside the up child ends interrupted, both teardown commands run, temp dir gone (DW-2.1)', async () => {
  const controller = new AbortController();
  const h = harness({ onCall: line => { if (line.includes(' up ')) controller.abort(); } });
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log, sleep: async () => {},
      probe: h.probe, signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'interrupted');
    assert.deepEqual(result.steps.map(s => s.name), ['lock', 'port', 'clone', 'env', 'up'], 'stops right after the step where the abort landed');
    const teardown = h.seen.filter(l => l.startsWith('docker update') || l.includes('down -v'));
    assert.equal(teardown.length, 2, 'both teardown commands must run');
    assert.ok(teardown[0].startsWith('docker update --restart=no'), 'restart policy first');
    assert.deepEqual(readdirSync(h.tmpRoot), [], 'the temp dir is gone');
    assert.ok(!h.seen.some(l => l.includes('logs --tail')), 'no logs dump on an interrupt');
  } finally { h.cleanup(); }
});

test('runCheck: an abort inside the health wait ends interrupted without waiting out the timeout (DW-2.1)', async () => {
  const controller = new AbortController();
  const h = harness();
  let sleeps = 0;
  const sleep = ms => new Promise(resolve => {
    sleeps += 1;
    controller.abort(); // Ctrl+C during the health sleep
    setTimeout(resolve, ms);
  });
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log, sleep,
      probe: async () => ({ status: 503 }), healthTimeoutMs: 300_000, signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'interrupted');
    assert.equal(sleeps, 1, 'exactly one sleep, cut short - not the 300s timeout');
    assert.ok(!result.steps.some(s => s.name === 'healthy'), 'no healthy step on an interrupt');
    assert.equal(h.seen.filter(l => l.startsWith('docker update') || l.includes('down -v')).length, 2);
    assert.deepEqual(readdirSync(h.tmpRoot), []);
  } finally { h.cleanup(); }
});

test('runCheck: abort before anything is started - no up, no teardown, no cleanup command printed', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness();
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log, sleep: async () => {},
      probe: h.probe, signal: controller.signal,
    });
    assert.equal(result.ok, false);
    // lock/port are instant and run before anything exists: the abort is
    // observed at the first checkpoint, after the clone step (D3).
    assert.equal(result.failed, 'interrupted');
    assert.ok(!h.seen.some(l => l.includes(' up ') || l.includes('down -v') || l.startsWith('docker update')),
      'no up, no teardown - nothing was started');
    assert.deepEqual(readdirSync(h.tmpRoot), [], 'the temp tree is still cleaned up');
    assert.ok(!h.lines.some(l => l.includes('clean up by hand')), 'no manual command when there is no stack');
  } finally { h.cleanup(); }
});

test('runCheck: a signal arriving between two steps is observed at the next checkpoint', async () => {
  const controller = new AbortController();
  const h = harness();
  const log = l => {
    h.log(l);
    if (l.includes('ok   env')) controller.abort(); // between env and up, outside any child
  };
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log, sleep: async () => {},
      probe: h.probe, signal: controller.signal,
    });
    assert.equal(result.failed, 'interrupted');
    assert.deepEqual(result.steps.map(s => s.name), ['lock', 'port', 'clone', 'env'], 'up never runs');
    assert.ok(!h.seen.some(l => l.includes(' up ')));
    assert.ok(!h.seen.some(l => l.includes('down -v')), 'up was never attempted - no stack to tear down');
    assert.deepEqual(readdirSync(h.tmpRoot), []);
  } finally { h.cleanup(); }
});

test('runCheck: an abort during the clone child stops at the clone checkpoint, no up attempted', async () => {
  const controller = new AbortController();
  const h = harness({ onCall: line => { if (line.startsWith('git clone')) controller.abort(); } });
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log, sleep: async () => {},
      probe: h.probe, signal: controller.signal,
    });
    assert.equal(result.failed, 'interrupted');
    assert.deepEqual(result.steps.map(s => s.name), ['lock', 'port', 'clone']);
    assert.ok(!h.seen.some(l => l.includes(' up ') || l.includes('down -v')), 'nothing started - no teardown');
    assert.deepEqual(readdirSync(h.tmpRoot), []);
  } finally { h.cleanup(); }
});

test('runCheck: an abort during the seed child stops at the backup checkpoint, with teardown', async () => {
  const controller = new AbortController();
  const h = harness({ onCall: line => { if (line.includes('INSERT INTO scenarios')) controller.abort(); } });
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log, sleep: async () => {},
      probe: h.probe, signal: controller.signal,
    });
    assert.equal(result.failed, 'interrupted');
    assert.ok(result.steps.some(s => s.name === 'healthy' && s.ok), 'the healthy checkpoint passed before the abort');
    // D3 lists no checkpoint between the seed and the backup run: the
    // synchronous backup sequence finishes and is recorded, then the
    // checkpoint after backup observes the abort - the marker never runs.
    assert.ok(result.steps.some(s => s.name === 'backup' && s.ok));
    assert.ok(!result.steps.some(s => s.name === 'backup marker'));
    assert.ok(!result.steps.some(s => s.name === 'e2e deps'));
    assert.equal(h.seen.filter(l => l.startsWith('docker update') || l.includes('down -v')).length, 2);
    assert.deepEqual(readdirSync(h.tmpRoot), []);
  } finally { h.cleanup(); }
});

test('runCheck: an abort during the backup run stops after the backup step, with teardown', async () => {
  const controller = new AbortController();
  const h = harness({ onCall: line => { if (line.includes('BACKUP_RUN_ONCE=1')) controller.abort(); } });
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log, sleep: async () => {},
      probe: h.probe, signal: controller.signal,
    });
    assert.equal(result.failed, 'interrupted');
    assert.ok(result.steps.some(s => s.name === 'backup' && s.ok));
    assert.ok(!result.steps.some(s => s.name === 'backup marker'));
    assert.deepEqual(readdirSync(h.tmpRoot), []);
  } finally { h.cleanup(); }
});

test('runCheck: an abort during the restore child stops after the marker, named, with teardown', async () => {
  const controller = new AbortController();
  const h = harness({ onCall: line => { if (line.includes('restore.mjs')) controller.abort(); } });
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log, sleep: async () => {},
      probe: h.probe, signal: controller.signal,
    });
    assert.equal(result.failed, 'interrupted');
    assert.ok(result.steps.some(s => s.name === 'backup marker' && s.ok));
    assert.ok(!result.steps.some(s => s.name === 'e2e deps'), 'stops before the e2e steps');
    assert.deepEqual(readdirSync(h.tmpRoot), []);
  } finally { h.cleanup(); }
});

test('runCheck: an abort during e2e deps / e2e browser stops there, named, with teardown', async () => {
  for (const child of [['npm', 'ci'], ['npx', 'playwright']]) {
    const controller = new AbortController();
    const h = harness({ onCall: line => { if (line.startsWith(`${child[0]} ${child[1]}`)) controller.abort(); } });
    try {
      const result = await runCheck({
        lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log, sleep: async () => {},
        probe: h.probe, signal: controller.signal,
      });
      assert.equal(result.failed, 'interrupted');
      assert.ok(!result.steps.some(s => s.name === 'smoke'), 'the smoke never runs after an abort');
      assert.equal(h.seen.filter(l => l.startsWith('docker update') || l.includes('down -v')).length, 2);
      assert.deepEqual(readdirSync(h.tmpRoot), []);
    } finally { h.cleanup(); }
  }
});

// -- D3 + D5: --keep wins on abort --

test('runCheck: keep + abort - no teardown ran, the kept dir survives, the manual command is logged (DW-2.2)', async () => {
  const controller = new AbortController();
  const h = harness({ onCall: line => { if (line.includes(' up ')) controller.abort(); } });
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, keep: true, exec: h.exec, git: h.exec, log: h.log, sleep: async () => {},
      probe: h.probe, signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'interrupted');
    assert.ok(!h.seen.some(l => l.includes('down -v') || l.startsWith('docker update')), '--keep must win: nothing torn down');
    const kept = readdirSync(h.tmpRoot);
    assert.equal(kept.length, 1, 'the kept dir survives');
    const cloneDir = path.join(h.tmpRoot, kept[0], 'app');
    const expected = manualTeardownCommand({ https: false, cloneDir });
    assert.ok(h.lines.includes(`  --   clean up by hand: ${expected}`), `a logged line must carry the manual command:\n${h.lines.join('\n')}`);
    assert.ok(expected.includes('docker compose -p vl-selfcheck'));
    assert.ok(expected.includes('down -v'));
  } finally { h.cleanup(); }
});

test('runCheck: keep + abort in https mode logs the command WITH the https overlay (DW-2.2)', async () => {
  const controller = new AbortController();
  const h = harness({ onCall: line => { if (line.includes(' up ')) controller.abort(); } });
  const probe = async url => url.startsWith('https://')
    ? { status: 200, headers: { 'strict-transport-security': 'max-age=31536000' }, body: { status: 'ok', db: 'connected', build: { version: '1' } } }
    : { status: 301, headers: { location: url.replace(/^http:/, 'https:').replace(/:8051/, ':8462') } };
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, keep: true, https: true, httpsPort: 8462,
      exec: h.exec, git: h.exec, log: h.log, sleep: async () => {}, probe, signal: controller.signal,
    });
    assert.equal(result.failed, 'interrupted');
    const kept = readdirSync(h.tmpRoot);
    const expected = manualTeardownCommand({ https: true, cloneDir: path.join(h.tmpRoot, kept[0], 'app') });
    assert.ok(h.lines.includes(`  --   clean up by hand: ${expected}`));
    assert.ok(expected.includes('docker-compose.https.yml'));
    assert.ok(!h.seen.some(l => l.includes('down -v')));
  } finally { h.cleanup(); }
});

// -- U-3: a run without a signal is exactly today's run --

test('runCheck: without a signal the green run still walks all 12 steps and tears down (U-3)', async () => {
  const h = harness();
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log, sleep: async () => {}, probe: h.probe,
    });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    assert.deepEqual(result.steps.map(s => s.name), [
      'lock', 'port', 'clone', 'env', 'up', 'healthy', 'backup', 'backup marker', 'restore', 'e2e deps', 'e2e browser', 'smoke',
    ]);
    assert.equal(h.seen.filter(l => l.startsWith('docker update') || l.includes('down -v')).length, 2);
    assert.deepEqual(readdirSync(h.tmpRoot), []);
  } finally { h.cleanup(); }
});

// -- DW-2.3: importing the module registers no handler --

test('importing selfhost-check.mjs registers no signal handler (DW-2.3)', async () => {
  const before = ['SIGINT', 'SIGTERM', 'SIGBREAK'].map(s => process.listenerCount(s));
  await import('../selfhost-check.mjs');
  const after = ['SIGINT', 'SIGTERM', 'SIGBREAK'].map(s => process.listenerCount(s));
  assert.deepEqual(after, before);
});

// -- DW-2.6: the docs teach Ctrl+C and the manual command --

test('self-host doc: the «Перевірка» section describes Ctrl+C and shows the manual teardown command (DW-2.6)', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs', 'self-host.md'), 'utf8');
  const start = doc.indexOf('## Перевірка');
  assert.notEqual(start, -1);
  const rest = doc.slice(start + 1);
  const next = rest.search(/^## /m);
  const section = next === -1 ? doc.slice(start) : doc.slice(start, start + 1 + next);
  assert.match(section, /Ctrl\+C/, 'Ctrl+C must be described');
  assert.match(section, /interrupted/, 'the named interrupted result must be stated');
  assert.match(section, /130/, 'the second Ctrl+C exit code must be stated');
  assert.match(section, /docker compose -p vl-selfcheck/, 'the manual command must be shown');
  assert.match(section, /down -v --remove-orphans/);
  // The doc rule (selfhost-doc.test.mjs): «без HTTPS» within the 4 lines above
  // every explicit -f command that omits the https overlay.
  const lines = section.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('docker compose') || !/-f docker-compose/.test(lines[i])) continue;
    if (/docker-compose\.https\.yml/.test(lines[i])) continue;
    const context = lines.slice(Math.max(0, i - 4), i).join('\n');
    assert.match(context, /без\s+HTTPS/i, `«без HTTPS» must stand within 4 lines above: ${lines[i].trim()}`);
  }
});

// -- sanity: the teardown command's compose files exist in the repo --

test('manualTeardownCommand names only compose files that exist', () => {
  for (const file of ['docker-compose.yml', 'docker-compose.selfcheck.yml', 'docker-compose.https.yml']) {
    assert.ok(existsSync(path.join(REPO_ROOT, file)), `${file} must exist`);
  }
});
