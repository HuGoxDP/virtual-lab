// scripts/test/selfhost-editor.test.mjs
//
// MS-1 / R3 (D11–D13): `--editor` adds the editor to the throwaway stack under
// VLCheck* names and proves /editor/ answers. NEW file — the existing tests
// stay byte-identical. `node --test`, fake exec/git/probe/sleep: no Docker, no
// git, no network.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  COMPOSE_INTERPOLATED, composeArgs, defaultEditorSource, manualTeardownCommand, parseArgs,
  PROJECT, runCheck, teardownCommands,
} from '../selfhost-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');
const TEMPLATE = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');

const DEFAULTS = { ref: 'main', source: null, port: 8051, https: false, lock: null, keep: false, help: false };
const GREEN_STEPS = [
  'lock', 'port', 'clone', 'env', 'up', 'healthy', 'backup', 'backup marker', 'restore', 'e2e deps', 'e2e browser', 'smoke',
];
const EDITOR_STEPS = [
  'lock', 'port', 'editor-source', 'clone', 'env', 'up', 'healthy', 'editor', 'backup', 'backup marker', 'restore', 'e2e deps', 'e2e browser', 'smoke',
];
const HTTPS_EDITOR_STEPS = [
  'lock', 'port', 'editor-source', 'clone', 'env', 'up', 'healthy', 'https', 'editor', 'backup', 'backup marker', 'restore', 'e2e deps', 'e2e browser', 'smoke',
];
const EDITOR_FILES = ['docker-compose.editor.yml', 'docker-compose.selfcheck-editor.yml'];

/** An ephemeral free port; released before the check binds it. */
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Same hand-built tar as the other selfhost suites: valid headers, one entry. */
function tinyTar(name, content) {
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'latin1');
  header.write('0000644', 100, 'latin1');
  header.write('0000000', 108, 'latin1');
  header.write('0000000', 116, 'latin1');
  header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 'latin1');
  header.write('00000000000 ', 148, 'latin1');
  header.write('        ', 148, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const body = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
  Buffer.from(content).copy(body);
  return Buffer.concat([header, body, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)]);
}

function makeBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-25T00:00:00Z' }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hi')));
  return dir;
}

/** A fake editor checkout: a directory that really contains a Dockerfile. */
function makeEditorSource(root) {
  const dir = mkdtempSync(path.join(root, 'vl-editor-src-'));
  writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:20-alpine\n');
  return dir;
}

/**
 * A full green-run harness (the shape of selfhost-teardown-report.test.mjs)
 * plus: captured child env, captured probe URLs, sleep calls, and an editor
 * answer that can be forced to fail or to recover on the second attempt.
 */
function harness(overrides = {}) {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const editorRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-editors-'));
  const editorSource = makeEditorSource(editorRoot);
  const lines = [];
  const seen = [];
  const probeUrls = [];
  const sleeps = [];
  const fns = {
    downStatus: 0,
    upStatus: 0,
    editorAnswer: 'ok', // 'ok' | 'fail' | 'recover'
    httpsPort: 8443,
    ...overrides,
  };
  let rows = 0;
  let backedUpRows = null;
  let editorProbes = 0;

  const exec = (cmd, args, opts = {}) => {
    seen.push({ line: [cmd, ...args].join(' '), cmd, args, env: opts.env });
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), TEMPLATE);
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
      makeBackup(path.join(hostDir, '2026-11-25T00-00-00Z'));
      backedUpRows = rows;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('update')) return { status: fns.updateStatus ?? 0, stdout: '', stderr: '' };
    if (cmd === 'docker' && args.includes('down')) return { status: fns.downStatus, stdout: '', stderr: '' };
    if (cmd === 'docker' && args.includes('up')) return { status: fns.upStatus, stdout: '', stderr: '' };
    if (cmd === 'npm' && args[0] === 'run' && args.includes('smoke')) return { status: 0, stdout: '7 passed (2.1s)\n', stderr: '' };
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const probe = async (url) => {
    probeUrls.push(url);
    if (url.endsWith('/editor/')) {
      editorProbes += 1;
      if (fns.editorAnswer === 'fail') return { status: 503, body: undefined };
      if (fns.editorAnswer === 'recover' && editorProbes === 1) return { status: 503, body: undefined };
      return { status: 200, body: undefined };
    }
    if (url.startsWith('https://')) {
      return {
        status: 200,
        headers: { 'strict-transport-security': 'max-age=31536000' },
        body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } },
      };
    }
    if (url.endsWith('/')) {
      return { status: 301, headers: { location: `https://127.0.0.1:${fns.httpsPort}/` }, body: undefined };
    }
    return { status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } };
  };

  const sleep = async (ms) => { sleeps.push(ms); };
  const log = line => lines.push(line);
  const run = async (extra = {}) => {
    const port = await freePort();
    let httpsPort = extra.httpsPort;
    if (extra.https && httpsPort === undefined) {
      httpsPort = port;
      while (httpsPort === port) httpsPort = await freePort();
    }
    fns.httpsPort = httpsPort ?? 8443;
    return runCheck({ lock, tmpRoot, exec, git: exec, log, sleep, probe, port, httpsPort: fns.httpsPort, ...extra });
  };
  const cleanup = () => {
    rmSync(lock, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(editorRoot, { recursive: true, force: true });
  };
  return { lock, tmpRoot, editorRoot, editorSource, lines, seen, probeUrls, sleeps, exec, probe, log, run, cleanup };
}

/** The index where the two editor -f files occur adjacently, or -1. */
function editorFilesIndex(argv) {
  return argv.findIndex((value, i) => value === EDITOR_FILES[0]
    && argv[i - 1] === '-f' && argv[i + 1] === '-f' && argv[i + 2] === EDITOR_FILES[1]);
}

// ---- DW-4.5: parseArgs ----

test('DW-4.5: --editor and --editor-source add keys only when their flags are given', () => {
  assert.deepEqual(parseArgs(['--editor']), { ...DEFAULTS, editor: true });
  assert.deepEqual(parseArgs(['--editor', '--editor-source', 'D:/editor']), {
    ...DEFAULTS, editor: true, editorSource: 'D:/editor',
  });
  assert.equal(Object.hasOwn(parseArgs([]), 'editor'), false);
  assert.throws(() => parseArgs(['--editor-source']), /needs a value/);
  assert.throws(() => parseArgs(['--editor-source', '--editor']), /needs a value/);
});

// ---- DW-4.4: the no-flag run is unchanged ----

test('DW-4.4: editor off keeps every default shape deep-equal to today', async () => {
  assert.deepEqual(parseArgs([]), DEFAULTS);
  assert.deepEqual(composeArgs(['up', '-d', '--build']), [
    'compose', '-p', PROJECT, '-f', 'docker-compose.yml', '-f', 'docker-compose.selfcheck.yml', 'up', '-d', '--build',
  ]);
  assert.deepEqual(teardownCommands(), [
    ['docker', 'update', '--restart=no', 'VLCheckDatabase', 'VLCheckBackend', 'VLCheckFrontend', 'VLCheckBackup'],
    ['docker', 'compose', '-p', PROJECT, '-f', 'docker-compose.yml', '-f', 'docker-compose.selfcheck.yml', 'down', '-v', '--remove-orphans'],
  ]);
  assert.deepEqual(Object.keys(parseArgs(['--https'])).sort(), Object.keys(DEFAULTS).sort());

  const h = harness();
  try {
    const result = await h.run();
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    assert.deepEqual(result.steps.map(s => s.name), GREEN_STEPS);
    assert.ok(!h.seen.some(c => c.env && Object.hasOwn(c.env, 'SELFCHECK_EDITOR_SOURCE')));
    assert.ok(!h.probeUrls.some(u => u.endsWith('/editor/')));
  } finally { h.cleanup(); }
});

// ---- DW-4.1: file order, container names, manual command ----

test('DW-4.1: editor -f pair in up/down, VLCheckEditor in update, VLCheck names only', async () => {
  const up = composeArgs(['up', '-d', '--build'], { editor: true });
  const down = teardownCommands({ editor: true })[1];
  assert.ok(editorFilesIndex(up) >= 0, up.join(' '));
  assert.ok(editorFilesIndex(down) >= 0, down.join(' '));

  const update = teardownCommands({ editor: true })[0];
  assert.ok(update.includes('VLCheckEditor'));
  const names = update.slice(update.indexOf('--restart=no') + 1);
  assert.ok(names.length > 0);
  assert.ok(names.every(name => name.startsWith('VLCheck')), names.join(' '));

  const manual = manualTeardownCommand({ editor: true, cloneDir: '/tmp/app' });
  assert.ok(manual.includes(`${EDITOR_FILES[0]} -f ${EDITOR_FILES[1]}`), manual);
  assert.ok(manual.includes('cd /tmp/app && docker compose -p vl-selfcheck'));
  assert.ok(manual.includes('down -v --remove-orphans'));

  const h = harness();
  try {
    const result = await h.run({ editor: true, editorSource: h.editorSource, editorTimeoutMs: 2500 });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    const upLine = h.seen.find(c => c.cmd === 'docker' && c.args.includes('up'));
    const downLine = h.seen.find(c => c.cmd === 'docker' && c.args.includes('down'));
    assert.ok(upLine && editorFilesIndex(upLine.args) >= 0, 'up carries the editor pair');
    assert.ok(downLine && editorFilesIndex(downLine.args) >= 0, 'down carries the editor pair');
  } finally { h.cleanup(); }
});

// ---- DW-4.2: a bad editor source refuses before the clone ----

test('DW-4.2: a missing editor source directory fails named before clone/up', async () => {
  const h = harness();
  try {
    const missing = path.join(h.editorRoot, 'no-such-editor-checkout');
    const result = await h.run({ editor: true, editorSource: missing, editorTimeoutMs: 2500 });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'editor-source');
    assert.deepEqual(result.steps.map(s => s.name), ['lock', 'port', 'editor-source']);
    assert.ok(result.steps[2].detail.includes(missing), result.steps[2].detail);
    assert.ok(!h.seen.some(c => c.line.startsWith('git clone')), 'nothing was cloned');
    assert.ok(!h.seen.some(c => c.line.includes(' up -d ')), 'no compose up');
  } finally { h.cleanup(); }
});

test('DW-4.2: a directory without a Dockerfile is the same named refusal', async () => {
  const h = harness();
  try {
    const empty = mkdtempSync(path.join(h.editorRoot, 'vl-no-dockerfile-'));
    const result = await h.run({ editor: true, editorSource: empty, editorTimeoutMs: 2500 });
    assert.equal(result.failed, 'editor-source');
    assert.ok(result.steps.find(s => s.name === 'editor-source').detail.includes(empty));
    assert.ok(!h.seen.some(c => c.line.includes(' up -d ')), 'no compose up');
  } finally { h.cleanup(); }
});

// ---- DW-4.3: /editor/ that never answers 2xx ----

test('DW-4.3: a non-2xx /editor/ for the whole window fails named and tears down', async () => {
  const h = harness({ editorAnswer: 'fail' });
  try {
    const result = await h.run({ editor: true, editorSource: h.editorSource, editorTimeoutMs: 2500 });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'editor');
    const editorStep = result.steps.find(s => s.name === 'editor');
    assert.equal(editorStep.ok, false);
    assert.match(editorStep.detail, /http 503/, editorStep.detail);
    assert.ok(h.probeUrls.some(u => u.endsWith('/editor/')));
    assert.ok(h.sleeps.length >= 2, 'it retried across the window');
    assert.ok(h.seen.some(c => c.line.includes('down -v')), 'teardown still ran');
    assert.deepEqual(readdirSync(h.tmpRoot), [], 'the temp clone was removed');
  } finally { h.cleanup(); }
});

// ---- DW-4.6: ordering, default source, env, https together ----

test('DW-4.6: a green editor run puts editor-source after port and editor after healthy', async () => {
  const h = harness();
  try {
    const result = await h.run({ editor: true, editorSource: h.editorSource, editorTimeoutMs: 2500 });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    assert.deepEqual(result.steps.map(s => s.name), EDITOR_STEPS);
    assert.equal(result.steps[2].name, 'editor-source');
    assert.equal(result.steps[2].detail, h.editorSource);
    assert.ok(result.steps.find(s => s.name === 'env').ok, 'the env step still counts 4 keys');
    assert.ok(COMPOSE_INTERPOLATED.includes('SELFCHECK_EDITOR_SOURCE'));

    const dockerCalls = h.seen.filter(c => c.cmd === 'docker');
    assert.ok(dockerCalls.length > 0);
    for (const call of dockerCalls) {
      assert.equal(call.env?.SELFCHECK_EDITOR_SOURCE, h.editorSource, call.line);
    }
    const npmCalls = h.seen.filter(c => c.cmd === 'npm' || c.cmd === 'npx');
    assert.ok(npmCalls.length > 0);
    for (const call of npmCalls) {
      assert.equal(Object.hasOwn(call.env ?? {}, 'SELFCHECK_EDITOR_SOURCE'), false, call.line);
    }
  } finally { h.cleanup(); }
});

test('DW-4.6: the default source is the sibling of a local source, else of this repo', async () => {
  const layout = mkdtempSync(path.join(os.tmpdir(), 'vl-layout-'));
  try {
    const source = path.join(layout, 'work', 'repo');
    mkdirSync(source, { recursive: true });
    const expected = path.resolve(source, '../../WebEngineTSEditor');
    assert.equal(defaultEditorSource(source), path.resolve(source, '../../WebEngineTSEditor'));
    assert.equal(defaultEditorSource('https://example.invalid/repo.git'), path.resolve(REPO_ROOT, '../../WebEngineTSEditor'));

    // makeEditorSource creates a random dir; the resolved default must be the
    // exact `<source>/../../WebEngineTSEditor` path, so create that one too.
    mkdirSync(expected, { recursive: true });
    writeFileSync(path.join(expected, 'Dockerfile'), 'FROM node:20-alpine\n');
    const h = harness();
    try {
      const result = await h.run({ source, editor: true, editorTimeoutMs: 2500 });
      assert.equal(result.ok, true, `failed at ${result.failed}`);
      assert.equal(result.steps.find(s => s.name === 'editor-source').detail, expected);
      assert.equal(h.seen.find(c => c.cmd === 'docker').env.SELFCHECK_EDITOR_SOURCE, expected);
    } finally { h.cleanup(); }
  } finally { rmSync(layout, { recursive: true, force: true }); }
});

test('DW-4.6: https + editor keeps https last among the overlays and before editor', async () => {
  const h = harness();
  try {
    const result = await h.run({ https: true, editor: true, editorSource: h.editorSource, editorTimeoutMs: 2500 });
    assert.equal(result.ok, true, `failed at ${result.failed}: ${JSON.stringify(result.steps.filter(s => !s.ok))}`);
    assert.deepEqual(result.steps.map(s => s.name), HTTPS_EDITOR_STEPS);
    assert.ok(result.steps.find(s => s.name === 'env').detail.includes('HTTPS_PORT'), 'env still owns 5 keys');

    for (const call of h.seen.filter(c => c.cmd === 'docker')) {
      const files = call.args.filter((a, i) => call.args[i - 1] === '-f');
      if (files.includes('docker-compose.https.yml')) {
        const editorAt = files.indexOf(EDITOR_FILES[1]);
        const httpsAt = files.indexOf('docker-compose.https.yml');
        assert.ok(editorAt >= 0 && httpsAt > editorAt, `${call.line}: https must follow editor`);
        // The restore command adds its own overlay as an argument; among the
        // composeArgs-managed files https is still the last one.
        const managed = files.filter(file => file !== 'docker-compose.restore.yml');
        assert.equal(managed[managed.length - 1], 'docker-compose.https.yml', call.line);
      }
    }
    for (const which of ['up', 'down']) {
      const call = h.seen.find(c => c.cmd === 'docker' && c.args.includes(which));
      assert.ok(call, `${which} ran`);
      const files = call.args.filter((a, i) => call.args[i - 1] === '-f');
      assert.deepEqual(files, [
        'docker-compose.yml', 'docker-compose.selfcheck.yml', ...EDITOR_FILES, 'docker-compose.https.yml',
      ]);
    }
  } finally { h.cleanup(); }
});

test('DW-4.3: the editor probe retries until a 2xx instead of failing on the first answer', async () => {
  const h = harness({ editorAnswer: 'recover' });
  try {
    const result = await h.run({ editor: true, editorSource: h.editorSource, editorTimeoutMs: 2500 });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    assert.equal(result.steps.find(s => s.name === 'editor').ok, true);
    assert.equal(h.probeUrls.filter(u => u.endsWith('/editor/')).length, 2);
  } finally { h.cleanup(); }
});
