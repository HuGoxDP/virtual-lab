// scripts/test/selfhost-doc.test.mjs
//
// M1.2r: docs/self-host.md must teach COMPOSE_FILE overlay preservation.
// The update/rollback/logs commands in the guide are plain `docker compose`;
// without COMPOSE_FILE in .env a plain `up -d --build` on a TLS/editor stack
// recreates it from docker-compose.yml alone — 8443 and REQUIRE_HTTPS vanish
// (Moodle launches fail, tokens over http), /editor/ disappears. These tests
// assert the guidance lives in the RIGHT section (## slicing), not anywhere
// in the file, and guard the M1.2s restore command's explicit -f pair.
// Pattern: https-redirect.test.mjs — fs reads + node:test, no Docker.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = readFileSync(path.join(ROOT, 'docs', 'self-host.md'), 'utf8');

/** The body of one `## <title…>` section, up to the next `## ` heading. */
function section(title) {
  const start = DOC.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `section "## ${title}" must exist`);
  const rest = DOC.slice(start + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? DOC.slice(start) : DOC.slice(start, start + 1 + next);
}

test('self-host doc: HTTPS section sets COMPOSE_FILE with the https overlay, Windows ; separator', () => {
  const https = section('HTTPS');
  assert.match(https, /COMPOSE_FILE=[^\n]*docker-compose\.yml[^\n]*docker-compose\.https\.yml/,
    'COMPOSE_FILE= must name the base file AND docker-compose.https.yml');
  assert.match(https, /Windows/, 'the Windows separator case must be named');
  assert.match(https, /`;/, 'the Windows path-list separator ; must be shown');
});

test('self-host doc: editor section sets COMPOSE_FILE with docker-compose.editor.yml', () => {
  const editor = section('Редактор сценаріїв');
  assert.match(editor, /COMPOSE_FILE=[^\n]*docker-compose\.editor\.yml/,
    'COMPOSE_FILE guidance must name docker-compose.editor.yml');
});

test('self-host doc: update area (Як оновитися + rollback) names COMPOSE_FILE; up commands plain or fully -f-listed', () => {
  const update = section('Оновлення');
  assert.match(update, /COMPOSE_FILE/,
    'the mechanism that keeps plain update commands overlay-safe must be named here');
  for (const line of update.split('\n')) {
    if (!/docker compose[^\n]*\bup\b/.test(line)) continue;
    const fCount = (line.match(/-f /g) || []).length;
    if (fCount === 0) continue; // plain — overlay preservation delegated to .env
    assert.ok(fCount >= 2 && /-f docker-compose\.yml\b/.test(line),
      `a -f list must be complete (base + overlay), never partial: ${line.trim()}`);
  }
});

test('self-host doc: logs/stop/reset section says the plain commands follow COMPOSE_FILE too', () => {
  const logs = section('Логи, зупинка, скидання');
  assert.match(logs, /COMPOSE_FILE/,
    'down/stop/logs coverage of overlay services must be stated in this section');
});

test('self-host doc: M1.2s rollback restore keeps the explicit -f docker-compose.yml -f docker-compose.restore.yml pair', () => {
  const update = section('Оновлення');
  assert.match(update, /-f docker-compose\.yml -f docker-compose\.restore\.yml/,
    'the restore command deliberately overrides COMPOSE_FILE with an explicit pair — keep it');
});
