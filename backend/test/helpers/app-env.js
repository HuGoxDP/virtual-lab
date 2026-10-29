// backend/test/helpers/app-env.js
//
// What the archive-handling integration tests share: a throwaway archive store, distinct
// valid archives on demand, and a few request shorthands. `ARCHIVE_ROOT` (and `GC_MIN_AGE_MS`)
// are read when `storage.js` / `routes/storage-admin.js` load, so a test file requires this
// module BEFORE `../../server`.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-itest-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;

const { validArchive } = require('./fixtures');

/** A valid archive whose bytes (so its sha256) depend on `n`. */
const archiveN = (n, manifest = {}) => validArchive(manifest, { 'assets/n.txt': `archive ${n}` });

const sha256Of = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

const removeArchiveRoot = () => fsp.rm(ARCHIVE_ROOT, { recursive: true, force: true });

module.exports = { ARCHIVE_ROOT, archiveN, sha256Of, removeArchiveRoot };
