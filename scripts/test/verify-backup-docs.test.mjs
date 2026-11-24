// scripts/test/verify-backup-docs.test.mjs
//
// HO1b Phase 2 (DW-2.1..DW-2.4): an admin without Node on the host is told the
// in-image verifier everywhere it is mentioned. The restore refusal hints the
// compose-mount path (/backups/<name>), never a host command with a container
// path; docs/self-host.md keeps the pinned first lines of update step 1 and
// adds the in-image alternative AFTER them; docs/backup-restore.md step 3b
// verifies inside the image. Pattern: selfhost-doc.test.mjs (fs reads +
// node:test) and restore.test.mjs (spawned restore.mjs, BACKUP_DIR=temp root).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESTORE = path.join(ROOT, 'backup', 'restore.mjs');
const SELF_HOST = readFileSync(path.join(ROOT, 'docs', 'self-host.md'), 'utf8');
const BACKUP_DOC = readFileSync(path.join(ROOT, 'docs', 'backup-restore.md'), 'utf8');

/** The body of one `## <title…>` section, up to the next `## ` heading. */
function section(doc, title) {
  const start = doc.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `section "## ${title}" must exist`);
  const rest = doc.slice(start + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? doc.slice(start) : doc.slice(start, start + 1 + next);
}

/** «Як оновитися» step 1 — the same slice selfhost-doc.test.mjs pins. */
function updateStep1() {
  const update = section(SELF_HOST, 'Оновлення');
  const step1 = update.slice(update.indexOf('1. **'), update.indexOf('2. Оновіть код'));
  assert.ok(step1.length > 0, 'step 1 of «Як оновитися» must be locatable');
  return step1;
}

// ── DW-2.1: the refusal hint points at the in-image verifier ──

test('restore hint: an unmarked backup names the in-image command with /backups/<name>, host form separate', () => {
  // BACKUP_DIR is a temp root, deliberately NOT /backups: the in-image hint
  // must still name the compose mount path, and the host form must not carry
  // a container path. The gate refuses before any read, so an empty directory
  // is a sufficient fixture (same spawn shape as backup/restore.test.mjs).
  const root = mkdtempSync(path.join(os.tmpdir(), 'vl-vbdocs-'));
  const name = '2026-11-23T00-00-00Z';
  mkdirSync(path.join(root, name));
  try {
    const res = spawnSync(process.execPath, [RESTORE, name], {
      encoding: 'utf8',
      env: { ...process.env, BACKUP_DIR: root },
    });
    assert.ifError(res.error);
    assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
    assert.ok(res.stderr.includes(`docker compose run --rm --entrypoint node backup verify-backup.mjs /backups/${name}`),
      `the in-image command with the mount path must be hinted: ${res.stderr}`);
    assert.ok(res.stderr.includes('node scripts/lib/verify-backup.mjs'),
      `the host alternative must stay: ${res.stderr}`);
    assert.ok(res.stderr.includes(`<host backup folder>/${name}`),
      `the host form names the host folder placeholder, not the container path: ${res.stderr}`);
    // restore.test.mjs pins both substrings — keep them.
    assert.match(res.stderr, /verified/);
    assert.match(res.stderr, /verify-backup\.mjs/);
    for (const line of res.stderr.split('\n')) {
      assert.ok(!line.includes('scripts/lib/verify-backup.mjs /backups'),
        `a host command must never carry the container path: ${line}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── DW-2.2: update step 1 — the in-image alternative comes AFTER the pinned lines ──

test('self-host doc: update step 1 adds the plain-compose in-image verifier after the backup and host verify lines', () => {
  const lines = updateStep1().split('\n');
  // findIndex gives the FIRST match: asserting the pins on it proves nothing
  // earlier in the step matches either pattern (the selfhost-doc.test.mjs contract).
  const backupIdx = lines.findIndex((l) => /docker compose run[^\n]*\bbackup\b/.test(l));
  assert.notEqual(backupIdx, -1, 'step 1 must carry a `docker compose run … backup` command');
  assert.match(lines[backupIdx], /-e BACKUP_DIR=\/backups\b/, 'the first backup line keeps the container-path pin');
  assert.match(lines[backupIdx], /BACKUP_RUN_ONCE=1/, 'the first backup line keeps the on-demand flag');
  const verifyIdx = lines.findIndex((l) => l.includes('verify-backup.mjs'));
  assert.notEqual(verifyIdx, -1, 'step 1 must verify the backup it just took');
  assert.match(lines[verifyIdx], /\$\{BACKUP_DIR:-backup\/out\}/, 'the first verify line stays the host one');
  const inImageIdx = lines.findIndex((l) => l.includes('--entrypoint node backup verify-backup.mjs --newest /backups'));
  assert.notEqual(inImageIdx, -1, 'the in-image --newest command must be shown');
  assert.ok(inImageIdx > backupIdx && inImageIdx > verifyIdx,
    'the in-image alternative must follow the existing backup and host verify lines');
  assert.ok(!lines[inImageIdx].includes('-f '),
    `the in-image command is plain compose (follows COMPOSE_FILE), no -f: ${lines[inImageIdx]}`);
  // The caveats live after the pinned lines too — never earlier in the step.
  const tail = lines.slice(Math.max(backupIdx, verifyIdx) + 1).join('\n');
  assert.ok(tail.includes('до цього оновлення'),
    'step 1 must say an image built before this update lacks the verifier');
  assert.ok(/не містить[\s\S]{0,80}verify-backup\.mjs/.test(tail),
    'the pre-update caveat must name what the old image lacks');
  assert.ok(tail.includes('cannot write the verified marker') && /EACCES/.test(tail),
    'the non-root host symptom must be named with the in-image way out');
});

// ── DW-2.3: «Вимоги» and «Що нового» ──

test('self-host doc: «Вимоги» names verify-backup.mjs; the newest «Що нового» entry names it and --newest', () => {
  const reqs = section(SELF_HOST, 'Вимоги');
  assert.ok(reqs.includes('verify-backup.mjs'),
    '«Вимоги» must say verification works without Node on the host (the image carries verify-backup.mjs)');
  const start = SELF_HOST.indexOf('### Що нового');
  assert.notEqual(start, -1, '«Що нового» must exist');
  const rest = SELF_HOST.slice(start);
  const next = rest.search(/^## /m);
  const whatsNew = next === -1 ? rest : rest.slice(0, next);
  // Newest on top: the FIRST dated bullet is the new entry.
  const first = whatsNew.indexOf('- **');
  assert.notEqual(first, -1, '«Що нового» must have dated entries');
  const second = whatsNew.indexOf('- **', first + 1);
  const entry = second === -1 ? whatsNew.slice(first) : whatsNew.slice(first, second);
  assert.match(entry, /^- \*\*2026-11-23/, `the newest entry must be the dated HO1b one: ${entry.split('\n')[0]}`);
  assert.ok(entry.includes('verify-backup.mjs'), 'the entry must name verify-backup.mjs');
  assert.ok(entry.includes('--newest'), 'the entry must name --newest');
});

// ── DW-2.4: backup-restore.md step 3b verifies inside the image ──

test('backup-restore doc: step 3b runs the in-image verifier; the host form stays a comment', () => {
  const start = BACKUP_DOC.indexOf('# 3b.');
  const end = BACKUP_DOC.indexOf('# 4.');
  assert.ok(start !== -1 && end > start, 'step 3b must be locatable between its comment and step 4');
  const step3b = BACKUP_DOC.slice(start, end);
  assert.ok(step3b.includes('run --rm --entrypoint node'), 'the verifier runs under node, not the backup entrypoint');
  assert.ok(step3b.includes('backup verify-backup.mjs "/backups/$NAME"'),
    'the verifier reads the mounted container path, by backup name');
  assert.ok(step3b.includes('docker compose -p vlabscratch $F run --rm --entrypoint node -v "$PWD/backup/out-scratch:/backups" backup verify-backup.mjs "/backups/$NAME"'),
    'the D5 command must appear verbatim (project, F, scratch mount)');
  assert.ok(/^#\s*node scripts\/lib\/verify-backup\.mjs "backup\/out-scratch\/\$NAME"/m.test(step3b),
    'the host form is kept, as a comment');
});
