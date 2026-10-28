// e2e/helpers/api.ts
//
// Admin API access for setup and teardown.
//
// Tests run against the live stack, so anything they create must be cleaned up
// and must never collide with real content — hence the `e2e-` id prefix and the
// timestamp. A leaked row would show up in the student catalog.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// `__dirname`, not `import.meta.url`: Playwright transpiles these specs to CJS,
// where import.meta is a syntax error.
const HERE = __dirname;

export const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8044';

/** The bootstrap moderator: what every helper uses unless a test passes the code of a key it issued. */
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

/** Anything these tests create is prefixed so a leak is obvious and greppable. */
export const E2E_ID_PREFIX = 'e2e-';

export function uniqueScenarioId(label: string): string {
  return `${E2E_ID_PREFIX}${label}-${Date.now()}`;
}

/**
 * The smallest archive in the release - enough to prove upload without the wait.
 *
 * `E2E_SMALL_ARCHIVE` wins. Otherwise ScenarioCreator is looked up in both checkouts
 * (`WebEngine/virtual-lab` and the older `testv/virtual-lab`) and under both names the small
 * bench archive has had; the first one that exists is used. Nothing found falls back to the old
 * path, so the failure message still names the file that was expected.
 */
export const SMALL_ARCHIVE = resolveSmallArchive();

function resolveSmallArchive(): string {
  const override = process.env.E2E_SMALL_ARCHIVE;
  if (override) return path.resolve(override);

  const releases = ['../../../ScenarioCreator', '../../../../ScenarioCreator']
    .map(root => path.resolve(HERE, root, 'ReleaseScenarios/test'));
  const candidates = releases.flatMap(dir =>
    ['Benchscene1_primitives.zip', 'Benchscene1_N100.zip'].map(name => path.join(dir, name))
  );
  return candidates.find(file => existsSync(file)) ?? path.join(releases[1], 'Benchscene1_primitives.zip');
}

/**
 * Every helper that talks to the admin API takes the access code to act as, last, defaulting to the bootstrap
 * moderator's. A test that needs an author passes the code `createKey` returned, so it exercises the same
 * role rules the UI runs under.
 */
async function call(method: string, endpoint: string, init: RequestInit = {}, code = ADMIN_TOKEN): Promise<Response> {
  return fetch(`${BASE_URL}${endpoint}`, {
    method,
    ...init,
    headers: { Authorization: `Bearer ${code}`, ...(init.headers ?? {}) },
  });
}

export interface IssuedKey {
  id: number;
  label: string;
  role: 'author' | 'moderator';
  /** The code, in clear: the one moment it exists. */
  token: string;
}

/** Issues a personal key (moderator-only route, so it always acts as the bootstrap). Prefix keeps leaks greppable. */
export async function createKey(label: string, role: 'author' | 'moderator' = 'author'): Promise<IssuedKey> {
  const res = await call('POST', '/api/keys', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: `${E2E_ID_PREFIX}${label}-${Date.now()}`, role }),
  });
  if (!res.ok) throw new Error(`create key ${label} → ${res.status} ${await res.text()}`);
  return res.json();
}

/** Idempotent on the server; keys are revoked, never deleted, so a test ends by revoking what it issued. */
export async function revokeKey(id: number): Promise<void> {
  const res = await call('POST', `/api/keys/${id}/revoke`);
  if (!res.ok) throw new Error(`revoke key ${id} → ${res.status} ${await res.text()}`);
}

export async function createScenario(fields: Record<string, unknown>, code = ADMIN_TOKEN): Promise<void> {
  const res = await call('POST', '/api/catalog', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }, code);
  if (!res.ok) throw new Error(`create ${fields.id} → ${res.status} ${await res.text()}`);
}

export async function updateScenario(id: string, fields: Record<string, unknown>, code = ADMIN_TOKEN): Promise<void> {
  const res = await call('PUT', `/api/catalog/${encodeURIComponent(id)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }, code);
  if (!res.ok) throw new Error(`update ${id} → ${res.status} ${await res.text()}`);
}

export async function uploadArchive(id: string, file = SMALL_ARCHIVE, code = ADMIN_TOKEN): Promise<void> {
  const form = new FormData();
  form.append('archive', new Blob([await readFile(file)], { type: 'application/zip' }), path.basename(file));

  const res = await call('POST', `/api/scenarios/${encodeURIComponent(id)}/archive`, { body: form }, code);
  if (!res.ok) throw new Error(`upload ${id} → ${res.status} ${await res.text()}`);
}

/** Idempotent: a 404 means the test already removed it. Deleting is a moderator's, so this is the bootstrap's. */
export async function deleteScenario(id: string): Promise<void> {
  const res = await call('DELETE', `/api/catalog/${encodeURIComponent(id)}`);
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete ${id} → ${res.status} ${await res.text()}`);
  }
}

export async function adminScenarios(code = ADMIN_TOKEN): Promise<Array<Record<string, any>>> {
  const res = await call('GET', '/api/admin/scenarios', {}, code);
  if (!res.ok) throw new Error(`admin list → ${res.status}`);
  return (await res.json()).scenarios;
}

/** Slug of a category an author may use (authors cannot create one); the first the server lists. */
export async function firstCategorySlug(): Promise<string> {
  const res = await call('GET', '/api/categories');
  if (!res.ok) throw new Error(`categories → ${res.status}`);
  const { categories } = await res.json() as { categories: Array<{ slug: string }> };
  if (!categories.length) throw new Error('No categories: an author cannot create a scenario without one.');
  return categories[0].slug;
}

/** Removes anything left behind by an earlier interrupted run. */
export async function cleanupE2EScenarios(): Promise<number> {
  const rows = await adminScenarios();
  const stale = rows.filter(row => String(row.id).startsWith(E2E_ID_PREFIX));
  for (const row of stale) await deleteScenario(row.id);
  return stale.length;
}

/** A published scenario the student path can open; the smallest one available. */
export async function smallestPublishedScenario(): Promise<{ id: string; title: string }> {
  const res = await fetch(`${BASE_URL}/api/catalog?limit=50`);
  const { scenarios } = await res.json() as { scenarios: Array<{ id: string; title: string }> };

  const rows = await adminScenarios();
  const sizeById = new Map(rows.map(r => [r.id, Number(r.archiveBytes) || Number.MAX_SAFE_INTEGER]));

  const sorted = [...scenarios].sort(
    (a, b) => (sizeById.get(a.id) ?? Infinity) - (sizeById.get(b.id) ?? Infinity)
  );

  if (sorted.length === 0) throw new Error('No published scenarios to open.');
  return sorted[0];
}
