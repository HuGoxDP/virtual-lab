// path: src/app/models/admin.model.ts

import { AdminScenario, ScenarioFeature, ScenarioStatus } from './scenario.model';

/** Who a code belongs to (`GET /api/auth/me`). `keyId` is null for the bootstrap `ADMIN_TOKEN`. */
export type AdminRole = 'author' | 'moderator';

export interface AdminUser {
  role: AdminRole;
  label: string;
  keyId: number | null;
}

/** The five status transitions: `POST /api/scenarios/:id/<action>`. */
export type TransitionAction = 'submit' | 'withdraw' | 'approve' | 'reject' | 'unpublish';

/** What `transition` answers (`routes/workflow.js`). */
export interface TransitionResult {
  id: string;
  status: ScenarioStatus;
  isPublished: boolean;
  moderatorNote: string | null;
  submittedAt: string | null;
}

/** Fields a `PUT /api/catalog/:id` accepts from the Метадані tab. Authors may not send `author`. */
export interface ScenarioPatch {
  title?: string;
  description?: string;
  fullDescription?: string;
  category?: string;
  categoryLabel?: string;
  version?: string;
  author?: string;
  features?: ScenarioFeature[];
}

/** `POST /api/scenarios/:id/preview`. */
export interface PreviewResult {
  imageUrl: string;
  warnings: string[];
}

export interface ArchiveCheckItem {
  level: 'ok' | 'warning' | 'error';
  label: string;
  note: string;
}

export interface ArchiveChecks {
  ok: boolean;
  items: ArchiveCheckItem[];
}

/** A stored test run: numbers or `error`, never both (`backend/test-run-input.js`). */
export interface TestRun {
  timeToFirstFrameMs?: number;
  avgFps?: number;
  gpuMemoryBytes?: number;
  consoleErrors?: number;
  error?: string;
  engineBuild?: string;
  userAgent?: string;
  ranAt?: string;
  ranBy?: string;
}

export type VersionState = 'current' | 'pending' | 'archived';

/** One entry of `GET /api/scenarios/:id/versions`, newest first. */
export interface ScenarioVersion {
  id: number;
  sha256: string;
  bytes: number;
  manifestId: string | null;
  manifestVersion: string | null;
  engineVersion: string | null;
  uploadedByKeyId: number | null;
  uploadedByLabel: string | null;
  uploadedAt: string;
  state: VersionState;
  checks: ArchiveChecks | null;
  testRun: TestRun | null;
  url: string;
}

export type VersionAction = 'accept' | 'reject' | 'restore';

/** One journal row (`audit.listActivity`). `details` is whatever the action recorded. */
export interface AuditRow {
  id: number;
  scenarioId: string | null;
  scenarioTitle: string | null;
  actorLabel: string;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface Dashboard {
  counts: Record<ScenarioStatus, number>;
  queueSize: number;
  activity: AuditRow[];
}

export interface AdminCategory {
  slug: string;
  label: string;
  icon: string;
  sortOrder: number;
  isVisible: boolean;
  /** Moderators only: scenarios in the category, every status. */
  scenarioCount?: number;
}

export interface CategoryInput {
  slug?: string;
  label?: string;
  icon?: string;
  isVisible?: boolean;
}

export interface KeyRow {
  id: number;
  label: string;
  role: AdminRole;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** `POST /api/keys`: the only response that ever carries the token. */
export interface CreatedKey {
  id: number;
  label: string;
  role: AdminRole;
  token: string;
}

export type BulkAction = 'approve' | 'unpublish' | 'set-category' | 'delete';

export interface BulkResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** `GET /api/config`. */
export interface PlatformConfig {
  maxArchiveBytes: number;
  preview: { maxBytes: number; minWidth: number; aspect: number };
}

/** One entry of `GET /api/scenarios/:id/versions/:vid/contents`, sorted by path. */
export interface ArchiveEntry {
  path: string;
  /** Unpacked size; 0 for a directory. */
  bytes: number;
  dir: boolean;
}

/** What the manifest of an archive says, as `POST /api/scenarios/from-archive` reports it. */
export interface ArchiveManifestSummary {
  id: string;
  name: string;
  version: string;
  entryPoint: string;
  resourceCount: number;
  engineVersion: string | null;
}

/** `POST /api/scenarios/from-archive`: the new draft row, its first version and what the manifest said. */
export interface FromArchiveResult {
  scenario: AdminScenario;
  version: ScenarioVersion;
  manifest: ArchiveManifestSummary;
  warnings: string[];
}
