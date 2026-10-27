// backend/storage.js
//
// Content-addressed object storage on plain Docker volumes: scenario archives and cover images.
//
// Archives are stored as `<sha256>.zip` and served by nginx from `/scenarios/<sha256>.zip`;
// previews as `<sha256>.png|jpg` from `/previews/…`. Because the name *is* the content hash the
// object is immutable: nginx can cache it forever, and the same bytes uploaded twice cost nothing.
// Express never streams these bytes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || '/srv/archives';
const PREVIEW_ROOT = process.env.PREVIEW_ROOT || '/srv/previews';

/** Public path prefixes; must match the nginx `location ^~ /scenarios/` and `^~ /previews/` aliases. */
const PUBLIC_PREFIX = '/scenarios';
const PREVIEW_PUBLIC_PREFIX = '/previews';

/** Local ZIP signatures: regular, empty, and spanned archives. */
const ZIP_SIGNATURES = ['504b0304', '504b0506', '504b0708'];

/**
 * One content-addressed store: `<root>/objects/<name>` served by nginx, `<root>/tmp` for
 * writes in flight (same volume, so the commit is a rename). `namePattern` accepts exactly
 * the names this code puts in `objects/`, capturing the sha256 first; `defaultExt` rebuilds
 * a name from a bare hash (archives only: a preview's extension depends on its bytes).
 *
 * Both stores are garbage-collected the same way, which is why this is one factory rather
 * than two copies: GC and the storage report treat them uniformly.
 */
function createStore({ root, prefix, namePattern, defaultExt }) {
  const objectsDir = path.join(root, 'objects');
  const tmpDir = path.join(root, 'tmp');
  const pathOf = name => path.join(objectsDir, name);
  const nameOf = object => object.name ?? `${object.sha256}.${defaultExt}`;

  return {
    root, objectsDir, tmpDir, prefix,
    pathOf,
    publicUrl: name => `${prefix}/${name}`,

    async ensureDirs() {
      await fsp.mkdir(objectsDir, { recursive: true });
      await fsp.mkdir(tmpDir, { recursive: true });
    },

    /** Reserves a unique path inside the volume's tmp dir. */
    tempPath: () => path.join(tmpDir, `upload-${crypto.randomUUID()}.part`),

    /**
     * Commits an already-written temp file as `objects/<name>`. Returns `{ deduplicated }`:
     * true when the object was already present and the temp file was simply dropped.
     */
    async put(tmpFile, name) {
      const target = pathOf(name);
      try {
        // Touching it doubles as the existence check (it throws when the object is absent), and
        // refreshes the age GC reads: an object that was collectible a moment ago, because its
        // last reference was deleted, must not be swept between this upload and its row.
        const now = new Date();
        await fsp.utimes(target, now, now);
        await fsp.unlink(tmpFile);
        return { deduplicated: true };
      } catch {
        await fsp.rename(tmpFile, target);
        return { deduplicated: false };
      }
    },

    /**
     * Every stored object, with its size and age.
     *
     * Age matters for garbage collection: an object is committed to the store
     * *before* the row that references it is updated, so a freshly written object
     * is briefly unreferenced through no fault of its own.
     */
    async listObjects() {
      let names;
      try {
        names = await fsp.readdir(objectsDir);
      } catch {
        return [];
      }

      const objects = [];

      for (const name of names) {
        const match = namePattern.exec(name);
        if (!match) continue;

        try {
          const stat = await fsp.stat(pathOf(name));
          if (stat.isFile()) {
            objects.push({ name, sha256: match[1], bytes: stat.size, mtimeMs: stat.mtimeMs });
          }
        } catch {
          // Removed between readdir and stat — nothing to report.
        }
      }

      return objects;
    },

    /**
     * Splits the store into what is still referenced and what is not.
     *
     * `referenced` is a Set of sha256 values. Deduplication means one object can back several
     * rows, so membership — not a count — is what decides whether it may go. `minAgeMs` protects
     * the window between a commit and the `UPDATE` that points a row at it.
     */
    async classifyObjects(referenced, minAgeMs) {
      const cutoff = Date.now() - minAgeMs;
      const result = { referenced: [], orphans: [], tooNew: [] };

      for (const object of await this.listObjects()) {
        if (referenced.has(object.sha256)) result.referenced.push(object);
        else if (object.mtimeMs > cutoff) result.tooNew.push(object);
        else result.orphans.push(object);
      }

      return result;
    },

    /** Removes stored objects. Returns what actually went. */
    async deleteObjects(objects) {
      const deleted = [];

      for (const object of objects) {
        try {
          await fsp.unlink(pathOf(nameOf(object)));
          deleted.push(object);
        } catch {
          // Already gone, or a concurrent sweep took it.
        }
      }

      return deleted;
    },

    /** Best-effort sweep of temp files left behind by a crash or a killed upload. */
    async cleanStaleTemp(maxAgeMs) {
      let names;
      try {
        names = await fsp.readdir(tmpDir);
      } catch {
        return;
      }

      const cutoff = Date.now() - maxAgeMs;

      for (const name of names) {
        const file = path.join(tmpDir, name);
        try {
          const stat = await fsp.stat(file);
          if (stat.mtimeMs < cutoff) await fsp.unlink(file);
        } catch {
          // Raced with another sweep or an active upload — leave it.
        }
      }
    },
  };
}

/** `<sha256>.zip` — anything else in objects/ was not put there by this code. */
const archives = createStore({
  root: ARCHIVE_ROOT, prefix: PUBLIC_PREFIX, namePattern: /^([0-9a-f]{64})\.zip$/, defaultExt: 'zip',
});

/** `<sha256>.png|jpg` — cover images, served from `/previews/`. */
const previews = createStore({
  root: PREVIEW_ROOT, prefix: PREVIEW_PUBLIC_PREFIX, namePattern: /^([0-9a-f]{64})\.(?:png|jpg)$/,
});

const OBJECTS_DIR = archives.objectsDir;
const TMP_DIR = archives.tmpDir;

async function ensureStorageDirs() {
  await archives.ensureDirs();
  await previews.ensureDirs();
}

function objectPath(sha256) {
  return archives.pathOf(`${sha256}.zip`);
}

function publicUrl(sha256) {
  return archives.publicUrl(`${sha256}.zip`);
}

/** Reserves a unique path inside the archives volume — same filesystem, so the commit is a rename. */
const tempPath = () => archives.tempPath();

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
  console.log(`[STORAGE] sha256(${stat.size} bytes) = ${sha256}`);

  const { deduplicated } = await archives.put(tmpFile, `${sha256}.zip`);
  console.log(deduplicated
    ? `[STORAGE] об'єкт ${sha256}.zip вже існує — тимчасовий файл видалено, об'єкт перевикористано`
    : `[STORAGE] об'єкт ${sha256}.zip відсутній — тимчасовий файл перейменовано у сховище`);

  return { sha256, bytes: stat.size, url: publicUrl(sha256), deduplicated };
}

/**
 * Stores an already-validated cover image (`ext` is `png` or `jpg`, from its magic bytes) as
 * `/previews/<sha256>.<ext>`. Returns `{ sha256, bytes, url, deduplicated }`.
 */
async function commitPreview(buffer, ext) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const name = `${sha256}.${ext}`;
  const tmpFile = previews.tempPath();
  try {
    await fsp.writeFile(tmpFile, buffer);
    const { deduplicated } = await previews.put(tmpFile, name);
    return { sha256, bytes: buffer.length, url: previews.publicUrl(name), deduplicated };
  } catch (err) {
    await fsp.unlink(tmpFile).catch(() => {});
    throw err;
  }
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

/** A catalog `imageUrl` this store issued: `/previews/<sha256>.png|jpg`. */
const PREVIEW_URL = /^\/previews\/([0-9a-f]{64})\.(?:png|jpg)$/;

/** The hash a catalog `imageUrl` of the preview form refers to, else null. */
const previewHashOf = url => PREVIEW_URL.exec(url ?? '')?.[1] ?? null;

const STALE_TEMP_MS = 6 * 60 * 60 * 1000;

/** Best-effort sweep of temp files left behind by a crash or a killed upload, in both stores. */
async function cleanStaleTemp(maxAgeMs = STALE_TEMP_MS) {
  await archives.cleanStaleTemp(maxAgeMs);
  await previews.cleanStaleTemp(maxAgeMs);
}

module.exports = {
  ARCHIVE_ROOT,
  PREVIEW_ROOT,
  OBJECTS_DIR,
  TMP_DIR,
  PUBLIC_PREFIX,
  PREVIEW_PUBLIC_PREFIX,
  PREVIEW_URL,
  archives,
  previews,
  previewHashOf,
  ensureStorageDirs,
  objectPath,
  publicUrl,
  commitArchive,
  commitPreview,
  writeTempFromStream,
  discardTemp,
  cleanStaleTemp,
  listObjects: () => archives.listObjects(),
  classifyObjects: (referenced, minAgeMs) => archives.classifyObjects(referenced, minAgeMs),
  deleteObjects: objects => archives.deleteObjects(objects),
};
