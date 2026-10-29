# Discovery + Design: Phase 3 - Publishing workflow and versions

## Files Found
- backend: routes/{archives,catalog-admin,catalog-public,storage-admin}.js, auth.js, db.js, audit.js, storage.js, migrations/007, scripts/publish-release.mjs, test/helpers/{db,keys,fixtures}.js
- tests reading/writing `is_published`: archive-caps, archives-and-telemetry, auth-and-crud, author-rules, catalog-api, catalog, rate-limits, route-table (all must move to `status`, 009 drops the column)
- frontend: pages/viewer/viewer.component.ts + viewer-format.ts, services/scenario.service.ts (fetchScenarioById), admin.service.ts (token), models/scenario.model.ts
- e2e: admin-golden-path.spec.ts (publish step), hostile-archive / ktx2-render (create with isPublished then upload), ktx2.spec, viewer.spec (isPublished readers)

## Assumption check
`publish-release.mjs` is the only script writing `isPublished` (import-release-assets.mjs PUTs `manifestUrl` only) - TRUE. e2e specs hostile-archive/ktx2-render/ktx2 also PUT `isPublished` (they go through the compat mapping; ordering fixed where they publish before upload).

## Gaps vs plan
- `category`/`category_label` are NOT NULL: `from-archive` needs a category for the new draft. Plan silent -> optional multipart field `category` (existing slug), default = first category by sort_order, 400 if none exist.
- Plan has no rule for uploading bytes identical to the current/pending version -> a no-op on versions (no duplicate row), still 201.
- `frontend/src/app/player/**` does not exist (player-isolation lives in the engine's PlayerHost); nothing to change there.

## Design (design-it-twice)
A) inline SQL per route; B) `versions.js` owns scenario_versions + the scenarios archive columns (one invariant: scenarios.archive_* mirrors the `current` row), `workflow.js` owns the transition table; C) DB triggers. Chose B: transitions are a data table (`TRANSITIONS`) applied by one `applyTransition(db, principal, id, action, input)`; PUT compat, the five POST routes and tests all go through it. Upload, from-archive and the version routes call the same `versions.js` functions.
- Authoritative checks always under `SELECT ... FOR UPDATE` on the scenario row inside the route's transaction; partial unique indexes (one current / one pending per scenario) are the backstop.
- `optionalAuthenticate` (auth.js): no header -> anonymous; wrong credential -> counts toward the failed-auth limiter, then anonymous (an oracle-free 404 for non-published).
- New modules: migrations 008/009, backend/versions.js, backend/workflow.js, backend/scenario-rows.js (ADMIN_COLUMNS), routes/workflow.js (transitions), routes/versions.js (version routes), from-archive in routes/archives.js.

## DW Verification
| DW-ID | Status | Test Cases |
|---|---|---|
| DW-3.1 | COVERED | migration-008-009.test.js (twice, backfill, catalog count) |
| DW-3.2 | COVERED | workflow-transitions.test.js (matrix, concurrent approve, reject note 2000/2001, audit) + unit workflow table |
| DW-3.3 | COVERED | versions-upload.test.js (by status, pending keeps old URL until accept) |
| DW-3.4 | COVERED | versions-routes.test.js |
| DW-3.5 | COVERED | version-preview.test.js + viewer vitest (draft/returnTo) + e2e draft-preview.spec.ts |
| DW-3.6 | COVERED | from-archive.test.js |
| DW-3.7 | COVERED | versions-gc.test.js + storage unit (mtime refresh) |
| DW-3.8 | COVERED | existing suites on `status` + compat tests, publish-release unit test (approve order) |

All items COVERED: YES

## Recommendation
BUILD
