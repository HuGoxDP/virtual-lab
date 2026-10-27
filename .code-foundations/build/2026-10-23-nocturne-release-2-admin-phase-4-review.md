# Review: Phase 4 - Catalog management API (categories, previews, version tools, bulk, dashboard)

## Executed Results (Step 0)
- Backend suite: `DB_HOST=localhost DB_PORT=55432 ... ADMIN_TOKEN=ci-admin-token timeout 500 npm test` in `backend/` -> tests 1237, pass 1237, fail 0, skipped 0 (integration tests ran against the live Postgres).
- Frontend: `npx ng test --no-watch` -> 309 passed. `npm run test:scripts` -> 8 pass, 0 fail (includes the new DW-4.2 img-src test).
- e2e type-check: `tsc -p e2e/tsconfig.json --noEmit` -> only the two known `viewer.spec.ts` (100, 374) TS2683 errors that exist on the base commit; `csp.spec.ts` is clean (it needs a running stack and was not run).
- nginx syntax: `nginx -t` in a throwaway `nginx:alpine` container with the changed `nginx.conf`, `csp.conf` and a stubbed `player.nginx.conf` -> syntax ok, test successful.
- Lint/typecheck: none exists for the backend (as stated).
- Adversarial probe of `inspectPreview` (script outside the repo): EXIF segment containing a fake SOF is skipped by length (reads the real frame); fill bytes plus DHT before a progressive SOF parse; a segment length of 0xFFFF or 0 -> 400; a 3-byte JPEG -> 400; an empty buffer -> 400; 799 px -> 400; 801x500 -> accepted.

## Requirement Fulfillment

### DW-4.1
PREMISE:  Category CRUD, reorder and visibility work for moderators; deleting a used category -> 409; a hidden category's scenarios disappear from every public endpoint.
EVIDENCE: `backend/routes/categories.js:41-147` (all routes behind `authorize('moderator')`, GET behind `authorize('author')`); delete 409 at `categories.js:139`; `PUBLIC_ROW` at `backend/routes/catalog-public.js:79`, used at lines 104, 137, 178, 213, 227; the chips query filters `c.is_visible = true` (line 133); slug rule `catalog-input.js` `CATEGORY_SLUG_PATTERN`.
TRACE:    PUT `{isVisible:false}` -> `UPDATE categories` plus an audit row in one transaction. `GET /api/catalog`, the summary count, related, `/:id` and `?version=` all add `COALESCE(c.is_visible,true)`. DELETE with a scenario in the category -> `COUNT>0` -> `httpError(409)`. Reorder rejects partial, unknown and duplicate lists (409/400). A slug with no category row stays public by design.
TESTS:    `categories.test.js` "198. DW-4.1 ..." (10 tests: create, slug 1/2/50/51/uppercase, body validation, GET roles, PUT, reorder, delete 409/404, author 403, hidden category disappears from list/summary/chips/related/:id/?version=, no-row category stays public). All passed.
VERDICT:  PASS

### DW-4.2
PREMISE:  A valid PNG/JPEG preview is stored by hash and served from `/previews/`; invalid files -> 400; GC and the storage report cover previews; `img-src` no longer allows `https:`.
EVIDENCE: `backend/preview-image.js:62-99` (magic bytes, 5 MiB, min width, 16:10 warning); `backend/routes/previews.js:58-98`; `backend/storage.js` `createStore`, `commitPreview`, `previewHashOf`, `PREVIEW_URL`; `backend/routes/storage-admin.js` `referencedPreviews`, `classifyBoth`, `describe`; `nginx/nginx.conf` `location ^~ /previews/` with CSP include; `nginx/csp.conf` `img-src 'self' data: blob:`; `docker-compose.yml` previews volume (rw backend, ro nginx); `backend/Dockerfile` creates `/srv/previews`.
TRACE:    POST multipart PNG 800x500 -> multer memory (limit 5 MiB + 1) -> `inspectPreview` (ext `png`) -> `commitPreview` writes tmp then `put` renames to `<sha>.png` -> transaction locks the row, ownership re-checked, `image_url` set, audit row -> `{imageUrl:'/previews/<sha>.png', warnings}`. SVG, GIF, text, truncated, 5 MiB + 1, 799 px, ZIP -> 400 and nothing on disk or in the row. GC: `referencedPreviews` reads `image_url LIKE '/previews/%'`; orphans are collected and young ones protected for both stores.
TESTS:    `previews.test.js` (DW-4.2 tests 199/200 incl. dirty-file table, exact 5 MiB accepted, 16:9 warning, GC and report), `preview-image.test.js`, `preview-store.test.js`, `csp-conf.test.js`, `check-csp-assumptions.test.mjs`. All passed. The nginx location was syntax-checked in a container.
VERDICT:  PASS

### DW-4.3
PREMISE:  Every new version carries check results; re-run refreshes them; contents lists files and sizes within the caps.
EVIDENCE: `backend/versions.js:96-137` (`installUpload(..., checks)` inserts `checks`); `backend/routes/archives.js` (both `/archive` and `/from-archive` pass `checksFromValidation(validated, bytes)`); `backend/archive-checks.js:25-53`; `backend/routes/version-tools.js:29-62`; `backend/archive-validation.js` `openArchive`, `listArchiveEntries`.
TRACE:    Upload -> validator result -> `{ok, items}` stored on the new version row. POST `.../checks` -> `runArchiveChecks` re-validates the stored object (a refusal becomes an `error` item, an object missing from the store also becomes an `error` item) -> `UPDATE ... checks` plus audit. GET `.../contents` -> central directory only -> `{path,bytes,dir}` sorted, the entry-count cap applies (400 above it); roles owner or moderator.
TESTS:    `version-tools.test.js` 202 tests (upload, from-archive, pending upload carry checks; re-run refreshes; contents with roles and cap), `archive-checks.test.js` (8 tests). All passed.
VERDICT:  PASS

### DW-4.4
PREMISE:  Test-run results are stored on the version; out-of-range or oversized values -> 400.
EVIDENCE: `backend/test-run-input.js:33-70`; `backend/routes/version-tools.js:64-80` (moderator only, row stored in `scenario_versions.test_run`).
TRACE:    A body with TTFF 10^12 -> `number > 600000` -> `{error}` -> 400 before any DB access. Negative, NaN-like, Infinity, string, null, fractional `consoleErrors`, 101-char `engineBuild`, 301-char `userAgent`, a missing field -> 400. A valid body -> `UPDATE test_run` plus audit; a second run replaces the first.
TESTS:    `test-run-input.test.js` (7 tests, DW-4.4), `version-tools.test.js` 203 tests (stored with who/when, dirty bodies leave the stored run alone, 403 for an author, 404 for a foreign or unknown version). All passed.
VERDICT:  PASS

### DW-4.5
PREMISE:  Bulk reports per id; the dashboard and admin rows carry the stated fields, scoped (author -> own scenarios).
EVIDENCE: `backend/routes/bulk.js:58-77` (one `inTransaction` per id, `describeError` per failure); `backend/routes/dashboard.js:23-63`; `backend/audit.js` `listActivity`; `backend/scenario-rows.js:36-48` (`ownerLabel`, `pendingVersionId`, `currentVersion {id, sha256, bytes, checks{errors,warnings}}` plus an extra `checked`).
TRACE:    `{ids:['ok','ghost'], action:'delete'}` -> `results:[{id:'ok',ok:true},{id:'ghost',ok:false,error:'Сценарій не знайдено'}]`; `approve` without a current version goes through `applyTransition` -> 409 reported per id. The dashboard passes `ownerKeyId` for an author, so counts, the queue and the activity are filtered to their own scenarios; counts list all four statuses including zeros. History is owner or moderator only (403/404 otherwise).
TESTS:    `version-tools.test.js` 204 and 205 tests (bulk mixed ids, bulk 400s and 403, dashboard author vs moderator vs empty, history, admin row fields scoped). All passed.
VERDICT:  PASS

### DW-4.6
PREMISE:  `/api/config` returns the preview limits; the old `/admin` edit and `publish:release` still work under the `imageUrl` rule; backend and CSP suites green.
EVIDENCE: `backend/routes/catalog-public.js:157-162`; `backend/catalog-input.js` `imageUrlProblem`; `backend/routes/catalog-admin.js` (PUT checks against the locked row's `image_url`; POST uses `imageUrlProblem(imageUrl,'')`); `backend/scripts/catalog-metadata.mjs` (Unsplash URL removed); `backend/scripts/publish-release.mjs:178` sends `''` by default.
TRACE:    `GET /api/config` -> `{maxArchiveBytes, preview:{maxBytes:5242880, minWidth:800, aspect:1.6}}`. Moderator PUT with `''`, the current value or `/previews/<64 hex>.png` -> 200; with `https://...` -> 400; an author PUT with any `imageUrl` -> 400 (`forbiddenAuthorFields`). Migration 010 clears off-origin URLs, lists them via NOTICE (logged by `migrations.js`), is idempotent.
TESTS:    `version-tools.test.js` "206. DW-4.6 config"; `previews.test.js` "201. DW-4.6 the imageUrl rule", "POST /api/catalog ... old admin form", "migration 010 ... run twice"; `author-rules`/`catalog-api`/`route-table` edited tests. Whole backend suite 1237/1237, frontend 309/309, test:scripts 8/8.
VERDICT:  PASS

**All requirements met:** YES

## Edge cases (prompt-listed)
- Shared manifest_id limit: migration 010 widens `scenarios.manifest_id` to 255 (asserted via information_schema in `previews.test.js`), and the validator caps id/version/engineVersion at 255/50/100 (`archive-checks.test.js` "manifest fields"). Handled.
- Non-string manifest name/version -> 400 in `from-archive`: `manifestFieldProblem`; tested (`version-tools.test.js` 318, `archive-checks.test.js` 109). Handled.
- Preview type by magic bytes, PNG/JPEG only, <= 5 MiB (5 MiB exactly accepted), width >= 800, 16:10 +-5% else warning, short file -> 400: verified by the dirty-file table and by my probe. Handled.
- Slug `^[a-z0-9-]{2,50}$` with 1/2/50/51/uppercase: tested. Handled.
- Test-run ranges (0-600000, 0-1000, 0-64 GiB, 0-100000) and caps (100, 300): both ends tested in `test-run-input.test.js`. Handled.
- Bulk per-id results, each id its own transaction: yes. Checks/contents reuse the archive caps (`MAX_ARCHIVE_ENTRIES`, validator's `MAX_ENTRY_BYTES`): yes.
- Test-plan item "PNG named `.jpg`, JPEG claiming `image/png` -> 400" (plan line 435): the implementation accepts such files as what their bytes are, and its test asserts that (`previews.test.js` "the type is the bytes"). This follows the stated rule "preview type by magic bytes" and `docs/test-plan.md:617` ("type by bytes"), so I treat it as an ambiguous list entry, not an unhandled case. Flagged for the orchestrator: if the literal 400 is wanted, this is a one-line behaviour change plus a test change.

## Test-DW Coverage
- [x] All DW items have named tests that ran in Step 0 (DW-4.1: 17 references, 4.2: 22, 4.3: 15, 4.4: 10, 4.5: 5, 4.6: 6).
- [x] Coverage level 100% - gaps: no routine lacks a test that executes it with assertions. Judgment call (non-blocking): `audit.listActivity`, `versions.getVersionByParam` and `auth.requireScenarioEditor` have no *direct* unit test, only integration coverage through the dashboard/history/checks/preview routes (e.g. `vurl('vt-a','abc','checks') -> 404`, stranger 403/404 on previews and history). The repo has no DB/pool stubbing, and its convention is integration tests for DB-bound routines; I did not count this as a FAIL. `openArchive` is internal and exercised through `listArchiveEntries` and `validateScenarioArchive` unit tests.

## Dead Code
None found. `storage.js` keeps thin delegating exports (`listObjects`, `classifyObjects`, `deleteObjects`, `OBJECTS_DIR`, `TMP_DIR`) for existing callers; they are used.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | Row locks (`FOR UPDATE`) on preview upload/remove, category delete/reorder, transitions; checks computed outside the transaction, `rowCount` guarded (404 if the version vanished); `put` refreshes mtime so GC cannot sweep a just-re-uploaded preview. Category delete vs concurrent scenario insert has no FK (known, by design). |
| Error Handling | PASS | multer errors -> 400; invalid archive -> `error` item, I/O faults propagate to a logged 500; bulk catches per id via `describeError`; temp preview file unlinked on failure (`commitPreview`). |
| Resources | PASS | `openArchive` closes the zip on its own failure path; `listArchiveEntries` closes in `finally`; previews held in memory at most 5 MiB + 1 per request; tmp files cleaned in `commitPreview` and by `cleanStaleTemp` for both stores. |
| Boundaries | PASS | Probed JPEG/PNG parser: no read past the buffer (length 0/0xFFFF, 3-byte file, empty buffer all -> 400); dimensions capped at 8192; 5 MiB and 800 px edges tested; test-run ranges inclusive at both ends. |
| Security | PASS | Type from bytes only, SVG/GIF refused, `nosniff` plus CSP on `/previews/`; `imageUrl` restricted to `''`/current/`/previews/<64hex>.(png|jpg)`; author scoping via `requireScenarioEditor` before the body is read and re-checked under the row lock; dashboard scoped by `owner_key_id`; `scenarioCount` withheld from authors. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (uploads, JSON bodies, URL params, manifest fields) | PASS | `inspectPreview`, `validateTestRun`, `validateCategory`, bulk's inline body checks, `getVersionByParam` regex, `manifestFieldProblem`; dirty inputs traced/tested to 400 |
| cc-defensive-programming | No executable code in assertions; assertions only for bugs | PASS | No `assert` in production code; user errors use `httpError` |
| cc-defensive-programming | No empty catch blocks | PASS | Remaining bare catches in `storage.js` (`put` existence probe, `deleteObjects`, `cleanStaleTemp`, `listObjects` stat race) are commented, intentional races carried over from the base code |
| cc-defensive-programming | Barricade: validate at the boundary, internals trust; security paths re-validate | PASS | Routes validate, `lockEditable`/`applyTransition` re-check ownership under lock |
| aposd-designing-deep-modules | Interfaces deep, information hidden | PASS | `createStore` factory hides layout/naming for both stores; `inspectPreview` one call hides header parsing; `PUBLIC_ROW` single fragment; `describeError`/`sendError` share one mapping |
| aposd-designing-deep-modules | No silent failure | PASS | Bulk surfaces per-id errors; checks return failures as items; migration 010 logs each cleared URL |

## Notes (non-blocking)
- `routes/bulk.js` header says every success writes "the same audit row ... flagged `bulk`", but approve/unpublish go through `applyTransition`, whose audit row carries no `bulk` flag (only set-category and delete do). Comment is slightly inaccurate.
- `POST /api/telemetry/session` still accepts a scenario in a hidden category (`scenarioExists`); it is not in the DW list of public endpoints.
- `GET .../contents` reports declared (central-directory) sizes and does not apply `MAX_ENTRY_BYTES` per entry; nothing is unpacked, so this is informational only.
- Migration 010's regex clears `scheme://` and `//host` forms only; a `data:` or `scheme:path` image URL would survive (not required by the DW).
- Preview upload commits the file before the ownership re-check under the row lock; a row deleted in that window leaves an orphan that GC collects after the age cutoff.
- `currentVersion` carries an extra `checked` flag beyond the stated shape (additive, documented).

## Issues (if FAIL)
None.

**Verdict: PASS**
