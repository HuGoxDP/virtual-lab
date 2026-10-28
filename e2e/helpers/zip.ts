// e2e/helpers/zip.ts
//
// A minimal ZIP writer (STORE method, no compression) so a test can build the archive it needs - a
// hostile scenario, say - without committing a binary fixture or adding a dependency. Scenario content
// lives in ScenarioCreator, never here; what this builds is a throwaway test double, uploaded under an
// `e2e-` id and torn down by the test.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a ZIP holding `files` (path -> text or bytes), uncompressed. */
export function buildZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** The script every generated scenario archive carries: a camera and nothing else (enough for the validator). */
const MINIMAL_SCENARIO = `
import { ScenarioBehaviour, GameObject, Camera, Color } from "WebEngineTS";
export default class Minimal extends ScenarioBehaviour {
  async awake() {
    const cam = new GameObject("Main Camera");
    cam.tag = "MainCamera";
    cam.addComponent(Camera).backgroundColor = new Color(0.1, 0.1, 0.1);
  }
}
`;

/**
 * A valid, throwaway scenario archive whose manifest says `id` (a slug, as `from-archive` requires), `name` and
 * `version`. Two archives that differ only in `version` have different bytes, so they are different versions.
 */
export function buildScenarioZip(options: { id: string; name?: string; version?: string }): Buffer {
  const { id, name = 'E2E сценарій', version = '1.0.0' } = options;
  const manifest = {
    manifestVersion: '1.0',
    id,
    name,
    version,
    description: 'e2e: архів, зібраний тестом',
    category: 'test',
    entryPoint: 'Scenario.js',
    assets: [],
    metadata: { scripts: ['scripts/Scenario.js'] },
  };
  return buildZip({
    'manifest.json': JSON.stringify(manifest),
    'scripts/Scenario.js': MINIMAL_SCENARIO,
  });
}
