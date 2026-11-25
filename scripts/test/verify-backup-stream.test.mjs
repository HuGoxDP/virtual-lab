// scripts/test/verify-backup-stream.test.mjs
//
// Phase 4 oracle tests: verifyBackupStream must resolve deep-equal to the
// synchronous verifier on every backup shape, including marker failures and
// fs/gzip errors, while never reading a large archive whole.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { verifyBackup, verifyBackupStream } from '../../backup/verify-backup.mjs';

const BLOCK = 512;
const IMPL = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backup/verify-backup.mjs')).href;

/** A tar with one file entry, built by hand (same shape as the Phase-3 oracle). */
function tinyTar(name, content) {
  const bodyBytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'latin1');
  header.write('0000644', 100, 'latin1');
  header.write('0000000', 108, 'latin1');
  header.write('0000000', 116, 'latin1');
  header.write(`${bodyBytes.length.toString(8).padStart(11, '0')} `, 124, 'latin1');
  header.write('00000000000 ', 136, 'latin1');
  header.write('        ', 148, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');

  const body = Buffer.alloc(Math.ceil(bodyBytes.length / BLOCK) * BLOCK);
  bodyBytes.copy(body);
  return Buffer.concat([header, body, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)]);
}

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'vl-stream-'));
}

function writeManifest(dir, volumes = []) {
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes }));
}

function goodBackup(dir, sql = 'CREATE TABLE t (id int);\n') {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync(sql));
  writeManifest(dir);
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
  return dir;
}

function bigBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
  writeManifest(dir);
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('big.bin', randomBytes(11 * 1024 * 1024))));
  return dir;
}

/** Runs the whole-file-read trap in a child so the patch cannot leak to other tests. */
function runWithTrap(dir) {
  const script = `
    import fs from 'node:fs';
    import zlib from 'node:zlib';
    import { syncBuiltinESMExports } from 'node:module';
    import { verifyBackup, verifyBackupStream } from ${JSON.stringify(IMPL)};
    const dir = ${JSON.stringify(dir)};
    const expected = verifyBackup(dir);
    const realRead = fs.readFileSync;
    const realGunzip = zlib.gunzipSync;
    fs.readFileSync = (...args) => {
      if (String(args[0]).endsWith('.gz')) throw new Error('whole-file read attempted');
      return realRead(...args);
    };
    zlib.gunzipSync = () => { throw new Error('whole-file gunzip attempted'); };
    syncBuiltinESMExports();
    let actual;
    try {
      actual = await verifyBackupStream(dir);
    } finally {
      fs.readFileSync = realRead;
      zlib.gunzipSync = realGunzip;
      syncBuiltinESMExports();
    }
    console.log(JSON.stringify({ expected, actual }));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim());
}
const fixtures = [
  { name: 'good backup (one archive)', build: goodBackup },
  { name: 'good backup (two archives + manifest volumes)', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE a (id int);\nCREATE TABLE b (id int);\n'));
    writeManifest(dir, [{ name: 'archives' }, { name: 'lti' }]);
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    writeFileSync(path.join(dir, 'volumes', 'lti.tar.gz'), gzipSync(tinyTar('pem', 'pem-bytes')));
    return dir;
  }},
  { name: 'missing dump', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeManifest(dir);
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    return dir;
  }},
  { name: 'dump is a directory (EISDIR)', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    mkdirSync(path.join(dir, 'db.sql.gz'));
    writeManifest(dir);
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    return dir;
  }},
  { name: 'truncated gzip dump', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    const gz = gzipSync('CREATE TABLE t (id int);\n');
    writeFileSync(path.join(dir, 'db.sql.gz'), gz.subarray(0, Math.floor(gz.length / 2)));
    writeManifest(dir);
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    return dir;
  }},
  { name: 'dump with no CREATE TABLE', build: (dir) => goodBackup(dir, '-- nothing here\n') },
  { name: 'CRLF dump', build: (dir) => goodBackup(dir, 'CREATE TABLE a (id int);\r\nCREATE TABLE b (id int);\r\n') },
  { name: 'CR-only dump', build: (dir) => goodBackup(dir, 'CREATE TABLE a (id int);\rCREATE TABLE b (id int);\r') },
  { name: 'statement at byte 0', build: (dir) => goodBackup(dir, 'CREATE TABLE t (id int);') },
  { name: 'mid-line occurrence is not a statement', build: (dir) => goodBackup(dir, 'xxCREATE TABLE t (id int);\n') },
  { name: 'manifest not JSON', build: (dir) => {
    goodBackup(dir);
    writeFileSync(path.join(dir, 'manifest.json'), '{ not json');
    return dir;
  }},
  { name: 'missing manifest', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
    return dir;
  }},
  { name: 'manifest volume missing archive', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeManifest(dir, [{ name: 'missing' }]);
    return dir;
  }},
  { name: 'volumes dir empty', build: (dir) => {
    mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeManifest(dir);
    return dir;
  }},
  { name: 'missing volumes dir', build: (dir) => {
    writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
    writeManifest(dir);
    return dir;
  }},
  { name: 'unreadable archive (truncated tar)', build: (dir) => {
    goodBackup(dir);
    const tar = tinyTar('a.txt', 'x'.repeat(1200));
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tar.subarray(0, 512 + 1100)));
    return dir;
  }},
  { name: 'corrupted tar checksum', build: (dir) => {
    goodBackup(dir);
    const tar = tinyTar('a.txt', 'hello');
    tar[10] ^= 0xff;
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tar));
    return dir;
  }},
  { name: 'archive is not gzip', build: (dir) => {
    goodBackup(dir);
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), Buffer.from('not gzip at all'));
    return dir;
  }},
  { name: 'gzip error wins over bad tar header', build: (dir) => {
    goodBackup(dir);
    const tar = tinyTar('a.txt', 'hello');
    tar[10] ^= 0xff;
    const gz = gzipSync(tar);
    writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gz.subarray(0, Math.floor(gz.length / 2)));
    return dir;
  }},
  { name: 'verified is a directory', build: (dir) => {
    goodBackup(dir);
    mkdirSync(path.join(dir, 'verified'));
    return dir;
  }},
];
describe('DW-4.1: stream parity with verifyBackup on every fixture', () => {
  for (const fixture of fixtures) {
    test(fixture.name, async () => {
      const dir = fixture.build(tmp());
      const sync = verifyBackup(dir);
      const markerAfterSync = existsSync(path.join(dir, 'verified'));
      let streamed;
      await assert.doesNotReject(async () => { streamed = await verifyBackupStream(dir); });
      assert.deepStrictEqual(streamed, sync, fixture.name);
      assert.equal(existsSync(path.join(dir, 'verified')), markerAfterSync, 'marker presence differs');
      rmSync(dir, { recursive: true, force: true });
    });
  }
});

describe('DW-4.2: chunk boundaries', () => {
  test('tiny read/gunzip chunks count a multi-statement dump identically', async () => {
    const dir = tmp();
    goodBackup(dir, 'CREATE TABLE a (id int);\r\nCREATE TABLE b (id int);\rCREATE TABLE c (id int);\nCREATE TABLE d (id int);\n');
    const sync = verifyBackup(dir);
    const streamed = await verifyBackupStream(dir, { highWaterMark: 16, chunkSize: 64 });
    assert.deepStrictEqual(streamed, sync);
    assert.equal(streamed.checks.find(c => c.name === 'dump names tables').detail, '4 CREATE TABLE statements');
    rmSync(dir, { recursive: true, force: true });
  });

  test('default chunks count a statement straddling inflated byte 16384', async () => {
    const dir = tmp();
    const sql = 'x'.repeat(16383) + '\nCREATE TABLE t (id int);\n';
    goodBackup(dir, sql);
    const sync = verifyBackup(dir);
    const streamed = await verifyBackupStream(dir);
    assert.deepStrictEqual(streamed, sync);
    assert.equal(streamed.checks.find(c => c.name === 'dump names tables').detail, '1 CREATE TABLE statements');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('DW-4.3 / DW-4.4: a large archive is streamed, not read whole', () => {
  test('>= 10 MiB archive verifies under patched readFileSync/gunzipSync', async () => {
    const dir = bigBackup(tmp());
    const archive = path.join(dir, 'volumes', 'archives.tar.gz');
    const size = statSync(archive).size;
    assert.ok(size >= 10 * 1024 * 1024, `archive too small: ${size}`);
    const { expected, actual } = runWithTrap(dir);
    assert.deepStrictEqual(actual, expected);
    assert.equal(actual.ok, true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the same archive cut in half fails identically, named', async () => {
    const dir = bigBackup(tmp());
    const archive = path.join(dir, 'volumes', 'archives.tar.gz');
    const gz = fs.readFileSync(archive);
    writeFileSync(archive, gz.subarray(0, Math.floor(gz.length / 2)));
    const { expected, actual } = runWithTrap(dir);
    assert.deepStrictEqual(actual, expected);
    assert.equal(actual.ok, false);
    assert.equal(actual.error, 'volume archive archives.tar.gz is unreadable');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('DW-4.5: sync API, re-export, guard', () => {
  test('verifyBackup stays synchronous', () => {
    const dir = goodBackup(tmp());
    const result = verifyBackup(dir);
    assert.equal(result instanceof Promise, false);
    assert.equal(typeof result.then, 'undefined');
    rmSync(dir, { recursive: true, force: true });
  });

  test('the lib re-exports the same stream function', async () => {
    const lib = await import('../lib/verify-backup.mjs');
    assert.equal(lib.verifyBackupStream, verifyBackupStream);
  });

  test('guard command prints nothing', () => {
    const res = spawnSync('git', [
      'diff', '--name-only', '--diff-filter=MDR', 'origin/ms/1...',
      '--', 'scripts/test', 'backup/restore.test.mjs', 'backup/test',
      'package.json', 'docker-compose*.yml'
    ], { encoding: 'utf8', cwd: process.cwd() });
    assert.equal(res.stdout.trim(), '');
    assert.equal(res.stderr.trim(), '');
  });
});
