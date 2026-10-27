# Discovery + Design: Phase 4 - Catalog management API

## Files Found
backend: storage.js (archive store, OBJECT_NAME = `<sha>.zip`), config.js, db.js, auth.js, audit.js, versions.js,
archive-validation.js, scenario-rows.js (ADMIN_COLUMNS), catalog-input.js, http-error.js, migrations.js,
routes/{catalog-admin,catalog-public,archives,versions,storage-admin,workflow,keys,telemetry,health}.js,
scripts/{catalog-metadata,publish-release}.mjs; nginx/{nginx.conf,csp.conf}; Dockerfile.frontend; backend/Dockerfile;
docker-compose.yml; e2e/tests/csp.spec.ts; frontend/scripts/check-csp-assumptions(.test).mjs; docs/test-plan.md (last = 197).

## Current State
Categories table exists (006: slug, label, icon, sort_order, is_visible, no FK from scenarios). Public routes filter on
`status='published'` only (is_visible only filters chips). `scenario_versions` has `checks` and `test_run` JSONB columns,
both unwritten. Author `imageUrl` already forbidden (AUTHOR_FORBIDDEN_FIELDS); a moderator may send any `imageUrl`.

## Gaps (plan vs reality)
1. Assumption "no external imageUrl in production": dev DB (read-only SELECT) has 10 rows, all same-origin
   `/assets/scenarios/*.jpg`; none external. `catalog-metadata.mjs:49` still ships an Unsplash URL for a NEW solar-system
   row -> removed. Migration 010 still clears external URLs and logs them (fallback behaviour, harmless).
2. Assumption "PNG/JPEG dimensions readable from headers": holds (PNG IHDR, JPEG SOFn scan). No dependency added.
3. `scenarios.manifest_id` VARCHAR(200) vs `scenario_versions.manifest_id` VARCHAR(255): widen scenarios to 255 in 010 and
   cap id/version/engineVersion lengths in the validator (400) so no insert can 500.
4. `from-archive` `clip(String(manifest.name))` turns an object into "[object Object]" -> validate string type.
5. Postgres NOTICEs are not surfaced by `pg`; migration runner gets a `notice` listener so 010's list reaches the log.
6. Preview volume: ZIP temp dir is on another volume (rename would be cross-device) -> previews get their own `tmp/`.
7. Dev `/assets/scenarios/*.jpg` rows: the "current value" rule keeps old-admin saves working for them.

## Code Standards
Express route per concern in routes/; one transaction per mutation (`inTransaction`) + `audit.record`; Ukrainian user
messages, English logs; httpError/sendError; snake_case SQL aliased to camelCase; spec headers cite test-plan numbers;
`// backend/...` path comment; no DB mocks; tests self-skip without DB.

## Test Infrastructure
node:test + supertest, real Postgres :55432, helpers in test/helpers (db.js, keys.js, fixtures.js, app-env.js).
Route-table test (179) lists every guarded route x caller; extended for Phase 4.

## DW Verification
| DW-ID | Item | Status | Test cases |
|---|---|---|---|
| DW-4.1 | Categories CRUD/reorder/visibility; used -> 409; hidden category hides scenarios everywhere public | COVERED | categories.test.js (CRUD, slug 1/2/50/51/uppercase, reorder, hide -> list/summary/related/:id/?version, delete used 409, role table) |
| DW-4.2 | PNG/JPEG preview stored by hash, served /previews/; bad files 400; GC+storage report cover previews; img-src no https | COVERED | previews.test.js, preview-image.test.js (unit), previews-gc.test.js, csp-conf.test.js (unit), frontend test:scripts, e2e csp.spec (not run) |
| DW-4.3 | Version checks on upload, re-run refreshes, contents within caps | COVERED | archive-checks.test.js (unit + integration), contents nested archive, caps |
| DW-4.4 | Test-run stored on version; out-of-range/oversized -> 400 | COVERED | test-run.test.js (+ error shape) |
| DW-4.5 | Bulk per id; dashboard + admin rows scoped | COVERED | bulk.test.js, dashboard.test.js, admin-rows in dashboard test |
| DW-4.6 | /api/config preview limits; old /admin + publish:release under imageUrl rule; suites green | COVERED | config test, image-url-rule.test.js, migration-010.test.js, publish-release unit, full suites |
All items COVERED: YES

## Design (design-it-twice)
### Second store
A: parameterise every storage.js function with a store arg. B: `createStore({objectsDir, tmpDir, prefix, nameRe})` factory;
archives and previews are two instances, existing archive exports unchanged. C: separate previews.js duplicating GC code.
Choice B: GC/report treat both stores uniformly (key = sha256, object name derived by the store), callers of the archive
API do not change. Depth: factory hides naming, listing, age classification, deletion.
### Preview image
`preview-image.js: inspectPreview(buffer)` -> `{ext, type, width, height, warnings}` or 400. Magic bytes only; PNG IHDR,
JPEG SOF scan (bounded). Pure and unit-testable; route stays thin. Max 8192 px per side (decompression-bomb guard,
default, reversible).
### Checks
`archive-checks.js`: `checksFromValidation({manifest, entries, warnings, bytes})` (pure, used at upload from the result the
route already holds) and `runArchiveChecks(path, catalogId)` (re-run: validate then same builder; an ArchiveInvalid becomes an
error item). Stored whole in `scenario_versions.checks`. Contents: `listArchiveEntries` shares the cap-checked open with validate.
### Routes (actor modules)
categories.js, previews.js, version-tools.js (contents/checks/test-run), bulk.js, dashboard.js (dashboard + history).
Public visibility is ONE SQL fragment (`s.status='published' AND COALESCE(c.is_visible,true)`) used by list, summary,
related, :id and ?version=.
### Test-run body
Numeric `{timeToFirstFrameMs, avgFps, gpuMemoryBytes, consoleErrors, engineBuild, userAgent}` OR error result
`{error (<=1000 chars), engineBuild?, userAgent?}` with numbers absent (numbers + error -> 400). Stored with `ranAt`, `ranBy`.

## Prerequisites
- [x] files exist  - [x] deps available (multer memoryStorage, node:crypto)

## Recommendation
BUILD

## Status (final)
Implemented; backend 1237/1237, frontend 309/309, test:scripts 8/8, nginx -t ok (docker, --add-host backend), e2e type-checked only.
Decisions: test-run error shape `{error<=1000, engineBuild?, userAgent?}`; preview max side 8192; bulk max 100 ids; 010 widens scenarios.manifest_id to 255.
