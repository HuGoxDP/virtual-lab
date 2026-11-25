// scripts/test/install-windows-env.test.mjs
//
// HO1a Phase 2 (DW-2.1 .. DW-2.5): hardening tests for install.ps1 -
// byte preservation across template shapes, the fail-closed matrix,
// existing-.env warnings, the FRONTEND_PORT rules, and the static
// security properties (no echo, no prompt, ASCII). Uses the Phase 1
// harness unchanged; extra fixtures live here (the harness is a
// committed Phase 1 file and must not be edited).
// Off Windows, or without stock Windows PowerShell 5.1, each test
// returns early - no skip/todo (milestone gate rule).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, canRun, makeSandbox, runInstaller, secretValues, withTemplateSecrets } from './install-harness.mjs';

const PLACEHOLDER = 'change-me-before-deploying';
const SECRET_KEYS = ['DB_PASSWORD', 'ADMIN_TOKEN'];

// A minimal template with Cyrillic comments, rendered in one of four
// byte shapes: LF, CRLF, UTF-8 BOM + CRLF, LF without a final newline.
function shapedTemplate(eol, { bom = false, finalNewline = true } = {}) {
  const lines = [
    '# Віртуальна лабораторія — шаблон середовища',
    'DB_HOST=database',
    'DB_PASSWORD=change-me-before-deploying',
    '# Токен першого модератора',
    'ADMIN_TOKEN=change-me-before-deploying',
    'FRONTEND_PORT=8044',
  ];
  let text = lines.join(eol);
  if (finalNewline) text += eol;
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]) : body;
}

/** A one-key-line template whose FRONTEND_PORT line is `raw`. */
function portTemplate(raw) {
  return Buffer.from(
    `DB_PASSWORD=${PLACEHOLDER}\nADMIN_TOKEN=${PLACEHOLDER}\nFRONTEND_PORT=${raw}\n`, 'utf8');
}

/** Assert the fail-closed shape: exit 1, FAILED:, no .env, no temp leftover, no compose. */
function assertFailClosed(sandbox, run, messagePart) {
  assert.equal(run.status, 1, `expected exit 1, got ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  const all = run.stdout + run.stderr;
  assert.ok(all.includes('FAILED:'), `house failure prefix expected:\n${all}`);
  if (messagePart) assert.ok(all.includes(messagePart), `message must name "${messagePart}":\n${all}`);
  assert.ok(!fs.existsSync(path.join(sandbox.dir, '.env')), 'no .env may be created');
  const leftovers = fs.readdirSync(sandbox.dir).filter((n) => n.startsWith('.env.install-'));
  assert.deepEqual(leftovers, [], 'no .env.install-* temp file may be left behind');
  assert.ok(!run.dockerCalls.some((line) => line.includes('compose')), 'no compose call on a fail-closed path');
}

// DW-2.1: BOM / LF / CRLF / no-final-newline templates, each with
// Cyrillic comments: status 0 and every non-secret byte preserved.
for (const shape of [
  { name: 'LF', eol: '\n' },
  { name: 'CRLF', eol: '\r\n' },
  { name: 'UTF-8 BOM + CRLF', eol: '\r\n', bom: true },
  { name: 'LF, no final newline', eol: '\n', finalNewline: false },
]) {
  test(`DW-2.1: ${shape.name} template with Cyrillic comments is preserved byte for byte`, () => {
    if (!canRun()) return;
    const template = shapedTemplate(shape.eol, shape);
    const sandbox = makeSandbox({ template });
    try {
      const run = runInstaller(sandbox, { via: 'cmd' });
      assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
      const env = fs.readFileSync(path.join(sandbox.dir, '.env'));
      assert.equal(Buffer.compare(withTemplateSecrets(env, template), template), 0,
        'every byte except the two secret values must equal the template');
      const secrets = secretValues(env);
      for (const key of SECRET_KEYS) assert.match(secrets[key], /^[0-9a-f]{64}$/);
      assert.deepEqual(run.dockerCalls, ['info', 'compose up -d --build']);
    } finally {
      sandbox.cleanup();
    }
  });
}

// DW-2.2: the fail-closed matrix. Each broken template must exit 1 with
// FAILED:, no .env, no temp leftover and no compose; a key at fault is
// named in the message.
const BAD_TEMPLATES = [
  {
    name: 'template missing',
    template: undefined, remove: true, message: '.env.example',
  },
  {
    name: 'ADMIN_TOKEN has no key line',
    template: Buffer.from(`DB_PASSWORD=${PLACEHOLDER}\n# ADMIN_TOKEN is gone\n`, 'utf8'),
    message: 'ADMIN_TOKEN',
  },
  {
    name: 'ADMIN_TOKEN only indented',
    template: Buffer.from(`DB_PASSWORD=${PLACEHOLDER}\n  ADMIN_TOKEN=x\n`, 'utf8'),
    message: 'ADMIN_TOKEN',
  },
  {
    name: 'ADMIN_TOKEN only commented',
    template: Buffer.from(`DB_PASSWORD=${PLACEHOLDER}\n# ADMIN_TOKEN=x\n`, 'utf8'),
    message: 'ADMIN_TOKEN',
  },
  {
    name: 'ADMIN_TOKEN only export-prefixed',
    template: Buffer.from(`DB_PASSWORD=${PLACEHOLDER}\nexport ADMIN_TOKEN=x\n`, 'utf8'),
    message: 'ADMIN_TOKEN',
  },
  {
    name: 'DB_PASSWORD on two key lines',
    template: Buffer.from(`DB_PASSWORD=a\nDB_PASSWORD=b\nADMIN_TOKEN=${PLACEHOLDER}\n`, 'utf8'),
    message: 'DB_PASSWORD',
  },
  {
    name: 'invalid UTF-8 byte 0xFF',
    template: Buffer.concat([
      Buffer.from(`DB_PASSWORD=${PLACEHOLDER}\nADMIN_TOKEN=${PLACEHOLDER}\n# `, 'utf8'),
      Buffer.from([0xFF]), Buffer.from('\n', 'utf8'),
    ]),
    message: 'UTF-8',
  },
];
for (const bad of BAD_TEMPLATES) {
  test(`DW-2.2: ${bad.name} fails closed before any .env exists`, () => {
    if (!canRun()) return;
    const sandbox = makeSandbox(bad.template === undefined ? {} : { template: bad.template });
    try {
      if (bad.remove) fs.rmSync(path.join(sandbox.dir, '.env.example'));
      const run = runInstaller(sandbox, { via: 'cmd' });
      assertFailClosed(sandbox, run, bad.message);
    } finally {
      sandbox.cleanup();
    }
  });
}

// DW-2.2 extra: .env exists but is a directory (the plan pins this
// fixture in the test itself, not the harness).
test('DW-2.2: an existing .env that is a directory fails closed', () => {
  if (!canRun()) return;
  const sandbox = makeSandbox();
  try {
    fs.mkdirSync(path.join(sandbox.dir, '.env'));
    const run = runInstaller(sandbox, { via: 'cmd' });
    assert.equal(run.status, 1);
    assert.ok((run.stdout + run.stderr).includes('FAILED:'));
    assert.ok((run.stdout + run.stderr).includes('directory'), 'the message must say what is wrong');
    assert.ok(fs.statSync(path.join(sandbox.dir, '.env')).isDirectory(), 'the directory must stay');
    assert.ok(!run.dockerCalls.some((line) => line.includes('compose')));
  } finally {
    sandbox.cleanup();
  }
});

// DW-2.3: an existing .env with a placeholder ADMIN_TOKEN and a blank
// DB_PASSWORD: WARNING names both keys, the placeholder string never
// appears in the output, the file stays byte-identical, compose runs.
test('DW-2.3: placeholder/blank secrets in an existing .env warn by key name only; file untouched; compose runs', () => {
  if (!canRun()) return;
  const existing = Buffer.from(
    `# мій файл\r\nDB_PASSWORD=\r\nADMIN_TOKEN=${PLACEHOLDER}\r\nFRONTEND_PORT=8044\r\n`, 'utf8');
  const sandbox = makeSandbox({ existingEnv: existing });
  try {
    const envPath = path.join(sandbox.dir, '.env');
    const mtimeBefore = fs.statSync(envPath).mtimeMs;
    const run = runInstaller(sandbox, { via: 'cmd' });
    assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    const all = run.stdout + run.stderr;
    for (const key of SECRET_KEYS) {
      assert.ok(new RegExp(`WARNING:[^\n]*${key}`).test(all), `a WARNING must name ${key}:\n${all}`);
    }
    assert.ok(!all.includes(PLACEHOLDER), 'the placeholder string must not be echoed');
    assert.equal(Buffer.compare(fs.readFileSync(envPath), existing), 0, '.env must stay byte-identical');
    assert.equal(fs.statSync(envPath).mtimeMs, mtimeBefore, '.env mtime must not move');
    assert.deepEqual(run.dockerCalls, ['info', 'compose up -d --build']);
  } finally {
    sandbox.cleanup();
  }
});

// DW-2.4 + port boundaries: the value rule (quotes, inline comment) and
// the 1..65535 range; invalid values warn and print no URL from .env.
for (const port of [
  { raw: 'abc', valid: false },
  { raw: '0', valid: false },
  { raw: '70000', valid: false },
  { raw: '65536', valid: false },
  { raw: '1', valid: true },
  { raw: '65535', valid: true },
  { raw: '"8044"  # c', valid: true, url: 8044 },
]) {
  test(`DW-2.4: FRONTEND_PORT=${JSON.stringify(port.raw)} ${port.valid ? 'gives its URL' : 'warns without a URL'}`, () => {
    if (!canRun()) return;
    const sandbox = makeSandbox({ template: portTemplate(port.raw) });
    try {
      const run = runInstaller(sandbox, { via: 'cmd', env: { FRONTEND_PORT: '' } });
      assert.equal(run.status, 0, `the installer never aborts over the port:\n${run.stdout}\n${run.stderr}`);
      if (port.valid) {
        const expected = port.url ?? Number(port.raw);
        assert.ok(run.stdout.includes(`http://localhost:${expected}/api\/health`), run.stdout);
        assert.ok(!run.stdout.includes('WARNING: FRONTEND_PORT'), 'a valid port must not warn');
      } else {
        assert.ok(run.stdout.includes('WARNING: FRONTEND_PORT'), run.stdout);
        assert.ok(!run.stdout.includes(`http://localhost:${port.raw}`), 'no URL from an invalid value');
        assert.ok(!run.stdout.includes('Health check:'), 'no .env URL line at all');
      }
      assert.deepEqual(run.dockerCalls, ['info', 'compose up -d --build']);
    } finally {
      sandbox.cleanup();
    }
  });
}

test('DW-2.4: FRONTEND_PORT missing from .env warns and prints no URL line', () => {
  if (!canRun()) return;
  const template = Buffer.from(`DB_PASSWORD=${PLACEHOLDER}\nADMIN_TOKEN=${PLACEHOLDER}\n`, 'utf8');
  const sandbox = makeSandbox({ template });
  try {
    const run = runInstaller(sandbox, { via: 'cmd', env: { FRONTEND_PORT: '' } });
    assert.equal(run.status, 0);
    assert.ok(run.stdout.includes('WARNING: FRONTEND_PORT'), run.stdout);
    assert.ok(!run.stdout.includes('Health check:'), 'no .env URL line');
  } finally {
    sandbox.cleanup();
  }
});

test('DW-2.4: env FRONTEND_PORT=9001 gives the NOTE with its URL; the 8044 .env line stays', () => {
  if (!canRun()) return;
  const sandbox = makeSandbox(); // repo template: FRONTEND_PORT=8044
  try {
    const run = runInstaller(sandbox, { via: 'cmd', env: { FRONTEND_PORT: '9001' } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(/NOTE:[^\n]*http:\/\/localhost:9001\/api\/health/.test(run.stdout), run.stdout);
    assert.ok(run.stdout.includes('http://localhost:8044/api/health'), 'the .env URL line must still be printed');
  } finally {
    sandbox.cleanup();
  }
});

test('DW-2.4: env FRONTEND_PORT equal to the .env value gives no NOTE', () => {
  if (!canRun()) return;
  const sandbox = makeSandbox();
  try {
    const run = runInstaller(sandbox, { via: 'cmd', env: { FRONTEND_PORT: '8044' } });
    assert.equal(run.status, 0);
    assert.ok(!run.stdout.includes('NOTE:'), 'an equal port deserves no NOTE');
    assert.ok(run.stdout.includes('http://localhost:8044/api/health'));
  } finally {
    sandbox.cleanup();
  }
});

// DW-2.5: no echo (both routes), and the static security properties.
for (const via of ['cmd', 'powershell']) {
  test(`DW-2.5: no secret from the created .env appears in stdout, stderr or the docker log (via ${via})`, () => {
    if (!canRun()) return;
    const sandbox = makeSandbox();
    try {
      const run = runInstaller(sandbox, { via });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const secrets = secretValues(fs.readFileSync(path.join(sandbox.dir, '.env')));
      for (const value of Object.values(secrets)) {
        assert.ok(!run.stdout.includes(value), 'a secret was echoed on stdout');
        assert.ok(!run.stderr.includes(value), 'a secret was echoed on stderr');
        assert.ok(!run.dockerCalls.some((line) => line.includes(value)), 'a secret reached docker argv');
      }
    } finally {
      sandbox.cleanup();
    }
  });
}

test('DW-2.5: install.ps1 and install.cmd are pure ASCII; no prompt, no weak RNG, no .exe-suffixed docker, no pause', () => {
  // Static file reads: meaningful on every platform, no early return.
  const ps1 = fs.readFileSync(path.join(ROOT, 'install.ps1'));
  const cmd = fs.readFileSync(path.join(ROOT, 'install.cmd'));
  for (const [name, buf] of [['install.ps1', ps1], ['install.cmd', cmd]]) {
    const badIndex = [...buf].findIndex((b) => b >= 0x80);
    assert.equal(badIndex, -1, `${name} must be pure ASCII (first bad byte at ${badIndex})`);
  }
  const ps1Text = ps1.toString('ascii');
  for (const forbidden of ['Read-Host', 'Get-Credential', 'Get-Random', 'System.Random', 'docker.exe']) {
    assert.ok(!ps1Text.includes(forbidden), `install.ps1 must not contain ${forbidden}`);
  }
  assert.ok(!cmd.toString('ascii').includes('pause'), 'install.cmd must not contain pause');
});
