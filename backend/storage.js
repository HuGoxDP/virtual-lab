// backend/storage.js
//
// Content-addressed archive storage on a plain Docker volume.
//
// Archives are stored as `<sha256>.zip` and served by nginx from
// `/scenarios/<sha256>.zip`. Because the name *is* the content hash the object
// is immutable: nginx can cache it forever, and the same archive uploaded twice
// costs nothing. Express never streams these bytes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || '/srv/archives';
const OBJECTS_DIR = path.join(ARCHIVE_ROOT, 'objects');
const TMP_DIR = path.join(ARCHIVE_ROOT, 'tmp');

/** Public path prefix; must match the nginx `location ^~ /scenarios/` alias. */
const PUBLIC_PREFIX = '/scenarios';

/** Local ZIP signatures: regular, empty, and spanned archives. */
const ZIP_SIGNATURES = ['504b0304', '504b0506', '504b0708'];

async function ensureStorageDirs() {
  await fsp.mkdir(OBJECTS_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

function objectPath(sha256) {
  return path.join(OBJECTS_DIR, `${sha256}.zip`);
}

function publicUrl(sha256) {
  return `${PUBLIC_PREFIX}/${sha256}.zip`;
}

/** Reserves a unique path inside the archives volume — same filesystem, so the commit is a rename. */
function tempPath() {
  return path.join(TMP_DIR, `upload-${crypto.randomUUID()}.part`);
}

/**
 * Rejects anything that is not a ZIP before it can enter the store.
 * The engine would fail on it later anyway, with a far worse error.
 */
async function isZipFile(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 4) return false;
    return ZIP_SIGNATURES.includes(buffer.toString('hex'));
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Moves an already-written temp file into the store under its content hash.
 *
 * Returns `{ sha256, bytes, url, deduplicated }`. `deduplicated` means the
 * content was already present and the temp file was simply dropped.
 */
async function commitArchive(tmpFile) {
  if (!(await isZipFile(tmpFile))) {
    throw Object.assign(new Error('Файл не є ZIP-архівом'), { status: 400 });
  }

  const [sha256, stat] = await Promise.all([hashFile(tmpFile), fsp.stat(tmpFile)]);
  const target = objectPath(sha256);

  let deduplicated = false;
  try {
    await fsp.access(target);
    deduplicated = true;
    await fsp.unlink(tmpFile);
  } catch {
    await fsp.rename(tmpFile, target);
  }

  return { sha256, bytes: stat.size, url: publicUrl(sha256), deduplicated };
}

/** Writes a readable stream to a temp file; the caller commits or discards it. */
async function writeTempFromStream(readable) {
  const tmpFile = tempPath();
  await pipeline(readable, fs.createWriteStream(tmpFile));
  return tmpFile;
}

async function discardTemp(tmpFile) {
  if (!tmpFile) return;
  await fsp.unlink(tmpFile).catch(() => {});
}

/** Best-effort sweep of temp files left behind by a crash or a killed upload. */
async function cleanStaleTemp(maxAgeMs = 6 * 60 * 60 * 1000) {
  let names;
  try {
    names = await fsp.readdir(TMP_DIR);
  } catch {
    return;
  }

  const cutoff = Date.now() - maxAgeMs;

  for (const name of names) {
    const file = path.join(TMP_DIR, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.mtimeMs < cutoff) await fsp.unlink(file);
    } catch {
      // Raced with another sweep or an active upload — leave it.
    }
  }
}

module.exports = {
  ARCHIVE_ROOT,
  OBJECTS_DIR,
  TMP_DIR,
  PUBLIC_PREFIX,
  ensureStorageDirs,
  objectPath,
  publicUrl,
  commitArchive,
  writeTempFromStream,
  discardTemp,
  cleanStaleTemp,
};
