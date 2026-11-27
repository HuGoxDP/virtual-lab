// backup/verify-backup.mjs
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

import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createGunzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The marker `restore.mjs` refuses to work without. Written last, on success only. */
export const VERIFIED_MARKER = 'verified';

const BLOCK = 512;
const NO_BYTES = Buffer.alloc(0);

/**
 * Incremental tar header walk: the same validation a whole-buffer walk does,
 * with at most one partial header block (never more than BLOCK bytes) held in
 * memory. Entry bodies are skipped by count, not stored. Errors that name the
 * total archive length (a short file, a truncated entry, a partial trailing
 * block) are decided in `end()`; every other error stops the walk on the chunk
 * that reveals it, and later pushes are ignored.
 *
 * Exported so the parity tests can drive it at every chunk boundary; it is not
 * a documented API. `walkTar(buf)` is push-the-whole-buffer + `end()`.
 */
export class TarWalker {
  constructor() {
    this.carry = NO_BYTES;   // bytes of the header block assembled so far (< BLOCK)
    this.total = 0;          // every byte pushed, including bytes after an error
    this.cursor = 0;         // absolute position just past consumed headers/bodies
    this.skip = 0;           // entry body + padding bytes still to skip
    this.entries = 0;
    this.zeroBlocks = 0;
    this.error = null;
    this.lastEntry = null;   // the entry whose tail can still be truncated
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.total += chunk.length;
    if (this.error) return;

    let pos = 0;
    while (pos < chunk.length) {
      if (this.skip > 0) {
        const taken = Math.min(this.skip, chunk.length - pos);
        this.skip -= taken;
        this.cursor += taken;
        pos += taken;
        continue;
      }

      const taken = Math.min(BLOCK - this.carry.length, chunk.length - pos);
      const part = chunk.subarray(pos, pos + taken);
      this.carry = this.carry.length === 0 ? Buffer.from(part) : Buffer.concat([this.carry, part]);
      pos += taken;
      if (this.carry.length < BLOCK) break;

      const header = this.carry;
      const offset = this.cursor;
      this.carry = NO_BYTES;

      if (header.every(byte => byte === 0)) {
        // One zero block marks the end; a file that ends on the first one is
        // still a readable tar.
        this.zeroBlocks += 1;
        this.cursor += BLOCK;
        continue;
      }
      if (this.zeroBlocks > 0) {
        this.error = `content after the end-of-archive marker at byte ${offset}`;
        return;
      }

      // The checksum is octal, with its own field read as spaces.
      let stored = 0;
      for (let i = 148; i < 156; i += 1) {
        const digit = header[i];
        if (digit < 0x30 || digit > 0x37) {
          if (digit === 0x20 || digit === 0x00) continue; // leading space / NUL padding
          this.error = `checksum field is not octal at byte ${offset}`;
          return;
        }
        stored = stored * 8 + (digit - 0x30);
      }
      let sum = 0;
      for (let i = 0; i < BLOCK; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : header[i];
      if (sum !== stored) {
        this.error = `header checksum mismatch at byte ${offset} (${sum} != ${stored})`;
        return;
      }

      // The size is octal in 12 bytes; NUL and space terminate it.
      const sizeField = header.subarray(124, 136).toString('latin1').replace(/[\0 ]+$/, '');
      if (!/^[0-7]*$/.test(sizeField)) {
        this.error = `size field is not octal at byte ${offset}`;
        return;
      }
      const size = parseInt(sizeField || '0', 8);
      if (!Number.isFinite(size)) {
        this.error = `size field is not a number at byte ${offset}`;
        return;
      }

      const padded = Math.ceil(size / BLOCK) * BLOCK;
      this.cursor += BLOCK;
      this.entries += 1;
      this.lastEntry = { at: offset, end: this.cursor + padded, size };
      this.skip = padded;
    }
  }

  /** @returns {{ok: boolean, entries: number, error?: string}} */
  end() {
    if (this.error) return { ok: false, entries: this.entries, error: this.error };

    // A whole-buffer walk fails at the first entry whose promised body is not
    // there. More chunks may still arrive while streaming, so the decision is
    // made here, against the final length — and wins over a partial tail.
    const last = this.lastEntry;
    if (last && this.total < last.end) {
      return { ok: false, entries: this.entries, error: `truncated tail: entry at byte ${last.at} promises ${last.size} bytes, archive ends at ${this.total}` };
    }
    if (this.total < BLOCK) {
      return { ok: false, entries: 0, error: `shorter than one header block (${this.total} bytes)` };
    }
    // A readable tar ends on a block boundary; a partial block is a cut header
    // or padding, even when every one of its bytes is zero.
    if (this.carry.length > 0) {
      return { ok: false, entries: this.entries, error: `truncated tail: ${this.carry.length} trailing byte(s) after the last full block (archive ends mid-block at ${this.total})` };
    }
    return { ok: true, entries: this.entries };
  }
}

/**
 * Walks a tar's headers from a buffer and proves it parses end to end.
 *
 * @param {Buffer} tar
 * @returns {{ok: boolean, entries: number, error?: string}}
 */
function walkTar(tar) {
  const walker = new TarWalker();
  walker.push(tar);
  return walker.end();
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
 * The one place the marker is touched. Clearing it starts a verification clean;
 * writing it ends a green one. A marker that cannot be removed or written is a
 * named failure, not an exception: a stale marker must never make a broken
 * backup look restorable, and a root-owned backup dir must not crash the CLI.
 *
 * @param {string} dir — the backup directory.
 * @param {'clear'|'write'} action
 * @returns {{check: {name: string, ok: boolean, detail: string}, error: string}|null}
 */
function settleMarker(dir, action) {
  try {
    if (action === 'clear') rmSync(path.join(dir, VERIFIED_MARKER), { force: true });
    else writeFileSync(path.join(dir, VERIFIED_MARKER), '');
    return null;
  } catch (err) {
    const what = action === 'clear' ? 'cannot remove the stale verified marker' : 'cannot write the verified marker';
    return {
      check: { name: 'verified marker', ok: false, detail: err.message },
      error: `${what}: ${err.message}`,
    };
  }
}

/**
 * Internal generator that yields the sequence of read requests for a backup
 * directory. The driver receives results and returns the next request, or
 * finishes with the final result.
 *
 * Yields: { kind: 'dump', file } | { kind: 'archive', file }
 * Receives: { ok: true, bytes, tables } | { ok: false, message } for dump
 *           { ok, entries, error? } for archive
 * Returns: { ok, checks, error? }
 */
function* verifySteps(dir) {
  const checks = [];
  const done = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

  // A re-verification starts clean: a marker left by an earlier green run must
  // not survive a failing one, or restore.mjs would accept a broken backup.
  // When the stale marker cannot be removed nothing else runs — the backup's
  // state cannot be trusted while it survives.
  const cleared = settleMarker(dir, 'clear');
  if (cleared) return { ok: false, checks: [cleared.check], error: cleared.error };

  const dump = path.join(dir, 'db.sql.gz');
  if (!existsSync(dump)) {
    done('db.sql.gz', false, 'missing');
    return { ok: false, checks, error: 'db.sql.gz missing' };
  }
  done('db.sql.gz', true, 'present');

  // Yield dump request
  const dumpResult = yield { kind: 'dump', file: dump };
  if (!dumpResult.ok) {
    done('dump gunzips', false, dumpResult.message);
    return { ok: false, checks, error: `db.sql.gz is not a valid gzip stream (${dumpResult.message})` };
  }
  done('dump gunzips', true, `${dumpResult.bytes} bytes of SQL`);

  if (!done('dump names tables', dumpResult.tables > 0, `${dumpResult.tables} CREATE TABLE statements`)) {
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
    const archiveResult = yield { kind: 'archive', file: path.join(volumes, archive) };
    if (!done(`archive ${archive}`, archiveResult.ok, archiveResult.ok ? `${archiveResult.entries} entries` : archiveResult.error ?? 'unreadable')) {
      return { ok: false, checks, error: `volume archive ${archive} is unreadable` };
    }
  }

  // Last, and only on the way out with everything green: the marker is what
  // makes the backup restorable, so a failure above never leaves it behind.
  const written = settleMarker(dir, 'write');
  if (written) return { ok: false, checks: [...checks, written.check], error: written.error };
  return { ok: true, checks };
}

/**
 * Verifies one backup directory and — only when every check passes — writes the
 * `verified` marker `restore.mjs` requires.
 *
 * @param {string} dir — one backup directory (the timestamped one).
 * @returns {{ok: boolean, checks: Array<{name: string, ok: boolean, detail: string}>, error?: string}}
 */
export function verifyBackup(dir) {
  const gen = verifySteps(dir);
  let step = gen.next();
  while (!step.done) {
    const { kind, file } = step.value;
    let result;
    if (kind === 'dump') {
      let sql;
      try {
        sql = gunzipSync(readFileSync(file));
      } catch (err) {
        result = { ok: false, message: err.message };
        step = gen.next(result);
        continue;
      }
      const tables = sql.toString('latin1').match(/^CREATE TABLE /gm)?.length ?? 0;
      result = { ok: true, bytes: sql.length, tables };
    } else if (kind === 'archive') {
      result = checkTarGz(file);
    }
    step = gen.next(result);
  }
  return step.value;
}

/**
 * Streams one gzipped file, feeding every inflated chunk to `onChunk`.
 * Returns `null` on success, or the read/gzip error message. The gunzip is
 * drained even when `onChunk` records a tar error, so a later gzip error still
 * wins — matching `gunzipSync` before `walkTar` in the sync path.
 *
 * @param {string} file
 * @param {{highWaterMark?: number, chunkSize?: number}} opts
 * @param {(chunk: Buffer) => void} onChunk
 * @returns {Promise<string|null>} error message or null
 */
async function streamGzip(file, opts, onChunk) {
  const readOpts = opts.highWaterMark === undefined ? undefined : { highWaterMark: opts.highWaterMark };
  const gzipOpts = opts.chunkSize === undefined ? undefined : { highWaterMark: opts.chunkSize };
  try {
    await pipeline(
      createReadStream(file, readOpts),
      createGunzip(gzipOpts),
      async source => { for await (const chunk of source) onChunk(chunk); },
    );
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Verifies one backup directory through streams: the dump and every volume
 * archive are decompressed incrementally, never read whole. The result is
 * deep-equal to `verifyBackup(dir)` on every backup, including failure keys
 * and check details. Dump/archive read errors resolve as `{ok:false}`; a
 * `readdirSync(volumes)` failure rejects, as it does in `verifyBackup` —
 * both paths stay in parity on that case too.
 *
 * @param {string} dir — one backup directory (the timestamped one).
 * @param {{highWaterMark?: number, chunkSize?: number}} [opts] — read/gunzip
 *   chunk sizes, test-only; defaults match Node's built-ins.
 * @returns {Promise<{ok: boolean, checks: Array<{name: string, ok: boolean, detail: string}>, error?: string}>}
 */
export async function verifyBackupStream(dir, opts = {}) {
  const gen = verifySteps(dir);
  let step = gen.next();
  while (!step.done) {
    const { kind, file } = step.value;
    let result;
    if (kind === 'dump') {
      const state = { carry: '\n', bytes: 0, tables: 0 };
      const onChunk = chunk => {
        state.bytes += chunk.length;
        const both = state.carry + chunk.toString('latin1');
        state.tables += (both.match(/[\n\r]CREATE TABLE /g)?.length ?? 0);
        state.carry = both.slice(-13);
      };
      const err = await streamGzip(file, opts, onChunk);
      if (err) result = { ok: false, message: err };
      else result = { ok: true, bytes: state.bytes, tables: state.tables };
      step = gen.next(result);
      continue;
    }
    if (kind === 'archive') {
      const walker = new TarWalker();
      const err = await streamGzip(file, opts, chunk => { walker.push(chunk); });
      if (err) result = { ok: false, entries: 0, error: `not a valid gzip stream (${err})` };
      else result = walker.end();
      step = gen.next(result);
      continue;
    }
    step = gen.next({ ok: false, message: `unknown read request: ${kind}` });
  }
  return step.value;
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

/**
 * Why `root` cannot be a backup root, or null when it can: a path that is not
 * there, a regular file, or a directory this user may not read. Without the
 * check `newestBackup` returns null for the first two (and the admin cannot
 * tell which happened) and throws an unnamed `readdirSync` error for the third.
 *
 * @param {string} root — the path given after `--newest`.
 * @returns {string|null} the reason, or null when the root can be read.
 */
function rootProblem(root) {
  if (!existsSync(root)) return 'no such directory';
  try {
    readdirSync(root, { withFileTypes: true });
    return null;
  } catch (error) {
    if (error.code === 'ENOTDIR') return 'not a directory';
    if (error.code === 'EACCES' || error.code === 'EPERM') return 'unreadable';
    return error.message;
  }
}

/**
 * One line for an error the CLI names without a stack trace: the code first
 * (`EACCES`, `ENOTDIR`, `error` when the thrower named none), then the message
 * with the code prefix Node already baked into it removed.
 *
 * @param {unknown} error
 * @returns {string}
 */
function namedError(error) {
  const named = error !== null && typeof error === 'object';
  const code = (named && error.code) ? String(error.code) : 'error';
  const raw = (named && error.message) ? String(error.message) : String(error);
  const message = raw.startsWith(`${code}: `) ? raw.slice(code.length + 2) : raw;
  return `${code}: ${message}`;
}

/**
 * True when `argv1` names this very file — directly, or through a symlink to
 * it. `path.resolve` alone misses the symlink case: an admin who links one
 * name to the CLI (`~/.local/bin/verify-backup -> …/backup/verify-backup.mjs`)
 * gets `process.argv[1]` as the link, the resolve misses and the CLI verifies
 * nothing in silence. The real path decides, so both entries (this file and
 * scripts/lib) share this one check.
 *
 * @param {string|undefined} argv1 — `process.argv[1]`.
 * @param {string} entryUrl — the entry module's own `import.meta.url`.
 * @returns {boolean}
 */
export function isMainModule(argv1, entryUrl) {
  if (!argv1) return false;
  const target = fileURLToPath(entryUrl);
  let here;
  try {
    here = path.resolve(argv1);
    if (here === target) return true;
    return realpathSync(here) === realpathSync(target);
  } catch {
    return here === target;
  }
}

/**
 * The shared CLI body: `node verify-backup.mjs <backup-dir>` or
 * `node verify-backup.mjs --newest <backup-root>` — the step the restore
 * procedure runs before `restore.mjs` will accept a backup. One line per
 * check, exit 0 only when the marker was written, 1 for a failed backup,
 * 2 for a malformed command or a root with no backups.
 *
 * Async from the start so a later streaming verifier only swaps the call it
 * awaits; both entry files (here and scripts/lib) call this one function.
 *
 * @param {string[]} argv — arguments without node/script (process.argv.slice(2)).
 * @param {{out?: {write: function(string): unknown}, err?: {write: function(string): unknown}}} [io]
 * @returns {Promise<0|1|2>} the exit code.
 */
export async function runCli(argv, io = {}) {
  const out = io.out ?? process.stdout;
  const err = io.err ?? process.stderr;
  const usage = () => {
    err.write('usage: node verify-backup.mjs <backup-dir> | --newest <backup-root>\n');
    return 2;
  };

  let dir;
  if (argv.length === 1 && argv[0] && !argv[0].startsWith('-')) {
    dir = argv[0];
  } else if (argv.length === 2 && argv[0] === '--newest' && argv[1] && !argv[1].startsWith('-')) {
    const problem = rootProblem(argv[1]);
    if (problem) {
      err.write(`no backup directory under ${argv[1]} (${problem})\n`);
      return 2;
    }
    dir = newestBackup(argv[1]);
    if (!dir) {
      err.write(`no backup directory under ${argv[1]}\n`);
      return 2;
    }
    out.write(`newest backup: ${dir}\n`);
  } else {
    return usage();
  }

  // An fs error the verifier itself did not name — an unreadable volumes/
  // directory, a permission that changed mid-run — is one named line and exit
  // 1, never a stack trace over the checks an admin is meant to read.
  let result;
  try {
    result = await verifyBackupStream(dir);
  } catch (error) {
    out.write(`not verified: ${namedError(error)}\n`);
    return 1;
  }
  for (const check of result.checks) out.write(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`);
  out.write(result.ok ? `verified: ${dir}\n` : `not verified: ${result.error}\n`);
  return result.ok ? 0 : 1;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      // Whatever escapes runCli's own handling: named, once, exit 1.
      process.stderr.write(`verify-backup failed: ${namedError(error)}\n`);
      process.exit(1);
    });
}
