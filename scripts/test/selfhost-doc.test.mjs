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

// M1.2u: an explicit `-f` list REPLACES COMPOSE_FILE from .env, so any `-f` command that
// leaves docker-compose.https.yml out silently drops the 8443 listener and REQUIRE_HTTPS on
// an admin's TLS stack (the M1.2r failure). Every `-f` command must therefore either carry the
// https overlay, be the restore pair (base + restore, deliberately overlay-free), or stand
// under an explicit "without HTTPS" marker.
test('self-host doc: every docker compose -f command keeps the https overlay, is the restore pair, or says "without HTTPS"', () => {
  const lines = DOC.split('\n');
  const WITHOUT_HTTPS = /без\s+HTTPS/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('docker compose') || !/-f docker-compose/.test(line)) continue;
    const whole = lines.slice(i, i + 2).join(' '); // a command may wrap onto the next line
    if (/docker-compose\.restore\.yml/.test(whole)) continue; // documented restore pair
    if (/docker-compose\.https\.yml/.test(whole)) continue; // overlay kept
    // Otherwise an explicit "without HTTPS" marker must stand within the four lines above.
    const context = lines.slice(Math.max(0, i - 4), i).join('\n');
    assert.ok(WITHOUT_HTTPS.test(context),
      `a -f command without docker-compose.https.yml must be marked "без HTTPS" just above it: ${line.trim()}`);
  }
});

test('self-host doc: the editor section leads with COMPOSE_FILE, not an explicit -f pair', () => {
  const editor = section('Редактор сценаріїв');
  const firstF = editor.indexOf('-f docker-compose');
  const composeFile = editor.indexOf('COMPOSE_FILE=');
  assert.notEqual(composeFile, -1, 'the editor section must set COMPOSE_FILE');
  assert.ok(firstF === -1 || composeFile < firstF,
    'COMPOSE_FILE must be introduced before any explicit -f command in the editor section');
  assert.match(editor, /без HTTPS/, 'the explicit -f form must be marked as the without-HTTPS case');
});

// P5e: «Як оновитися» step 1 runs BEFORE git pull, i.e. possibly on pre-P5c compose whose
// container env was BACKUP_DIR: ${BACKUP_DIR:-/backups}. Without the explicit pin an admin's
// BACKUP_DIR=/mnt/offsite sends the dump outside the mount, into the --rm container that then
// deletes it — the one update that most needs a rollback point would have none.
test('self-host doc: update step 1 pins BACKUP_DIR=/backups in the backup command', () => {
  const update = section('Оновлення');
  const step1 = update.slice(update.indexOf('1. **'), update.indexOf('2. Оновіть код'));
  assert.ok(step1.length > 0, 'step 1 of «Як оновитися» must be locatable');
  const backup = step1.split('\n').find((l) => /docker compose run[^\n]*\bbackup\b/.test(l));
  assert.ok(backup, 'step 1 must carry a `docker compose run … backup` command');
  assert.match(backup, /-e BACKUP_DIR=\/backups\b/,
    `the pre-update backup must pin the container path: ${backup.trim()}`);
  assert.match(backup, /BACKUP_RUN_ONCE=1/, 'the on-demand run flag must stay');
});

test('self-host doc: update step 1 verifies the HOST folder (${BACKUP_DIR:-backup/out}), not /backups', () => {
  const update = section('Оновлення');
  const step1 = update.slice(update.indexOf('1. **'), update.indexOf('2. Оновіть код'));
  const verify = step1.split('\n').find((l) => l.includes('verify-backup.mjs'));
  assert.ok(verify, 'step 1 must verify the backup it just took');
  assert.match(verify, /\$\{BACKUP_DIR:-backup\/out\}/,
    `verification reads the host mount source, which follows BACKUP_DIR: ${verify.trim()}`);
  assert.ok(!/verify-backup\.mjs \/backups/.test(verify),
    '/backups is a container path — it does not exist on the host');
});

test('self-host doc: the P5c update keeps the old container backups with docker cp before the rebuild', () => {
  const update = section('Оновлення');
  const cp = update.split('\n').find((l) => /docker cp VirtualLabBackup:/.test(l));
  assert.ok(cp, 'a `docker cp VirtualLabBackup:…` rescue step must be documented');
  assert.ok(update.indexOf(cp) < update.indexOf('3. Перебудуйте'),
    'the rescue must come before step 3 recreates the container');
  assert.match(section('Оновлення'), /Що нового|P5c/, 'the P5c transition must be named');
  const whatsNew = DOC.slice(DOC.indexOf('### Що нового'));
  assert.match(whatsNew, /docker cp VirtualLabBackup:/,
    '«Що нового» must carry the rescue command for this one update');
});

test('self-host doc: the rollback restore keeps -e BACKUP_DIR=/backups but no hard-coded backup/out -v', () => {
  const update = section('Оновлення');
  const start = update.indexOf('-f docker-compose.yml -f docker-compose.restore.yml');
  assert.notEqual(start, -1, 'the restore command must stay in the rollback section');
  const cmd = update.slice(start, update.indexOf('```', start));
  assert.match(cmd, /-e BACKUP_DIR=\/backups/, 'the container-path pin must stay in the restore command');
  assert.ok(!/-v /.test(cmd),
    'the service mount already follows BACKUP_DIR; a hard-coded -v sends an off-host admin to the wrong folder');
});

// P5d: the redirect reads X-Forwarded-Proto, so an admin whose own TLS proxy terminates TLS and
// forwards plain http to :8044 must be told to send that header and to raise TRUST_PROXY — and the
// update check cannot keep telling them `curl http://…/api/health` works under the overlay.
test('self-host doc: the HTTPS section tells a TLS-proxy admin to send X-Forwarded-Proto: https with TRUST_PROXY=2', () => {
  const https = section('HTTPS');
  assert.match(https, /X-Forwarded-Proto/, 'the header the redirect reads must be named');
  assert.match(https, /TRUST_PROXY=2/, 'two proxies (theirs + nginx) must be stated');
  assert.match(https, /301/, 'the loop the missing header causes must be explained');
});

test('self-host doc: under the overlay the health probe is the TLS one, not plain http', () => {
  const https = section('HTTPS');
  const update = section('Оновлення');
  for (const [name, body] of [['HTTPS', https], ['Оновлення', update]]) {
    const tls = body.indexOf('curl -k https://127.0.0.1:${HTTPS_PORT:-8443}/api/health');
    assert.notEqual(tls, -1, `${name} must show the TLS health probe`);
    if (name === 'HTTPS') {
      assert.match(body.slice(Math.max(0, tls - 400), tls), /301|редирект/i,
        'the plain-http 301 must be stated next to the TLS probe');
    }
  }
});

// P1d: Moodle fetches /api/lti/jwks and the AGS token server-side through PHP cURL, which by
// default allows only 443/80, blocks private ranges and rejects an untrusted certificate. The
// guide's own example (https://lab.example.edu:8443) launches fine but loses «Select content»
// and every grade — the prerequisite section must say so and name the way out.
test('self-host doc: the LTI prerequisite states Moodle\'s server-side fetches and the trusted-cert/443 requirement', () => {
  const lti = section('Робота як LTI-інструмент');
  const prereq = lti.slice(lti.indexOf('### Передумова'), lti.indexOf('### Крок 1'));
  assert.ok(prereq.length > 0, 'the prerequisite section must be locatable');
  assert.match(prereq, /\/api\/lti\/jwks/, 'the server-side keyset fetch must be named');
  assert.match(prereq, /AGS/, 'the server-side grade token must be named');
  assert.match(prereq, /curlsecurityallowedport/, 'the allowed-port setting must be named');
  assert.match(prereq, /curlsecurityblockedhosts/, 'the blocked-hosts setting must be named');
  assert.match(prereq, /curl\.cainfo/, 'the trusted-CA setting must be named');
  assert.match(prereq, /HTTPS_PORT=443/, 'the 443 way out must be shown');
  assert.match(prereq, /TRUST_PROXY=2/, 'a TLS-terminated proxy needs the hop count for per-client limits');
});

test('self-host doc: the LTI example URL carries no non-443 port and self-signed is demo-only', () => {
  const lti = section('Робота як LTI-інструмент');
  assert.ok(!/^LTI_PUBLIC_URL=https:\/\/[^\n]*:\d+/m.test(lti),
    'an example LTI_PUBLIC_URL with a port teaches the configuration that breaks Moodle\'s server-side fetches');
  assert.match(lti, /LTI_PUBLIC_URL=https:\/\/lab\.example\.edu\b/, 'the example must be the portless https origin');
  const prereq = lti.slice(lti.indexOf('### Передумова'), lti.indexOf('### Крок 1'));
  assert.match(prereq, /самопідписаний[\s\S]{0,200}демонстрац/i,
    'accepting a self-signed certificate must be marked as demo-only');
});
