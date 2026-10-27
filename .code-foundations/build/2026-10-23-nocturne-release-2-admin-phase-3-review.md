# Review: Phase 3 - status workflow, archive versions, draft preview

## Executed Results (Step 0)
- Backend suite (`npm test`, Postgres :55432): 1072 tests, 1072 pass, 0 fail, 0 skipped.
- Frontend (`npx ng test --no-watch`): 21 files, 309 tests, all pass.
- e2e type-check (frontend's tsc against `e2e/tsconfig.json`; `npx tsc` in e2e has no local typescript): only the two `viewer.spec.ts` errors (lines 100, 374), same file unchanged on base `1b80408`. The new/changed e2e specs type-check. e2e specs themselves not runnable here (read only).
- Lint/typecheck: no backend script exists.

## Requirement Fulfillment

### DW-3.1
PREMISE: `008` and `009` apply twice without error; existing rows become published/draft with one current version; catalog shows exactly the published ones.
EVIDENCE: backend/migrations/008_status_and_versions.sql:26-35 (`is_published IS TRUE`), :80-86 (backfill, NOT EXISTS guard); 009:11-12; test migration-008-009.test.js:52-128.
TRACE: rows true/false/NULL -> published/draft/draft; archived rows -> one `current` version each; 008 re-run, 009 twice, 008 after 009 -> state unchanged; `status='published'` count = 3.
VERDICT: PASS

### DW-3.2
PREMISE: transition table holds for every (status x action x role), each success writing an audit event.
EVIDENCE: backend/workflow.js:24-30 (TRANSITIONS), :56-94 (applyTransition, FOR UPDATE, audit.record at :88); routes/workflow.js:15-35; test workflow-transitions.test.js:91-118 (full matrix), :227 (concurrent approves), unit/workflow.test.js.
TRACE: approve x2 concurrently -> row lock serialises, second sees `published` -> 409; reject note 2000 kept / 2001 -> 400; none/blank -> default text.
VERDICT: PASS

### DW-3.3
PREMISE: upload-by-status rules hold; a pending archive leaves students on the old one until accept.
EVIDENCE: backend/versions.js:100-141 (installUpload), routes/archives.js:100-135 (FOR UPDATE then installUpload); tests versions-upload.test.js:75-256.
TRACE: author upload to published -> `pending`, `pointScenarioAt` not called, scenarios.archive_* unchanged; accept -> promote repoints. Review -> 409 (pre-check and under lock). Racing approve vs upload tested (:227).
VERDICT: PASS

### DW-3.4
PREMISE: accept, reject, author retract of pending; restore of archived; delete rules and `:vid` ownership.
EVIDENCE: backend/routes/versions.js:60-130; versions.js:143-156; tests versions-routes.test.js:98-330.
TRACE: foreign/malformed vid -> getVersion filters `scenario_id` -> 404; DELETE current -> 409; archived by author -> 403; other author -> 403; reject/delete remove the row only; accept/restore in one transaction under scenario lock.
VERDICT: PASS

### DW-3.5
PREMISE: `/play/:id?draft=<sha256>` plays that version for owner/moderator (also in review); anonymous access to non-published version -> 404.
EVIDENCE: backend/routes/catalog-public.js:153-196 (versionPreview, SHA256_HEX, no-store); auth.js optionalAuthenticate; frontend viewer.component.ts (`draftHash`, `fetchScenarioById(id, hash)`), scenario.service.ts; tests version-preview.test.js:81-209, viewer-lifecycle.spec.ts, scenario.service.spec.ts.
TRACE: anonymous + draft/review/rejected -> `visible` false -> same 404 as unknown; owner/moderator -> projection with scenarioUrl of that sha, manifestUrl null; 63/65/non-hex/array -> 400; foreign hash -> 404.
VERDICT: PASS

### DW-3.6
PREMISE: `from-archive` creates a draft from a ZIP and reports its manifest; a taken id -> 409.
EVIDENCE: backend/routes/archives.js:150-232; tests from-archive.test.js:75-258.
TRACE: ZIP validated before commit -> id regex `^[a-z0-9][a-z0-9-]{1,99}$` (400 + rebuild hint; 101 chars, `/`, spaces, dots all 400) -> existence check 409 (+ 23505 race mapping) -> row + version + audit in one transaction -> `{scenario, version, manifest, warnings}`; invalid ZIP -> 400, no row.
VERDICT: PASS

### DW-3.7
PREMISE: GC keeps every object referenced by a scenario or any version; a deleted version's object becomes collectible under mtime/`GC_MIN_AGE_MS`.
EVIDENCE: backend/routes/storage-admin.js:23-36 (UNION scenarios + scenario_versions); storage.js:82-89 (utimes refresh); tests versions-gc.test.js:76-180, unit/storage.test.js.
TRACE: pending/archived sha survive sweep; delete row (aged object) -> collected; dedup re-upload bumps mtime -> not collected.
VERDICT: PASS

### DW-3.8
PREMISE: new rows start as `draft`; old `/admin`, `publish:release` (dry run + real) and every existing suite stay green on the compatibility field.
EVIDENCE: migration 008 default 'draft', catalog-admin.js POST no is_published; PUT compat at catalog-admin.js:208-224; publish-release.mjs:183-215; e2e/tests/admin-golden-path.spec.ts; tests auth-and-crud, catalog-api, publish-release.test.js, full suite green.
TRACE: POST -> draft; upload; PUT `{isPublished:true}` -> approve (409 with no archive); script uploads then `approve`; dry-run prints "would approve".
VERDICT: PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] Every DW item has named tests (IDs 187-194 with DW-3.x in names), all ran green.
- [x] Level 100%: pure/unit routines (parseRejectNote, TRANSITIONS, sendError/httpError, optionalAuthenticate non-DB paths, SCENARIO_ID_PATTERN, parseDraftHash, validReturnTo, fetchScenarioById, commitArchive mtime, publish-release) have unit tests. DB-bound routines (versions.listVersions/getVersion/promote/removeVersion/installUpload, scenario-rows.fetchAdminRow, applyTransition) have no stand-alone unit file but are exercised directly by real-DB integration tests, the repo's convention for DB code. Gaps: none blocking (see Notes).

## Dead Code
None found (no unused imports in changed route files, no debug leftovers).

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | Every mutating path locks the scenario row (`FOR UPDATE`) inside the transaction; partial unique indexes backstop one-current/one-pending; race tests (approve x2, upload vs approve, accept vs restore) pass. |
| Error Handling | PASS | httpError rolls back transactions; from-archive maps 23505 to 409; non-4xx -> logged 500 without detail; temp files discarded on every exit. |
| Resources | PASS | Temp file wrapper discards unless committed; transactions via inTransaction; version count capped at 50. |
| Boundaries | PASS | vid regex bounds the int; `?version=` exactly 64 hex, arrays rejected; note 2000/2001; id regex 2-100. |
| Security | PASS | Anonymous 404 identical for unknown/hidden; authors limited to own rows; `returnTo` validator rejects `https://`, `//evil`, backslash, `..`; parameterised SQL throughout. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-designing-deep-modules | Deep interfaces / info hiding | PASS | `applyTransition(db, principal, id, action)` and `installUpload` hide locking, status rules and invariants behind one call; the compat PUT reuses them rather than duplicating rules. |
| cc-defensive-programming | External input validated at entry; no empty catch | PASS | manifest id, `?version=`, `:vid`, note, `returnTo` all validated; the only swallow is `discardTemp`'s best-effort unlink (pre-existing). |
| cc-defensive-programming | Assertion vs error handling | PASS | `applyTransition` throws for an unknown action (programmer bug); client errors are httpErrors. |
| aposd-verifying-correctness | Requirements, concurrency (TOCTOU), errors, resources, boundaries, security | PASS | See dimensions above; all listed edge cases are covered by named tests. |

## Notes (non-blocking)
- A version row stores `manifest_id` as VARCHAR(255) but `scenarios.manifest_id` is VARCHAR(200): an author's pending upload with a 201-255 char manifest id would store, then fail (500) at accept. The same oversize failed on the old path; unlisted edge case.
- Preview of a *pending* version of a published scenario is public to anyone who knows the hash (the requirement states published scenarios' versions are public; hash is unguessable).
- from-archive `clip(manifest.name, 255)` stringifies a non-string `name` (e.g. an object) into "[object Object]" rather than a 400; cosmetic.
- DB-bound routines lack a standalone unit file; covered via integration tests.

**Verdict: PASS**
