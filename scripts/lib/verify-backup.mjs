// scripts/lib/verify-backup.mjs
//
// The read-back that makes a backup a backup (the parts bin's decision D-9,
// `ops/deploy/remote/verify-backup.sh` on the unmerged OPS1 branch): the dump
// decompresses, its SQL names the tables it holds, the manifest is valid JSON,
// and every volume archive is a tar that can be walked end to end.
//
// A truncated file is a named failure here, not a red `ls` in the next step:
// `restore.mjs` refuses to restore a backup without the `verified` marker this
// writes, so an unverified dump is never a restore target — restoring one would
// trade an outage for data loss.
//
// It reads the *host* filesystem directly (no `docker exec`, no `tar` child
// process): the check runs on the machine that wrote the backup, so the path
// forms the remote script had to convert for never arise. The tar reader is a
// validation walk, not an extractor — a bad header checksum or a truncated
// final entry is the failure it exists to find.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

/** The marker `restore.mjs` refuses to work without. Written last, on success only. */
export const VERIFIED_MARKER = 'verified';

/**
 * Walks a tar's headers from a buffer and proves it parses end to end.
 *
 * A tar file is a sequence of 512-byte entries: a header whose checksum
 * matches, then the entry's bytes rounded up to a 512 boundary. The archive
 * ends at an all-zero block. Two things count as unreadable here — a header
 * whose stored checksum does not match (a file that was truncated mid-write and
 * re-assembled), and an archive whose last entry promises more bytes than the
 * buffer holds (a truncated tail).
 *
 * @param {Buffer} tar
 * @returns {{ok: boolean, entries: number, error?: string}}
 */
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
function checkTarGz(file) {
  let inflated;
  try {
    inflated = gunzipSync(readFileSync(file));
  } catch (err) {
    return { ok: false, entries: 0, error: `not a valid gzip stream (${err.message})` };
  }
  return walkTar(inflated);
}

/**
 * Verifies one backup directory and — only when every check passes — writes the
 * `verified` marker `restore.mjs` requires.
 *
 * @param {string} dir — one backup directory (the timestamped one).
 * @returns {{ok: boolean, checks: Array<{name: string, ok: boolean, detail: string}>, error?: string}}
 */
export function verifyBackup(dir) {
  const checks = [];
  const done = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

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

  const manifest = path.join(dir, 'manifest.json');
  if (!existsSync(manifest)) {
    done('manifest.json', false, 'missing');
    return { ok: false, checks, error: 'manifest.json missing' };
  }
  try {
    JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (err) {
    done('manifest.json', false, err.message);
    return { ok: false, checks, error: `manifest.json is not valid JSON (${err.message})` };
  }
  done('manifest.json', true, 'valid JSON');

  const volumes = path.join(dir, 'volumes');
  if (existsSync(volumes)) {
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
  }

  // Last, and only on the way out with everything green: the marker is what
  // makes the backup restorable, so a failure above never leaves it behind.
  writeFileSync(path.join(dir, VERIFIED_MARKER), '');
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
export function newestBackup(root) {
  if (!existsSync(root)) return null;
  const names = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
    .map(entry => entry.name)
    .sort();
  return names.length > 0 ? path.join(root, names[names.length - 1]) : null;
}