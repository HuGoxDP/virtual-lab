// e2e/tests/hostile-archive.spec.ts
//
// Player isolation, phase 5 (DW-5.1; test-plan 170). A scenario is arbitrary teacher code. This builds a
// hostile archive IN THE TEST (an `e2e-` row, published, torn down) whose entry point tries everything the
// platform origin used to be exposed to, and asserts the sandboxed player stops each attempt:
//
//   - read the host page's storage (`parent.sessionStorage`, where the admin token lives)
//   - read the host's DOM (`parent.document`) and `top.location`
//   - navigate `top` away from the platform
//   - call `/api/admin/scenarios` with credentials and read the answer
//   - touch its own storage and cookies (an opaque origin has none)
//
// The script reports what happened on the console; the test reads it and, independently, checks the host
// page itself is untouched (URL, token still in place, no popup).

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createScenario, deleteScenario, uniqueScenarioId, updateScenario, uploadArchive } from '../helpers/api';
import { buildZip } from '../helpers/zip';

const MARK = 'HOSTILE-RESULT ';

const MANIFEST = {
  manifestVersion: '1.0',
  id: 'hostile',
  name: 'Hostile',
  version: '1.0.0',
  description: 'e2e: tries to escape the player sandbox',
  category: 'test',
  entryPoint: 'Scenario.js',
  assets: [],
  metadata: { scripts: ['scripts/Scenario.js'] },
};

/** The attempts, run in the scenario's own `awake`; each records what it saw and never throws. */
const SCENARIO = `
import { ScenarioBehaviour, GameObject, Camera, Color } from "WebEngineTS";
export default class Hostile extends ScenarioBehaviour {
  async awake() {
    const cam = new GameObject("Main Camera");
    cam.tag = "MainCamera";
    const camera = cam.addComponent(Camera);
    camera.backgroundColor = new Color(0.1, 0.1, 0.1);

    const result = {};
    const attempt = async (name, fn) => {
      try { result[name] = 'ALLOWED:' + String(await fn()); }
      catch (e) { result[name] = 'blocked:' + (e && e.name); }
    };
    await attempt('parentSessionStorage', () => parent.sessionStorage.getItem('adminToken'));
    await attempt('parentLocalStorage', () => parent.localStorage.getItem('vlClientId'));
    await attempt('parentDocument', () => parent.document.title);
    await attempt('topLocationRead', () => top.location.href);
    await attempt('ownLocalStorage', () => localStorage.length);
    await attempt('ownSessionStorage', () => sessionStorage.length);
    await attempt('ownCookie', () => document.cookie);
    await attempt('adminFetch', async () => {
      const res = await fetch('/api/admin/scenarios', { credentials: 'include' });
      return 'status ' + res.status;
    });
    await attempt('adminFetchWithToken', async () => {
      const res = await fetch('/api/admin/scenarios', { headers: { Authorization: 'Bearer stolen' } });
      return 'status ' + res.status;
    });
    await attempt('topNavigate', () => { top.location.href = '/admin'; return 'navigated'; });
    await attempt('windowOpen', () => { const w = window.open('/admin'); return w ? 'opened' : 'null'; });
    console.log(${JSON.stringify(MARK)} + JSON.stringify(result));
  }
}
`;

test.describe('hostile archive (DW-5.1)', () => {
  const id = uniqueScenarioId('hostile');
  let dir = '';

  test.beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vl-hostile-'));
    const file = path.join(dir, 'hostile.zip');
    await writeFile(file, buildZip({
      'manifest.json': JSON.stringify(MANIFEST),
      'scripts/Scenario.js': SCENARIO,
    }));
    await createScenario({
      id, title: 'E2E hostile', description: 'e2e', fullDescription: '',
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

  test('DW-5.1 storage, top, the host DOM and the credentialed admin API are all out of reach', async ({ page }) => {
    const reports: string[] = [];
    page.on('console', message => {
      if (message.text().startsWith(MARK)) reports.push(message.text().slice(MARK.length));
    });

    // What the hostile script is after: the admin token and the client id in the host's storage.
    await page.addInitScript(() => {
      if (window === window.top) {
        sessionStorage.setItem('adminToken', 'host-secret-token');
        localStorage.setItem('vlClientId', 'host-client-id');
      }
    });

    await page.goto(`/play/${id}`);
    await expect(page.locator('.viewer-controls')).toBeVisible({ timeout: 80_000 });
    await expect.poll(() => reports.length, { timeout: 30_000 }).toBeGreaterThan(0);

    const result = JSON.parse(reports[0]) as Record<string, string>;

    for (const name of ['parentSessionStorage', 'parentLocalStorage', 'parentDocument', 'topLocationRead']) {
      expect(result[name], `${name}: ${result[name]}`).toBe('blocked:SecurityError');
    }
    // An opaque origin has no storage of its own either.
    for (const name of ['ownLocalStorage', 'ownSessionStorage', 'ownCookie']) {
      expect(result[name], `${name}: ${result[name]}`).toBe('blocked:SecurityError');
    }
    // Both admin calls fail as network errors: the frame's `null` origin may not read the answer.
    for (const name of ['adminFetch', 'adminFetchWithToken']) {
      expect(result[name], `${name}: ${result[name]}`).toBe('blocked:TypeError');
    }
    expect(result['windowOpen'], `windowOpen: ${result['windowOpen']}`).not.toBe('ALLOWED:opened');

    // The host page itself: still on the viewer, token and client id untouched, no popup, no navigation.
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(new RegExp(`/play/${id}$`));
    expect(await page.evaluate(() => sessionStorage.getItem('adminToken'))).toBe('host-secret-token');
    expect(await page.evaluate(() => localStorage.getItem('vlClientId'))).toBe('host-client-id');
    expect(page.context().pages(), 'no popup was opened').toHaveLength(1);
  });
});
