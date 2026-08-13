#!/usr/bin/env node
// backend/scripts/import-release-assets.mjs
//
// Imports a ScenarioCreator release into the per-asset store nginx serves at /a/.
//
// This is the streaming counterpart of `publish-release.mjs`. That one uploads
// one ZIP per scenario; this one stores every script and asset individually, so
// the engine can fetch what it needs to draw the first frame and stream the rest
// afterwards (`Application.loadScenarioFromManifest`).
//
// Deliberately not an API endpoint yet. The plan is to prove the path works
// before designing a `scenario_assets` table around it, and `StreamingAssetSource`
// takes any URL — so a directory of hashed files behind the existing nginx is
// enough to exercise the whole thing end to end.
//
// Layout written:
//
//   <scenario id>.json                 the manifest, with asset URLs normalised
//   objects/<2 chars>/<sha256>.<ext>   content-addressed, shared between scenarios
//
// **URLs are normalised to a bare `objects/aa/…`, and the manifest sits one level
// above them.** Two facts force this:
//
//   * A release uses two conventions. Manifests at the release root say
//     `objects/aa/…`; the bench scenes under `test/` are one directory deeper and
//     say `../objects/aa/…`. Served from one place those mean different things,
//     and the `../` would climb out of the store.
//   * The engine resolves an asset URL by **joining** it onto the manifest's own
//     directory as a string. It does not treat a leading "/" as absolute, so
//     rewriting to `/a/objects/…` yields `/a/manifests//a/objects/…` and a 404.
//
// Normalising to a relative path and publishing the manifest at the store root
// satisfies both: `/a/<id>.json` + `objects/aa/…` → `/a/objects/aa/…`, and no
// caller has to pass a `baseUrl`.
//
// The manifest is not content-addressed — it is named for the scenario, mutable,
// served no-cache — so rewriting it is not a lie about its identity. It is what a
// `GET /api/scenarios/:id/manifest` endpoint would have to do anyway.
//
// Usage:
//   node scripts/import-release-assets.mjs [--release <dir>] [--only <id,id>]
//                                          [--out <dir>] [--stage-only]

import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = import.meta.dirname;

/** Where the compose stack mounts the store, rw in backend and ro in frontend. */
const CONTAINER_PATH = '/srv/assets';
const COMPOSE_SERVICE = 'backend';

function parseArgs(argv) {
  const args = {
    release: path.resolve(HERE, '../../../../ScenarioCreator/ReleaseScenarios'),
    only: null,
    out: null,
    stageOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--release': args.release = path.resolve(argv[++i]); break;
      case '--only': args.only = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean)); break;
      case '--out': args.out = path.resolve(argv[++i]); break;
      case '--stage-only': args.stageOnly = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

/**
 * The store-relative path an object gets, whatever the manifest called it.
 *
 * Manifest URLs arrive as `objects/aa/<hash>.js` or `../objects/aa/<hash>.js`
 * depending on where the manifest sits in the release. Both name the same
 * two-level shard, so the last three segments are the whole truth — and taking
 * them means a `../` can never escape the staging directory, which is what
 * `path.join(staging, url)` would happily do.
 */
function storePath(url) {
  const segments = url.split('/').filter(s => s && s !== '.' && s !== '..');
  const shard = segments.slice(-2);

  if (shard.length !== 2 || !/^[0-9a-f]{2}$/i.test(shard[0])) {
    throw new Error(`Unexpected object URL layout: ${url}`);
  }

  return `objects/${shard[0]}/${shard[1]}`;
}

/** Every `<Name>.scenario.json` in the release and its `test/` subdirectory. */
async function findManifests(releaseDir) {
  const found = [];

  for (const dir of [releaseDir, path.join(releaseDir, 'test')]) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter(n => n.endsWith('.scenario.json')).sort()) {
      found.push(path.join(dir, name));
    }
  }

  return found;
}

const mb = bytes => `${(bytes / 1048576).toFixed(2)} MB`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const staging = args.out ?? path.join(os.tmpdir(), `vl-assets-${process.pid}`);

  const manifestFiles = await findManifests(args.release);
  if (manifestFiles.length === 0) {
    console.error(`No .scenario.json files under ${args.release}`);
    process.exit(1);
  }

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  // Keyed by relative url, so an object shared by two scenarios is copied once —
  // which is the whole reason for storing assets separately in the first place.
  const objects = new Map();
  const imported = [];
  const problems = [];

  for (const file of manifestFiles) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      problems.push(`${path.basename(file)}: not valid JSON (${err.message})`);
      continue;
    }

    if (!manifest.id) {
      problems.push(`${path.basename(file)}: manifest has no id`);
      continue;
    }
    if (args.only && !args.only.has(manifest.id)) continue;

    // Manifests live beside `objects/` in the store, so an id of that name
    // would collide with it.
    if (manifest.id === 'objects') {
      problems.push(`${manifest.id}: reserved id — it would collide with the objects directory`);
      continue;
    }

    // `scripts` + `entry` are what make a manifest runnable. One listing only
    // assets is a valid asset source but not a scenario, and the engine says so
    // rather than failing later — so flag it here instead of importing quietly.
    if (!manifest.entry || !manifest.scripts?.length) {
      problems.push(`${manifest.id}: no entry/scripts — an asset source, not a runnable scenario`);
      continue;
    }

    // Every holder of a url, so the copy and the rewrite walk the same list.
    // An asset carries its urls in `lods`; a script carries one directly.
    const holders = [
      ...(manifest.scripts ?? []),
      ...(manifest.assets ?? []),
      ...(manifest.assets ?? []).flatMap(a => a.lods ?? []),
    ].filter(entry => typeof entry.url === 'string');

    let scenarioBytes = 0;
    for (const holder of holders) {
      let store;
      try {
        store = storePath(holder.url);
      } catch (err) {
        problems.push(`${manifest.id}: ${err.message}`);
        continue;
      }

      if (!objects.has(store)) {
        const source = path.resolve(path.dirname(file), holder.url);
        let size;
        try {
          size = (await stat(source)).size;
        } catch {
          problems.push(`${manifest.id}: missing object ${holder.url}`);
          continue;
        }

        const target = path.join(staging, store);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
        objects.set(store, size);
      }

      scenarioBytes += objects.get(store);

      // Rewrite last, so a failed copy above leaves the url pointing at the
      // original rather than at something that was never stored. Relative, and
      // resolved against the manifest's directory — see the header.
      holder.url = store;
    }

    await writeFile(
      path.join(staging, `${manifest.id}.json`),
      JSON.stringify(manifest, null, 2)
    );

    imported.push({
      id: manifest.id,
      scripts: manifest.scripts.length,
      assets: manifest.assets?.length ?? 0,
      bytes: scenarioBytes,
    });
  }

  // ── report ────────────────────────────────────────
  console.log(`Release : ${args.release}`);
  console.log(`Staging : ${staging}\n`);

  for (const s of imported) {
    console.log(
      `  ${s.id.padEnd(24)} ${String(s.scripts).padStart(3)} script(s) ` +
      `${String(s.assets).padStart(3)} asset(s)  ${mb(s.bytes).padStart(9)}`
    );
  }

  const totalBytes = [...objects.values()].reduce((sum, n) => sum + n, 0);
  console.log(`\n  ${objects.size} unique object(s), ${mb(totalBytes)} after dedup`);

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
  }

  if (imported.length === 0) {
    console.error('\nNothing imported.');
    process.exit(1);
  }

  if (args.stageOnly) {
    console.log(`\nStaged only. Copy it in with:\n  docker compose cp "${staging}/." ${COMPOSE_SERVICE}:${CONTAINER_PATH}/`);
    return;
  }

  // ── push into the volume ──────────────────────────
  // The store is a Docker volume mounted rw into backend and ro into the
  // frontend, so one `cp` of the staged tree is how it gets there. No upload
  // endpoint yet, on purpose — see the header.
  const repoRoot = path.resolve(HERE, '../..');
  console.log(`\nCopying into ${COMPOSE_SERVICE}:${CONTAINER_PATH} ...`);

  try {
    await run('docker', ['compose', 'cp', `${staging}/.`, `${COMPOSE_SERVICE}:${CONTAINER_PATH}/`], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    console.error(
      `\ndocker compose cp failed: ${err.stderr || err.message}\n` +
      `Is the stack up? The staged tree is still at ${staging}.`
    );
    process.exit(1);
  }

  if (!args.out) await rm(staging, { recursive: true, force: true });

  console.log(
    `\nOK — ${imported.length} scenario(s) available at /a/<id>.json\n` +
    `Load with: app.loadScenarioFromManifest('/a/<id>.json')\n` +
    `Asset URLs resolve against the manifest's directory, so no baseUrl is needed.`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
