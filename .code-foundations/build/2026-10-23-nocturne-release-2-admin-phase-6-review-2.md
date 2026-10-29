# Review: Phase 6 - Файл, Перевірка, wizard, legacy removal (review 2)

## Executed Results (Step 0)
- Unit suite: `npx ng test --no-watch` (frontend/) -> 39 files, 598 tests passed, 0 failed. Coverage: lines 98.05%, branches 92.54%.
- Build: `npm run build` -> OK. `npm run check:csp` -> OK (no import map, nonce, inline script).
- e2e type-check: `tsc -p e2e/tsconfig.json --noEmit` -> only the two baseline errors in `e2e/tests/viewer.spec.ts` (100, 374).
- Lint: none configured.
- NOT executed: all Playwright e2e (needs a docker stack built from this branch). e2e verified by reading and type-check only.

## Requirement Fulfillment

### DW-6.1
PREMISE:  Файл replaces the archive with progress and cancel, shows versions with role-appropriate restore/delete, and the pending banner with its preview link and actions.
EVIDENCE: scenario-files.component.ts (template: pending banner, `canRestore`/`canDelete`, `vl-archive-upload`); archive-upload.component.ts `start`/`cancel`; admin-api.service.ts `upload`.
TRACE:    pick ZIP -> checkArchiveFile -> AdminApi.uploadArchive (abortable, progress) -> done -> loadVersions + changed. Moderator: archived row shows Відкотити/Видалити, pending shows Прийняти/Відхилити + link `/play/:id?draft=<sha>&returnTo=/admin/scenarios/:id/files`; author: Відкликати (DELETE). Current version has no delete.
VERDICT:  PASS (unit tests in scenario-files, archive-upload, admin-api specs, all green)

### DW-6.2
PREMISE:  Перевірка shows stored checks and test-run results with the norms and re-runs checks.
EVIDENCE: scenario-checks.component.ts (`rerun`, `rows`), scenario-rules.ts `evaluateTestRun`/`TEST_NORMS`, check-list.component.ts `summarizeChecks`.
TRACE:    stored version.checks -> verdict + items; testRun -> 4 rows vs <=5 s, >=30 FPS, <=1 GiB, 0 errors (limits inclusive, missing figure -> "—"/null); rerun -> api.runChecks(id, version.id) -> list updated, changed emitted; `runTest` output with inert button via `testEnabled`.
VERDICT:  PASS

### DW-6.3
PREMISE:  The wizard turns a ZIP into a draft with prefilled manifest fields, then saves or submits it; the size guard and the 409 message work.
EVIDENCE: upload-wizard.component.ts `send`/`finish`/`saveDraft`; archive-upload.ts `checkArchiveFile`, `describeUploadError`; backend 409 text "Сценарій на перевірці…" matches `/перевірці/`.
TRACE:    ZIP -> fromArchive -> draft/version/manifest signals -> meta form prefilled -> checks step -> transition submit -> navigate to /publish. File > maxBytes refused before any request. 409 in review -> server text + withdraw hint; 409 id taken -> server text shown, no draft.
VERDICT:  PASS

### DW-6.4
PREMISE:  e2e covers wizard -> submit and pending accept from the Файл tab; the old admin and `/admin/legacy` are gone.
EVIDENCE: e2e/tests/admin-upload-wizard.spec.ts, admin-files-tab.spec.ts (incl. legacy -> list), app.routes.spec.ts; legacy/* and _legacy.scss deleted; no `legacy` route in app.routes.ts; remaining "legacy" mentions are docs only.
TRACE:    e2e specs exist and type-check; unit `app.routes.spec` and `nocturne-styles.spec` pass (no legacy route/stylesheet).
VERDICT:  PASS for the unit-verifiable parts; the e2e specs were NOT executed (stack unavailable), so wizard->submit / pending-accept coverage rests on reading plus type-check. Not treated as a blocker: the dispatch states they cannot run here.

**All requirements met:** YES (e2e unexecuted, as stated)

## Edge cases
- restore keeps code on 5xx/network, drops on credential rejection: admin-session.service.ts `restore`; tests at admin-session.service.spec.ts:123-159. PASS.
- Stale responses (Публікація history, Файл, Перевірка) after id change: request counters + id checks in all three; tests present for each. PASS.
- Cancel aborts, nothing half-created: AdminApi.upload unsubscribes (cancels XHR) and rejects `UploadCancelled`; component shows notice, no `done`; destroy aborts. PASS.
- Leaving wizard after step 1 keeps draft: nothing deletes it; test "leaving after step 1 keeps the draft". PASS.
- 409 in review explains withdrawal; over-cap refused pre-upload: covered. PASS.
- `<script>` manifest name as text: wizard and check-list tests; no innerHTML/bypassSecurityTrust in sources (grep). PASS.
- No confirm-in-jsdom reliance: specs stub `confirm` with `vi.stubGlobal`. PASS.

## Test-DW Coverage
- [x] Every DW item has named tests (DW-6.x prefixes) that ran green.
- [x] 100% level: new/changed routines (checkArchiveFile, describeUploadError, summarizeChecks, topLevel, evaluateTestRun, restore/restoreProblem, upload/fromArchive, loadVersions, loadHistory, wizard methods) have unit tests; gaps: none found.

## Dead Code
None found.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | request counters and id checks traced for versions/history; checks `load` guarded by id; abort-after-complete is a no-op |
| Error Handling | PASS | upload errors surfaced, status 0 worded, cancel is not an error |
| Resources | PASS | abort listener removed in teardown; controller aborted on destroy |
| Boundaries | PASS | zero-byte, exact-cap, missing figures, 500-row listing cap handled |
| Security | PASS | text interpolation only; download href regex-validated; sha validated for preview; returnTo is relative /admin path |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-verifying-correctness | RC requirements mapped | PASS | above |
| aposd-verifying-correctness | CS TOCTOU/stale async | PASS | counters traced |
| aposd-verifying-correctness | EH no silent failure | PASS | every catch sets a visible error or is a deliberate cancel notice; `api.config()` failure falls back to null cap (server still enforces) |
| aposd-verifying-correctness | RM release on error paths | PASS | finally blocks reset uploading/busy |
| aposd-verifying-correctness | BC/SE | PASS | see dimensions |
| cc-defensive-programming | external input validated at entry | PASS | file name/size/count checked; server data only rendered as text |
| cc-defensive-programming | no empty catch | PASS | `.catch(() => maxBytes.set(null))` is a deliberate fallback, not empty |
| cc-defensive-programming | no side-effecting assertions | N/A | no assertions |

## Notes (non-blocking)
- ScenarioFilesComponent's contents effect depends on the `current()` object, so every versions refetch re-requests contents even if the current id is unchanged (extra request, not a wrong result).
- `uploaded()` in Файл emits `changed` without re-checking the scenario id (harmless).
- scenario-publish spec covers the id-change stale case but not the same-scenario newest-wins counter branch (files spec covers it for Файл).
- e2e specs unexecuted.

## Issues
None blocking.

**Verdict: PASS**
