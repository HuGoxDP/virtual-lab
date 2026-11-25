// scripts/test/install-windows-doc.test.mjs
//
// HO1a Phase 3 (DW-3.1, DW-3.2): the Windows one-command install
// subsection must live inside `## Встановлення`, before
// `### Перший модератор`. Scoped guard (no whole-doc comparison).
// Pattern: selfhost-doc.test.mjs - fs reads + node:test, `## ` section
// slicing, no Docker, no git; every test runs on every host.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_PATH = path.join(ROOT, 'docs', 'self-host.md');
const DOC = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
const NEW_HEADING = '### Windows: встановлення однією командою (install.cmd)';

/** The body of one `## <title…>` section, up to the next `## ` heading. */
function slice(doc, title) {
  const start = doc.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `section "## ${title}" must exist`);
  const rest = doc.slice(start + 1);
  const next = rest.search(/^## /m);
  return {
    start,
    end: next === -1 ? doc.length : start + 1 + next,
    body: next === -1 ? doc.slice(start) : doc.slice(start, start + 1 + next),
  };
}

// DW-3.1: the subsection is inside ## Встановлення, names the essentials,
// and comes before ### Перший модератор.
test('self-host doc: the Windows install subsection sits in «Встановлення» before «Перший модератор» and names the essentials', () => {
  const install = slice(DOC, 'Встановлення');
  for (const needle of ['install.cmd', 'Docker Desktop', '/api/health', '.env']) {
    assert.ok(install.body.includes(needle), `the section must mention ${needle}`);
  }
  const headingAt = install.body.indexOf(NEW_HEADING);
  assert.notEqual(headingAt, -1, 'the new ### heading must exist inside the section');
  const moderatorAt = install.body.indexOf('### Перший модератор');
  assert.notEqual(moderatorAt, -1, '### Перший модератор must still exist');
  assert.ok(headingAt < moderatorAt, 'the Windows subsection must come before ### Перший модератор');
});

// D12 content list: terminal not double-click, rerun-safe, secrets only
// in .env, ADMIN_TOKEN read by opening .env, first-build time, the Group
// Policy limitation, and the deleted-.env warning without down -v advice.
test('self-host doc: the Windows subsection carries the full D12 content list', () => {
  const install = slice(DOC, 'Встановлення');
  const sub = install.body.slice(install.body.indexOf(NEW_HEADING), install.body.indexOf('### Перший модератор'));
  assert.match(sub, /[Пп]одвійний клік/, 'double-click must be named as unsupported');
  assert.match(sub, /термінал/, 'a terminal in the repo folder must be the instructed path');
  assert.match(sub, /[Пп]овторний запуск/, 'rerun behaviour must be stated');
  assert.match(sub, /не змінює/, 'a rerun must be said to leave .env unchanged');
  assert.match(sub, /тільки у `\.env`/, 'secrets must be said to live only in .env');
  assert.match(sub, /ніколи не друкуються/, 'secrets must be said to never be printed');
  assert.match(sub, /ADMIN_TOKEN/, 'how to read ADMIN_TOKEN must be covered');
  assert.match(sub, /2–5 хвилин/, 'the first-build time must be stated');
  assert.match(sub, /Group Policy/, 'the Group Policy limitation must be named');
  assert.match(sub, /-ExecutionPolicy Bypass/, 'the bypass flag must be named');
  assert.match(sub, /Не видаляйте `\.env`/, 'the deleted-.env warning must be present');
  assert.match(sub, /том бази даних/, 'the DB-volume password mismatch must be explained');
  assert.match(sub, /бекапу/, 'restoring from a backup must be the advised path');
  assert.match(sub, /down -v/, 'the down -v data-loss warning must be present');
  assert.ok(!/docker compose [^\n]* -f /.test(sub), 'no docker compose -f line in the subsection');
});
