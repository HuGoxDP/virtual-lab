// e2e/tests/ktx2-render.spec.ts
//
// Player isolation, phase 5 (DW-5.5): a KTX2 scenario renders through the player.
//
// DW-1.3 recorded KTX2 as passing in the sandboxed player, so the viewer sends `transcoderPath`. No
// catalog scenario references a `.ktx2` yet (ktx2.spec.ts self-skips for that reason), so this test builds
// one: a throwaway `e2e-` scenario whose script loads `textures/test.ktx2` onto a visible cube. The test
// opens it in the viewer and asserts, INSIDE the frame, that
//   - the transcoder was fetched (from /assets/basis/, through the opaque-origin frame),
//   - the scenario received a texture of the fixture's size,
//   - the engine's renderer report lists a compressed GPU format (anything but RGBA8) for it,
//   - and the scene drew (draw calls > 0).
//
// Fixture: e2e/fixtures/test.ktx2 is a byte-for-byte copy of
// WebEngineTS/scripts/player-smoke/fixtures/test.ktx2 (16x16, 431 bytes, Basis-supercompressed), test data
// the engine's own player smoke already proves. It is not scenario content and is not served by the app.

import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createScenario, deleteScenario, uniqueScenarioId, updateScenario, uploadArchive } from '../helpers/api';
import { ENGINE_URL, playerFrame, waitForFrames } from '../helpers/engine';
import { buildZip } from '../helpers/zip';

const MARK = 'KTX2-RESULT ';

const MANIFEST = {
  manifestVersion: '1.0',
  id: 'e2e-ktx2',
  name: 'KTX2 render',
  version: '1.0.0',
  description: 'e2e: a cube textured from a .ktx2',
  category: 'test',
  entryPoint: 'Scenario.js',
  assets: [],
  metadata: { scripts: ['scripts/Scenario.js'] },
};

const SCENARIO = `
import {
  ScenarioBehaviour, GameObject, Camera, Vector3, Color, MeshFilter, MeshRenderer, Mesh,
  StandardMaterial, DirectionalLight, Resources, Texture2D, CameraClearFlags,
} from "WebEngineTS";

export default class Ktx2Scene extends ScenarioBehaviour {
  async awake() {
    const cam = new GameObject("Main Camera");
    cam.tag = "MainCamera";
    const camera = cam.addComponent(Camera);
    camera.clearFlags = CameraClearFlags.SolidColor;
    camera.backgroundColor = new Color(0.1, 0.1, 0.2);
    cam.transform.position = new Vector3(0, 0, -3);
    new GameObject("Sun").addComponent(DirectionalLight);

    const cube = new GameObject("Cube");
    cube.addComponent(MeshFilter).sharedMesh = Mesh.createCube(1);
    const material = new StandardMaterial();
    cube.addComponent(MeshRenderer).sharedMaterial = material;

    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("no result in 30 s")), 30000));
    try {
      const texture = await Promise.race([Resources.load(Texture2D, "textures/test.ktx2"), timeout]);
      material.albedoTexture = texture;
      console.log(${JSON.stringify(MARK)} + JSON.stringify({ ok: true, width: texture.width, height: texture.height }));
    } catch (e) {
      console.log(${JSON.stringify(MARK)} + JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
  }
}
`;

test.describe('a KTX2 scenario renders through the player (DW-5.5)', () => {
  const id = uniqueScenarioId('ktx2');
  let dir = '';

  test.beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vl-ktx2-'));
    const file = path.join(dir, 'ktx2.zip');
    await writeFile(file, buildZip({
      'manifest.json': JSON.stringify({ ...MANIFEST, id }),
      'scripts/Scenario.js': SCENARIO,
      'assets/textures/test.ktx2': await readFile(path.join(__dirname, '..', 'fixtures', 'test.ktx2')),
    }));
    await createScenario({
      id, title: 'E2E ktx2', description: 'e2e', fullDescription: '',
      category: 'test', categoryLabel: 'Test',
    });
    // A new row is a draft; approving needs an archive, so upload first (PUT isPublished maps to approve).
    await uploadArchive(id, file);
    await updateScenario(id, { isPublished: true });
  });

  test.afterAll(async () => {
    await deleteScenario(id);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('DW-5.5 the transcoder is fetched, the texture is a compressed GPU format, and the cube draws', async ({ page }) => {
    test.setTimeout(120_000);

    const transcoderRequests: string[] = [];
    page.on('request', r => { if (r.url().includes('/assets/basis/basis_transcoder')) transcoderRequests.push(r.url()); });
    const reports: string[] = [];
    page.on('console', m => { if (m.text().startsWith(MARK)) reports.push(m.text().slice(MARK.length)); });

    await page.goto(`/play/${id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
    await expect.poll(() => reports.length, { timeout: 40_000 }).toBeGreaterThan(0);

    const result = JSON.parse(reports[0]) as { ok: boolean; width?: number; height?: number; error?: string };
    expect(result.error ?? '', 'the .ktx2 load must not fail or hang').toBe('');
    expect(result).toMatchObject({ ok: true, width: 16, height: 16 });

    const snapshot = await waitForFrames(page);
    expect(snapshot.drawCalls, 'the textured cube drew').toBeGreaterThan(0);

    expect(transcoderRequests.some(u => u.endsWith('basis_transcoder.js')), `transcoder JS fetched: ${transcoderRequests.join(', ')}`).toBe(true);
    expect(transcoderRequests.some(u => u.endsWith('basis_transcoder.wasm')), 'transcoder WASM fetched').toBe(true);

    // What the texture became on the GPU, read from the engine inside the frame.
    const formats = await (await playerFrame(page)).evaluate(async url => {
      const { MemoryProfiler } = await import(url);
      return MemoryProfiler.snapshot().renderer?.textureFormats as Record<string, number> | undefined;
    }, new URL(ENGINE_URL, page.url()).href);
    console.log(`ktx2 render evidence: texture formats ${JSON.stringify(formats)}; transcoder requests ${transcoderRequests.length}; draw calls ${snapshot.drawCalls}`);
    expect(formats, 'the renderer reports texture formats').toBeTruthy();
    const compressed = Object.keys(formats!).filter(f => f !== 'RGBA8');
    expect(compressed, `a compressed GPU format among ${JSON.stringify(formats)}`).not.toEqual([]);
  });
});
