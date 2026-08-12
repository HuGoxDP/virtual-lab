#!/usr/bin/env node
// backend/scripts/publish-release.mjs
//
// Publishes a ScenarioCreator release directory into the catalog.
//
// Why a script and not the /admin UI: a release is 13 archives, republishing
// happens on every ScenarioCreator build, and doing it by hand is how the
// catalog ended up serving content nobody could account for — with two rows
// whose id contained a space.
//
// It talks to the public admin API, exactly as the UI does; it never touches
// the database. So it works against a deployed instance, not just localhost.
//
// Source of truth split:
//   archive manifest.json  → id, title, description, version   (ScenarioCreator)
//   catalog-metadata.mjs   → subject, visibility, image        (this platform)
//
// Usage:
//   ADMIN_TOKEN=… node scripts/publish-release.mjs --release <dir> [options]
//
//   --release <dir>      release directory (default: ../ScenarioCreator/ReleaseScenarios)
//   --base-url <url>     API origin (default: http://localhost:$FRONTEND_PORT or :8044)
//   --only <id,id>       publish just these manifest ids
//   --dry-run            report what would change, write nothing
//   --prune-superseded   delete the catalog rows listed in `supersedes`
//
// `--prune-superseded` is opt-in because it deletes rows. Everything else is
// create/update only and safe to re-run.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { CATALOG_METADATA, DEFAULTS } from './catalog-metadata.mjs';

const require = createRequire(import.meta.url);
const StreamZip = require('node-stream-zip');

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Bench scenes live in a subdirectory so they are not mixed with teaching content. */
const TEST_SUBDIR = 'test';

// ── arguments ────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    release: path.resolve(HERE, '../../../../ScenarioCreator/ReleaseScenarios'),
    baseUrl: process.env.PUBLISH_BASE_URL || `http://localhost:${process.env.FRONTEND_PORT || 8044}`,
    only: null,
    dryRun: false,
    pruneSuperseded: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--release': args.release = path.resolve(argv[++i]); break;
      case '--base-url': args.baseUrl = argv[++i].replace(/\/+$/, ''); break;
      case '--only': args.only = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean)); break;
      case '--dry-run': args.dryRun = true; break;
      case '--prune-superseded': args.pruneSuperseded = true; break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

// ── discovery ────────────────────────────────────────

/**
 * Every `.zip` in the release directory and its `test/` subdirectory.
 * Returns `{ file, isTest }`, newest-independent order (sorted for stable logs).
 */
async function findArchives(releaseDir) {
  const found = [];

  for (const [dir, isTest] of [[releaseDir, false], [path.join(releaseDir, TEST_SUBDIR), true]]) {
    let names;
    try {
      names = await readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT' && isTest) continue; // a release need not have bench scenes
      throw err;
    }
    for (const name of names.filter(n => n.toLowerCase().endsWith('.zip')).sort()) {
      found.push({ file: path.join(dir, name), isTest });
    }
  }

  return found;
}

/** Reads the engine manifest out of an archive without unpacking it. */
async function readArchiveManifest(file) {
  const zip = new StreamZip.async({ file });
  try {
    return JSON.parse(await zip.entryData('manifest.json'));
  } finally {
    await zip.close().catch(() => {});
  }
}

// ── API client ───────────────────────────────────────

class ApiError extends Error {
  constructor(status, body, method, url) {
    super(`${method} ${url} → ${status}: ${body}`);
    this.status = status;
  }
}

function makeClient(baseUrl, token) {
  async function call(method, endpoint, { json, body, headers = {} } = {}) {
    const url = `${baseUrl}${endpoint}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : body,
    });

    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text.slice(0, 300), method, endpoint);
    return text ? JSON.parse(text) : null;
  }

  return {
    listScenarios: () => call('GET', '/api/admin/scenarios').then(r => r.scenarios),
    create: fields => call('POST', '/api/catalog', { json: fields }),
    update: (id, fields) => call('PUT', `/api/catalog/${encodeURIComponent(id)}`, { json: fields }),
    remove: id => call('DELETE', `/api/catalog/${encodeURIComponent(id)}`),
    uploadArchive: (id, filename, bytes) => {
      const form = new FormData();
      form.append('archive', new Blob([bytes], { type: 'application/zip' }), filename);
      return call('POST', `/api/scenarios/${encodeURIComponent(id)}/archive`, { body: form });
    },
  };
}

// ── publishing one scenario ──────────────────────────

/**
 * Catalog fields for a scenario, merging the archive's manifest with the
 * platform metadata. `isNew` decides whether `fullDescription` is authored:
 * on an existing row an unauthored long description is left as it is.
 */
function catalogFields(manifest, meta, isNew) {
  const fields = {
    title: manifest.name,
    description: manifest.description || '',
    category: meta.category,
    categoryLabel: meta.categoryLabel,
    version: String(manifest.version ?? '1.0.0'),
    author: meta.author ?? DEFAULTS.author,
  };

  if (meta.fullDescription !== undefined) {
    fields.fullDescription = meta.fullDescription;
  } else if (isNew) {
    // The detail modal renders only fullDescription — never leave it blank.
    fields.fullDescription = manifest.description || '';
  }

  // Only set the image on create: an empty default must not wipe one that was
  // chosen in /admin after the row existed.
  if (isNew) fields.imageUrl = meta.imageUrl ?? DEFAULTS.imageUrl;

  return fields;
}

async function publishOne(api, { file, manifest, meta, existing, dryRun }) {
  const id = manifest.id;
  const isNew = !existing;
  const fields = catalogFields(manifest, meta, isNew);
  const published = meta.published ?? DEFAULTS.published;
  const notes = [];

  if (dryRun) {
    notes.push(isNew ? 'would create' : 'would update');
    notes.push(`would upload ${path.basename(file)}`);
    if (existing && existing.isPublished !== published) {
      notes.push(`would set published=${published}`);
    }
    return { id, notes, uploaded: null };
  }

  if (isNew) {
    await api.create({ id, ...fields });
  } else {
    await api.update(id, fields);
  }

  const bytes = await readFile(file);
  const uploaded = await api.uploadArchive(id, path.basename(file), bytes);

  // `is_published` is not part of POST /api/catalog — new rows default to true,
  // so bench scenes need a follow-up PUT to be hidden.
  if (isNew ? published !== true : existing.isPublished !== published) {
    await api.update(id, { isPublished: published });
    notes.push(`published=${published}`);
  }

  notes.push(isNew ? 'created' : 'updated');
  if (uploaded.deduplicated) {
    notes.push('DEDUP — identical bytes already stored; is this the archive you meant?');
  }
  for (const warning of uploaded.warnings ?? []) notes.push(`warning: ${warning}`);

  return { id, notes, uploaded };
}

// ── main ─────────────────────────────────────────────

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.ADMIN_TOKEN;

  if (!token) {
    console.error('ADMIN_TOKEN is not set. Export it, or run through `npm run publish:release`.');
    process.exit(2);
  }

  const api = makeClient(args.baseUrl, token);

  console.log(`Release : ${args.release}`);
  console.log(`Target  : ${args.baseUrl}${args.dryRun ? '  (dry run)' : ''}`);

  const archives = await findArchives(args.release);
  if (archives.length === 0) {
    console.error(`No .zip archives under ${args.release}`);
    process.exit(1);
  }

  const existingRows = await api.listScenarios();
  const byId = new Map(existingRows.map(row => [row.id, row]));

  const results = [];
  const problems = [];
  const seen = new Set();

  for (const { file, isTest } of archives) {
    const name = path.basename(file);

    let manifest;
    try {
      manifest = await readArchiveManifest(file);
    } catch (err) {
      problems.push(`${name}: cannot read manifest.json (${err.message})`);
      continue;
    }

    const id = manifest.id;
    if (!id) {
      problems.push(`${name}: manifest has no id`);
      continue;
    }
    if (args.only && !args.only.has(id)) continue;

    const meta = CATALOG_METADATA[id];
    if (!meta) {
      // Refusing is deliberate: guessing a subject would file a new scenario
      // under the wrong one silently, and the catalog is browsed by subject.
      problems.push(`${name}: id "${id}" has no entry in catalog-metadata.mjs — add its subject there`);
      continue;
    }
    if (isTest !== (meta.category === 'test')) {
      problems.push(`${name}: lives in ${isTest ? 'test/' : 'the release root'} but is filed as "${meta.category}"`);
      continue;
    }

    seen.add(id);
    const size = (await stat(file)).size;

    try {
      const result = await publishOne(api, {
        file, manifest, meta, existing: byId.get(id), dryRun: args.dryRun,
      });
      results.push({ name, id, size, ...result });
    } catch (err) {
      problems.push(`${name} (${id}): ${err.message}`);
    }
  }

  // ── report ────────────────────────────────────────
  console.log('');
  for (const r of results) {
    console.log(`  ${r.id.padEnd(24)} ${formatBytes(r.size).padStart(9)}  ${r.name}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  // ── superseded rows ───────────────────────────────
  const superseded = [];
  for (const id of seen) {
    for (const old of CATALOG_METADATA[id].supersedes ?? []) {
      if (byId.has(old)) superseded.push({ old, replacedBy: id });
    }
  }

  if (superseded.length > 0) {
    console.log('');
    for (const { old, replacedBy } of superseded) {
      if (args.pruneSuperseded && !args.dryRun) {
        try {
          await api.remove(old);
          console.log(`  deleted superseded row "${old}" (replaced by ${replacedBy})`);
        } catch (err) {
          problems.push(`deleting "${old}": ${err.message}`);
        }
      } else {
        console.log(`  superseded row "${old}" still present (replaced by ${replacedBy}) — --prune-superseded to delete`);
      }
    }
  }

  // Rows the release does not account for. Not an error: a scenario may be
  // retired from the release while its catalog row is kept deliberately.
  const unaccounted = existingRows
    .filter(row => !seen.has(row.id) && !superseded.some(s => s.old === row.id))
    .map(row => row.id);

  if (unaccounted.length > 0 && !args.only) {
    console.log(`\n  in the catalog but not in this release: ${unaccounted.join(', ')}`);
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(`\nOK — ${results.length} scenario(s) ${args.dryRun ? 'checked' : 'published'}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
