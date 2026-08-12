#!/usr/bin/env node
// backend/scripts/verify-ktx2.mjs
//
// Checks the file half of the KTX2 pipeline, straight from the archives.
//
// The runtime half — did the transcoder actually load — needs a browser and is
// in `docs/manual-browser-checks.md` §5. But "is this texture genuinely
// supercompressed?" is answerable from the bytes alone, and that is the half
// that silently regressed before: a `.ktx2` that is really uncompressed RGBA
// renders perfectly and costs 8x the VRAM, so nothing on screen says so.
//
// Two independent signals, both from the file:
//
//   1. The KTX2 header. `supercompressionScheme` and the DFD colour model say
//      what the encoder produced — BasisLZ/ETC1S, Zstd/UASTC, or nothing.
//   2. How far the entry deflates inside the ZIP. Supercompressed payloads are
//      already dense and barely shrink (~100%). A texture that deflates to a
//      fraction of its size is carrying redundant, uncompressed pixels — which
//      is exactly how the earlier bad build was spotted.
//
// Usage:
//   node scripts/verify-ktx2.mjs [--release <dir>] [--max-deflate 0.9]

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const StreamZip = require('node-stream-zip');

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `«KTX 20»\r\n\x1A\n` — the KTX 2.0 file identifier. */
const KTX2_IDENTIFIER = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const SUPERCOMPRESSION = { 0: 'none', 1: 'BasisLZ', 2: 'Zstandard', 3: 'ZLIB' };

/** Khronos Data Format colour models, of which only two are Basis textures. */
const COLOR_MODEL = { 160: 'RGBSDA', 161: 'YUVSDA', 163: 'ETC1S', 166: 'UASTC' };

/**
 * Bytes per pixel each encoding costs on the GPU once transcoded.
 *
 * ETC1S lands in a 4 bpp format (BC1 / ETC1), UASTC in an 8 bpp one (BC7 /
 * ASTC 4x4). The fallback when the transcoder does not load is RGBA8 at 32 bpp,
 * and the gap between them is the whole point of the browser check.
 */
const BYTES_PER_PIXEL = { ETC1S: 0.5, UASTC: 1, FALLBACK: 4 };

/** A full mip chain adds roughly a third to the base level. */
const MIP_FACTOR = 4 / 3;

/**
 * Reads the KTX2 header fields this check needs.
 * Returns `null` when the payload is not a KTX2 file at all.
 */
function parseKtx2(buffer) {
  if (buffer.length < 80 || !buffer.subarray(0, 12).equals(KTX2_IDENTIFIER)) return null;

  const dfdByteOffset = buffer.readUInt32LE(48);

  return {
    vkFormat: buffer.readUInt32LE(12),
    width: buffer.readUInt32LE(20),
    height: buffer.readUInt32LE(24),
    levelCount: buffer.readUInt32LE(40),
    supercompression: buffer.readUInt32LE(44),
    // Basic Descriptor Block: colorModel is one byte, 12 into the block.
    colorModel: dfdByteOffset > 0 ? buffer.readUInt8(dfdByteOffset + 12) : null,
  };
}

function parseArgs(argv) {
  const args = {
    release: path.resolve(HERE, '../../../../ScenarioCreator/ReleaseScenarios'),
    // A supercompressed entry sits near 1.0. Anything that still deflates by
    // more than a tenth is carrying uncompressed pixels.
    maxDeflate: 0.9,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--release': args.release = path.resolve(argv[++i]); break;
      case '--max-deflate': args.maxDeflate = Number(argv[++i]); break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

async function findArchives(releaseDir) {
  const found = [];
  for (const dir of [releaseDir, path.join(releaseDir, 'test')]) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const n of names.filter(n => n.toLowerCase().endsWith('.zip')).sort()) {
      found.push(path.join(dir, n));
    }
  }
  return found;
}

const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

async function inspectArchive(file, maxDeflate) {
  const zip = new StreamZip.async({ file });
  const textures = [];
  const failures = [];

  try {
    const entries = await zip.entries();
    const names = Object.keys(entries).filter(n => n.toLowerCase().endsWith('.ktx2')).sort();
    if (names.length === 0) return null;

    for (const name of names) {
      const entry = entries[name];
      const header = parseKtx2(await zip.entryData(name));

      if (!header) {
        failures.push(`${name}: not a KTX2 file despite the extension`);
        continue;
      }

      const encoding = COLOR_MODEL[header.colorModel] ?? `model ${header.colorModel}`;
      const scheme = SUPERCOMPRESSION[header.supercompression] ?? `scheme ${header.supercompression}`;
      const deflate = entry.size > 0 ? entry.compressedSize / entry.size : 1;

      // ETC1S carries its own BasisLZ; UASTC needs Zstd over it. Either way,
      // "none" means the encoder emitted raw blocks.
      if (header.supercompression === 0) {
        failures.push(`${name}: ${encoding} with no supercompression`);
      }
      if (encoding !== 'ETC1S' && encoding !== 'UASTC') {
        failures.push(`${name}: colour model is ${encoding}, not a Basis texture`);
      }
      if (deflate < maxDeflate) {
        failures.push(
          `${name}: deflates to ${(deflate * 100).toFixed(0)}% inside the ZIP — ` +
          `a supercompressed payload would not compress further`
        );
      }

      textures.push({ name, encoding, scheme, deflate, ...header });
    }
  } finally {
    await zip.close().catch(() => {});
  }

  return { textures, failures };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const archives = await findArchives(args.release);

  if (archives.length === 0) {
    console.error(`No .zip archives under ${args.release}`);
    process.exit(1);
  }

  let checked = 0;
  const allFailures = [];

  for (const file of archives) {
    const result = await inspectArchive(file, args.maxDeflate);
    if (!result) continue;

    console.log(`\n${path.basename(file)}  —  ${result.textures.length} texture(s)`);
    console.log(
      `  ${'texture'.padEnd(30)} ${'encoding'.padEnd(8)} ${'supercompression'.padEnd(17)}` +
      ` ${'deflate'.padStart(7)}  dimensions`
    );

    let transcoded = 0;
    let fallback = 0;

    for (const t of result.textures) {
      console.log(
        `  ${path.basename(t.name).padEnd(30)} ${t.encoding.padEnd(8)} ${t.scheme.padEnd(17)}` +
        ` ${((t.deflate * 100).toFixed(0) + '%').padStart(7)}` +
        `  ${t.width}x${t.height} (${t.levelCount} mips)`
      );

      const pixels = t.width * t.height * MIP_FACTOR;
      transcoded += pixels * (BYTES_PER_PIXEL[t.encoding] ?? BYTES_PER_PIXEL.UASTC);
      fallback += pixels * BYTES_PER_PIXEL.FALLBACK;
    }

    // The figure the browser check compares against — see
    // docs/manual-browser-checks.md §5.
    console.log(
      `\n  expected texture VRAM: ${mb(transcoded)} transcoded  vs  ${mb(fallback)} if the` +
      ` transcoder fails to load (${(fallback / transcoded).toFixed(1)}x)`
    );

    checked += result.textures.length;
    allFailures.push(...result.failures.map(f => `${path.basename(file)} → ${f}`));
  }

  if (checked === 0) {
    console.log(`\nNo .ktx2 textures in any archive under ${args.release}.`);
    return;
  }

  if (allFailures.length > 0) {
    console.error(`\n${allFailures.length} problem(s):`);
    for (const f of allFailures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(`\nOK — ${checked} KTX2 texture(s), all supercompressed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
