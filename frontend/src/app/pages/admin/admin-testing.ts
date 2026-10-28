// path: src/app/pages/admin/admin-testing.ts
//
// Shared by the admin specs: a row factory and the settle helper. No test framework import, so the
// production build (which includes this file) has nothing to resolve.

import { ComponentFixture } from '@angular/core/testing';

import { AuditRow, ScenarioVersion, VersionState } from '../../models/admin.model';
import { AdminScenario } from '../../models/scenario.model';

export function adminRow(id: string, overrides: Partial<AdminScenario> = {}): AdminScenario {
  return {
    id, title: `Сценарій ${id}`, description: 'Короткий опис', fullDescription: '', category: 'physics', categoryLabel: 'Фізика',
    imageUrl: '/previews/a.png', scenarioUrl: '/scenarios/x.zip', version: '1.0.0', author: 'Автор', archiveBytes: 2_100_000,
    updatedAt: '2026-10-01T10:00:00Z', features: [], status: 'draft', isPublished: false, moderatorNote: null, submittedAt: null,
    storageKind: 'local', archiveSha256: 'a'.repeat(64), manifestId: id, manifestVersion: '1.0.0', manifestEngineVersion: null,
    ownerKeyId: 1, ownerLabel: 'Автор', pendingVersionId: null,
    currentVersion: { id: 1, sha256: 'a'.repeat(64), bytes: 2_100_000, checked: true, checks: { errors: 0, warnings: 0 } },
    ...overrides,
  };
}

export function versionRow(id: number, state: VersionState, overrides: Partial<ScenarioVersion> = {}): ScenarioVersion {
  const sha256 = (id.toString(16) + 'b'.repeat(64)).slice(0, 64);
  return {
    id, sha256, bytes: 2_100_000, manifestId: 'alpha', manifestVersion: `1.${id}.0`, engineVersion: 'WebEngineTS 0.4',
    uploadedByKeyId: 1, uploadedByLabel: 'Олена', uploadedAt: '2026-03-12T10:00:00Z', state,
    checks: { ok: true, items: [{ level: 'ok', label: 'Маніфест', note: 'id "alpha"' }] }, testRun: null,
    url: `/scenarios/${sha256}.zip`, ...overrides,
  };
}

export function auditRow(action: string, overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: Math.random(), scenarioId: 'x', scenarioTitle: 'X', actorLabel: 'Іван', action, details: null,
    createdAt: '2026-03-12T12:22:00Z', ...overrides,
  };
}

/** Lets awaited calls and the signal writes after them settle, then renders. */
export async function settle(fixture: ComponentFixture<unknown>, rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    fixture.detectChanges();
  }
}
