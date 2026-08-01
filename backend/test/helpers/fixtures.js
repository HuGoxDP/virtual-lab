// backend/test/helpers/fixtures.js
//
// Archive fixtures are built at run time rather than committed as binaries:
// a checked-in ZIP is opaque in review and drifts silently from the manifest
// shape the engine actually requires.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * Minimal ZIP writer — stored + deflated entries, no dependencies.
 * Enough for `node-stream-zip` to read back, which is all the tests need.
 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0, 12);           // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length

    chunks.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory signature
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);             // extra
    dir.writeUInt16LE(0, 32);             // comment
    dir.writeUInt16LE(0, 34);             // disk
    dir.writeUInt16LE(0, 36);             // internal attrs
    dir.writeUInt32LE(name.endsWith('/') ? 0x10 : 0, 38);
    dir.writeUInt32LE(offset, 42);

    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

const VALID_MANIFEST = {
  manifestVersion: '1.0',
  id: 'test.scenario.valid',
  name: 'Valid Test Scenario',
  version: '1.0.0',
  entryPoint: 'Scenario.js',
};

/** A ZIP the validator must accept. */
function validArchive(manifestOverrides = {}) {
  return buildZip({
    'manifest.json': JSON.stringify({ ...VALID_MANIFEST, ...manifestOverrides }),
    'scripts/Scenario.js': 'export default class {}',
    'assets/readme.txt': 'asset',
  });
}

const invalidArchives = {
  noManifest: () => buildZip({ 'readme.txt': 'nothing here' }),
  invalidJson: () => buildZip({ 'manifest.json': '{ not json' }),
  missingFields: () => buildZip({ 'manifest.json': JSON.stringify({ id: 'x', name: 'y' }) }),
  missingEntryPoint: () => buildZip({ 'manifest.json': JSON.stringify(VALID_MANIFEST) }),
  // The manifest must be at the archive root, not nested.
  nestedManifest: () => buildZip({
    'sub/manifest.json': JSON.stringify(VALID_MANIFEST),
    'sub/scripts/Scenario.js': 'export default class {}',
  }),
  notAZip: () => Buffer.from('this is definitely not a zip file', 'utf8'),
};

/** Writes a buffer to a fresh temp file and returns its path. */
async function writeTemp(buffer, suffix = '.zip') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vl-fixture-'));
  const file = path.join(dir, `fixture${suffix}`);
  await fsp.writeFile(file, buffer);
  return file;
}

function removeTemp(file) {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    // Best effort — the OS will clean the temp dir eventually.
  }
}

module.exports = { buildZip, validArchive, invalidArchives, writeTemp, removeTemp, VALID_MANIFEST };
