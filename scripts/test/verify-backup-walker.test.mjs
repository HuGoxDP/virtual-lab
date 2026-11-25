// scripts/test/verify-backup-walker.test.mjs
//
// Oracle tests for Phase 3: the incremental TarWalker must produce identical
// results to the base walkTar for every tar fixture at every chunk size,
// and the refactored verifyBackup must deep-equal the base verifyBackup on
// >= 10 backup fixtures without marker problems.
//
// The oracle code is a verbatim copy of the base file at e70ff8d:scripts/lib/verify-backup.mjs

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { TarWalker, verifyBackup } from '../../backup/verify-backup.mjs';

// ============================================================
// ORACLE: verbatim copy of base functions from e70ff8d
// ============================================================

function walkTar(tar) {
  const BLOCK = 512;
  if (tar.length < BLOCK) return { ok: false, entries: 0, error: `shorter than one header block (${tar.length} bytes)` };

  let offset = 0;
  let entries = 0;
  let zeroBlocks = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) {
      // The end-of-archive marker: one zero block here, another right after it.
      // A file that ends on the first one is still a readable tar.
      zeroBlocks += 1;
      offset += BLOCK;
      continue;
    }
    if (zeroBlocks > 0) return { ok: false, entries, error: `content after the end-of-archive marker at byte ${offset}` };

    // The checksum is octal, like every other numeric header field: the sum of
    // every header byte with the checksum field itself read as spaces — the one
    // field the header cannot validate directly. Parsing it as decimal accepts
    // only checksums whose octal digits happen to be < 8 and rejects every real
    // tar whose sum carries an 8 or 9 (the first fixture caught it).
    let stored = 0;
    for (let i = 148; i < 156; i += 1) {
      const digit = header[i];
      if (digit < 0x30 || digit > 0x37) {
        if (digit === 0x20 || digit === 0x00) continue; // leading space / NUL padding
        return { ok: false, entries, error: `checksum field is not octal at byte ${offset}` };
      }
      stored = stored * 8 + (digit - 0x30);
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : header[i];

    if (sum !== stored) {
      return { ok: false, entries, error: `header checksum mismatch at byte ${offset} (${sum} != ${stored})` };
    }

    // The size is octal in 12 bytes; NUL and space terminate it.
    const sizeField = header.subarray(124, 136).toString('latin1').replace(/[\0 ]+$/, '');
    if (!/^[0-7]*$/.test(sizeField)) {
      return { ok: false, entries, error: `size field is not octal at byte ${offset}` };
    }
    const size = parseInt(sizeField || '0', 8);
    if (!Number.isFinite(size)) return { ok: false, entries, error: `size field is not a number at byte ${offset}` };

    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    entries += 1;
    // An entry that promises more bytes than the buffer holds is a truncated
    // tail — the failure this walk exists to find. A tar that ends exactly at
    // the last entry's bytes (no zero blocks) is still readable.
    if (offset > tar.length) {
      return { ok: false, entries, error: `truncated tail: entry at byte ${offset - BLOCK - Math.ceil(size / BLOCK) * BLOCK} promises ${size} bytes, archive ends at ${tar.length}` };
    }
  }

  // Anything left over is less than one block: a header or a padding block cut
  // mid-write. A readable tar ends on a block boundary — complete zero-block
  // padding is consumed by the loop above, so a partial remainder (even an
  // all-zero one) is a truncated tail, not padding.
  const remainder = tar.length - offset;
  if (remainder > 0) {
    return { ok: false, entries, error: `truncated tail: ${remainder} trailing byte(s) after the last full block (archive ends mid-block at ${tar.length})` };
  }

  return { ok: true, entries };
}

/**
 * One archive, gzip-then-tar. `gunzipSync` reads the whole stream, which is the
 * truncation check (`gzip -t` had no equivalent in Node): a file whose CRC or
 * length trailer does not match throws here.
 *
 * @param {string} file
 * @returns {{ok: boolean, entries: number, error?: string}}
 */

/**
 * One archive, gzip-then-tar. `gunzipSync` reads the whole stream, which is the
 * truncation check (`gzip -t` had no equivalent in Node): a file whose CRC or
 * length trailer does not match throws here.
 *
 * @param {string} file
 * @returns {{ok: boolean, entries: number, error?: string}}
 */
function checkTarGz(file) {
  let inflated;
  try {
    inflated = gunzipSync(readFileSync(file));
  } catch (err) {
    return { ok: false, entries: 0, error: `not a valid gzip stream (${err.message})` };
  }
  return walkTar(inflated);
}

function oracleVerifyBackup(dir) {
  const checks = [];
  const done = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

  // A re-verification starts clean: a marker left by an earlier green run must
  // not survive a failing one, or restore.mjs would accept a broken backup.
  rmSync(path.join(dir, 'verified'), { force: true });

  const dump = path.join(dir, 'db.sql.gz');
  if (!existsSync(dump)) {
    done('db.sql.gz', false, 'missing');
    return { ok: false, checks, error: 'db.sql.gz missing' };
  }
  done('db.sql.gz', true, 'present');

  let sql;
  try {
    sql = gunzipSync(readFileSync(dump));
  } catch (err) {
    done('dump gunzips', false, err.message);
    return { ok: false, checks, error: `db.sql.gz is not a valid gzip stream (${err.message})` };
  }
  done('dump gunzips', true, `${sql.length} bytes of SQL`);

  const tables = sql.toString('latin1').match(/^CREATE TABLE /gm)?.length ?? 0;
  if (!done('dump names tables', tables > 0, `${tables} CREATE TABLE statements`)) {
    return { ok: false, checks, error: 'db.sql.gz holds no tables' };
  }

  const manifestFile = path.join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) {
    done('manifest.json', false, 'missing');
    return { ok: false, checks, error: 'manifest.json missing' };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    done('manifest.json', false, err.message);
    return { ok: false, checks, error: `manifest.json is not valid JSON (${err.message})` };
  }
  done('manifest.json', true, 'valid JSON');

  const volumes = path.join(dir, 'volumes');
  const listed = Array.isArray(manifest.volumes) ? manifest.volumes : [];

  // Every volume the manifest promises must be here as a walkable archive —
  // the manifest is the backup's own inventory, so a name without its file is
  // an incomplete backup, not an empty store.
  const missing = listed.filter(v => !v || typeof v.name !== 'string' || !existsSync(path.join(volumes, `${v.name}.tar.gz`)));
  if (missing.length > 0) {
    const names = missing.map(v => (v && typeof v.name === 'string' ? v.name : '(unnamed volume)')).join(', ');
    done('manifest volumes', false, `missing archive(s): ${names}`);
    return { ok: false, checks, error: `manifest lists volume(s) without an archive in volumes/: ${names}` };
  }

  // P5b D7: no volumes/ directory at all is an incomplete backup, not an empty
  // store — the old `if (existsSync(volumes))` bypass let exactly that shape
  // earn the marker. The directory must exist AND hold at least one archive.
  if (!existsSync(volumes)) {
    done('volume archives', false, 'volumes/ directory missing');
    return { ok: false, checks, error: 'volumes/ directory is missing — the backup holds no archives' };
  }
  const archives = readdirSync(volumes).filter(name => name.endsWith('.tar.gz')).sort();
  if (!done('volume archives', archives.length > 0, `${archives.length} archive(s)`)) {
    return { ok: false, checks, error: 'volumes/ holds no archives' };
  }
  for (const archive of archives) {
    const walk = checkTarGz(path.join(volumes, archive));
    if (!done(`archive ${archive}`, walk.ok, walk.ok ? `${walk.entries} entries` : walk.error ?? 'unreadable')) {
      return { ok: false, checks, error: `volume archive ${archive} is unreadable` };
    }
  }

  // Last, and only on the way out with everything green: the marker is what
  // makes the backup restorable, so a failure above never leaves it behind.
  writeFileSync(path.join(dir, 'verified'), '');
  return { ok: true, checks };
}

/**
 * The backup a run just produced: the newest timestamped directory under the
 * backup root. Backup names are UTC timestamps to the second
 * (`2026-11-17T09-15-04Z`), so lexicographic order is chronological order.
 *
 * @param {string} root — the backup root the service writes into.
 * @returns {string|null} the newest backup's path, or null when there is none.
 */

// ============================================================
// TAR FIXTURES (>=12 variants × 5 chunk sizes = 60 tests)
// ============================================================

/** A tar with one file entry, built by hand: valid header checksum, octal size, two zero blocks at the end. */
function tinyTar(name, content) {
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'latin1');
  header.write('0000644', 100, 'latin1');
  header.write('0000000', 108, 'latin1');
  header.write('0000000', 116, 'latin1');
  header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 'latin1');
  header.write('00000000000 ', 136, 'latin1');
  header.write('        ', 148, 'latin1'); // checksum field read as spaces while summing
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\\0 `, 148, 'latin1');

  const body = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
  Buffer.from(content).copy(body);
  return Buffer.concat([header, body, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)]);
}

const tarFixtures = [
  { name: 'good single entry', build: () => tinyTar('a.txt', 'hello') },
  { name: 'one trailing zero block', build: () => Buffer.concat([tinyTar('a.txt', 'hello'), Buffer.alloc(512)]) },
  { name: 'no trailing zero block (ends on entry bytes)', build: () => {
    const t = tinyTar('a.txt', 'hello');
    return t.subarray(0, t.length - 1024);
  }},
  { name: 'cut body mid-entry', build: () => {
    const t = tinyTar('a.txt', 'x'.repeat(1200));
    return t.subarray(0, 512 + 1100);
  }},
  { name: 'cut inside zero-block padding', build: () => {
    const t = tinyTar('a.txt', 'hello');
    return t.subarray(0, t.length - 200);
  }},
  { name: 'junk after end marker', build: () => Buffer.concat([tinyTar('a.txt', 'hello'), Buffer.from('junk')]) },
  { name: 'header checksum mismatch', build: () => {
    const t = tinyTar('a.txt', 'hello');
    t[10] ^= 0xff;
    return t;
  }},
  { name: 'non-octal checksum digit', build: () => {
    const t = tinyTar('a.txt', 'hello');
    t[148] = 0x39; // '9' is not octal
    return t;
  }},
  { name: 'non-octal size field', build: () => {
    const t = tinyTar('a.txt', 'hello');
    t[124] = 0x39; // '9' in size field
    return t;
  }},
  { name: 'two entries (content after end marker if truncated)', build: () => Buffer.concat([tinyTar('a.txt', 'hello'), tinyTar('b.txt', 'world')]) },
  { name: '100 bytes of junk (shorter than one block)', build: () => Buffer.alloc(100, 0xaa) },
  { name: 'empty buffer', build: () => Buffer.alloc(0) },
  { name: 'single-byte body entry', build: () => tinyTar('x', 'X') },
];

const chunkSizes = [1, 7, 511, 512, 513];

describe('DW-3.1: TarWalker deep-equals oracle walkTar on all fixtures at all chunk sizes', () => {
  for (const fixture of tarFixtures) {
    for (const chunkSize of chunkSizes) {
      test(fixture.name + ' with chunkSize=' + chunkSize, () => {
        const tar = fixture.build();
        const oracleResult = walkTar(tar);
        const walker = new TarWalker();
        for (let i = 0; i < tar.length; i += chunkSize) {
          walker.push(tar.subarray(i, Math.min(i + chunkSize, tar.length)));
        }
        const walkerResult = walker.end();
        assert.deepStrictEqual(walkerResult, oracleResult, 'mismatch for ' + fixture.name + ' @ chunk=' + chunkSize);
      });
    }
  }
});

// ============================================================
// BACKUP FIXTURES (>=10 without marker-dir or unwritable-problem cases)
// ============================================================

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'vl-walker-'));
}

function goodBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\nCREATE TABLE scenario_versions (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('objects/aa/hash.zip', 'zip-bytes')));
  writeFileSync(path.join(dir, 'volumes', 'lti.tar.gz'), gzipSync(tinyTar('tool-key.pem', 'pem-bytes')));
  return dir;
}

const backupFixtures = [
  { name: 'good backup', build: goodBackup },
  { name: 'good with manifest volumes', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [{ name: 'archives' }] }));
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    return dir;
  }},
  { name: 'missing dump', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    return dir;
  }},
  { name: 'truncated gzip dump', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    const gz = gzipSync('CREATE TABLE t (id int);\n');
    writeFileSync(path.join(dir, 'db.sql.gz'), gz.subarray(0, Math.floor(gz.length / 2)));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    return dir;
  }},
  { name: 'dump no CREATE TABLE', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('-- nothing here\n'));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    return dir;
  }},
  { name: 'manifest not JSON', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeFileSync(path.join(dir, 'manifest.json'), '{ not json');
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    return dir;
  }},
  { name: 'missing manifest', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    return dir;
  }},
  { name: 'unreadable archive (truncated tar)', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
    const tar = tinyTar('a.txt', 'x'.repeat(1200));
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tar.subarray(0, 512 + 1100)));
    return dir;
  }},
  { name: 'corrupted tar checksum', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
    const tar = tinyTar('a.txt', 'hello');
    tar[10] ^= 0xff;
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tar));
    return dir;
  }},
  { name: 'volumes dir empty (no archives)', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
    return dir;
  }},
  { name: 'missing volumes dir', build: (dir) => {
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
    return dir;
  }},
  { name: 'manifest volume missing archive', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [{ name: 'missing' }] }));
    return dir;
  }},
];

describe('DW-3.2: refactored verifyBackup deep-equals oracle on >=10 backup fixtures', () => {
  for (const fixture of backupFixtures) {
    test(fixture.name, () => {
      const dir = fixture.build(tmp());
      const oracleResult = oracleVerifyBackup(dir);
      const refactoredResult = verifyBackup(dir);
      assert.deepStrictEqual(refactoredResult, oracleResult, 'mismatch for ' + fixture.name);
      rmSync(dir, { recursive: true, force: true });
    });
  }
});

describe('DW-3.3: guard command prints nothing', () => {
  test('no M/D/R on test scripts, backup test, package.json, or docker-compose files', () => {
    const res = spawnSync('git', [
      'diff', '--name-only', '--diff-filter=MDR', 'origin/ms/1...',
      '--', 'scripts/test', 'backup/restore.test.mjs', 'backup/test',
      'package.json', 'docker-compose*.yml'
    ], { encoding: 'utf8', cwd: process.cwd() });
    assert.equal(res.stdout.trim(), '', 'guard command produced stdout: ' + JSON.stringify(res.stdout));
    assert.equal(res.stderr.trim(), '', 'guard command produced stderr: ' + JSON.stringify(res.stderr));
  });
});
