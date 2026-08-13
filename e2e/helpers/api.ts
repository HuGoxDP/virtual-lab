// e2e/helpers/api.ts
//
// Admin API access for setup and teardown.
//
// Tests run against the live stack, so anything they create must be cleaned up
// and must never collide with real content — hence the `e2e-` id prefix and the
// timestamp. A leaked row would show up in the student catalog.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

// `__dirname`, not `import.meta.url`: Playwright transpiles these specs to CJS,
// where import.meta is a syntax error.
const HERE = __dirname;

export const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8044';

const AUTH = { Authorization: `Bearer ${process.env.ADMIN_TOKEN ?? ''}` };

/** Anything these tests create is prefixed so a leak is obvious and greppable. */
export const E2E_ID_PREFIX = 'e2e-';

export function uniqueScenarioId(label: string): string {
  return `${E2E_ID_PREFIX}${label}-${Date.now()}`;
}

/** The smallest archive in the release — enough to prove upload without the wait. */
export const SMALL_ARCHIVE = path.resolve(
  HERE,
  '../../../../ScenarioCreator/ReleaseScenarios/test/Benchscene1_primitives.zip'
);

async function call(method: string, endpoint: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${endpoint}`, {
    method,
    ...init,
    headers: { ...AUTH, ...(init.headers ?? {}) },
  });
}

export async function createScenario(fields: Record<string, unknown>): Promise<void> {
  const res = await call('POST', '/api/catalog', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`create ${fields.id} → ${res.status} ${await res.text()}`);
}

export async function updateScenario(id: string, fields: Record<string, unknown>): Promise<void> {
  const res = await call('PUT', `/api/catalog/${encodeURIComponent(id)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`update ${id} → ${res.status} ${await res.text()}`);
}

export async function uploadArchive(id: string, file = SMALL_ARCHIVE): Promise<void> {
  const form = new FormData();
  form.append('archive', new Blob([await readFile(file)], { type: 'application/zip' }), path.basename(file));

  const res = await call('POST', `/api/scenarios/${encodeURIComponent(id)}/archive`, { body: form });
  if (!res.ok) throw new Error(`upload ${id} → ${res.status} ${await res.text()}`);
}

/** Idempotent: a 404 means the test already removed it. */
export async function deleteScenario(id: string): Promise<void> {
  const res = await call('DELETE', `/api/catalog/${encodeURIComponent(id)}`);
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete ${id} → ${res.status} ${await res.text()}`);
  }
}

export async function adminScenarios(): Promise<Array<Record<string, any>>> {
  const res = await call('GET', '/api/admin/scenarios');
  if (!res.ok) throw new Error(`admin list → ${res.status}`);
  return (await res.json()).scenarios;
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
