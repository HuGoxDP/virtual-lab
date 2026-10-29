# Review: Phase 6 - Файл, Перевірка, wizard, legacy removal

## Executed Results (Step 0)
- `npx ng test --no-watch` (frontend/): 39 files, 593 tests passed, 0 failed.
- `npm run build && npm run check:csp`: build exit 0; CSP check passed.
- e2e type-check (`tsc -p e2e/tsconfig.json --noEmit`): only the two known base-commit errors in `e2e/tests/viewer.spec.ts` (100, 374).
- Lint: none configured.
- NOT executed: the e2e specs (need a docker stack); they were read and type-checked only.

## Requirement Fulfillment

### DW-6.1
PREMISE: Файл replaces the archive with progress and cancel, shows versions with role-appropriate restore/delete, and the pending banner with its preview link and actions.
EVIDENCE: archive-upload.component.ts:112-153 (progress, AbortController, cancel); scenario-files.component.ts:61-98 (pending banner, `/play/:id?draft=<sha>&returnTo=`, accept/reject for a moderator, retract for an author), :148-163 (`canRestore`/`canDelete`: moderator + archived only), :119-124 (50 MB warning).
TRACE: author uploads to a published scenario, the server returns state `pending`, the banner shows with a retract button (DELETE). A moderator sees accept/reject and restore/delete on archived rows only. Cancel aborts the XHR and rejects with UploadCancelled, so no error is shown and `done` does not fire.
VERDICT: PASS. Backed by the DW-6.1 tests in scenario-files and archive-upload specs, all green.

### DW-6.2
PREMISE: Перевірка shows stored checks and test-run results with the norms and re-runs checks.
EVIDENCE: scenario-checks.component.ts (rerun, rows via `evaluateTestRun`); scenario-rules.ts:110-157 (TEST_NORMS: 5000 ms, 30 fps, 1 GiB, 0 errors; limits inclusive); check-list.component.ts.
TRACE: stored `testRun` → `evaluateTestRun` → four rows each with a norm and an ok flag; "Перевірити ще раз" POSTs `/versions/:vid/checks` and patches the stored checks; the `runTest` output is inert unless `testEnabled`.
VERDICT: PASS. Backed by the DW-6.2 tests in the checks, check-list and scenario-rules specs.

### DW-6.3
PREMISE: The wizard turns a ZIP into a draft with prefilled manifest fields, then saves or submits it; the size guard and the 409 message work.
EVIDENCE: upload-wizard.component.ts:150-160 (`send` → `fromArchive` → draft), :199-245 (save/finish); archive-upload.ts:14-41 (`checkArchiveFile`, `describeUploadError`).
TRACE: a ZIP over `maxArchiveBytes` is refused before any request. A 409 in review gets the server text plus the withdrawal hint. A 409 for a taken id is shown verbatim and no draft appears. Submit POSTs `submit` and navigates to the Публікація tab.
VERDICT: PASS. Backed by the DW-6.3 tests in the wizard and archive-upload specs.

### DW-6.4
PREMISE: e2e covers wizard → submit and pending accept from the Файл tab; the old admin and `/admin/legacy` are gone.
EVIDENCE: e2e/tests/admin-upload-wizard.spec.ts:55, e2e/tests/admin-files-tab.spec.ts:78 and :166; app.routes.ts (legacy route removed); `pages/admin/legacy/` is absent; app.routes.spec.ts has 3 DW-6.4 tests.
TRACE: `/admin/legacy` hits the admin child wildcard and redirects to the list; no component or route references the legacy screen.
VERDICT: PASS for the unit side (executed). The e2e specs exist and type-check but were not run.

**All requirements met:** YES, with the unexecuted-e2e caveat.

## Test-DW Coverage
- [x] Every DW item has a named, executed test (the e2e ones were read only).
- [ ] Coverage level 100%: the new and changed routines have unit tests, EXCEPT the stale-response handling in `ScenarioPublishComponent.loadHistory` (see Issues, #1).

## Dead Code
None found.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | FAIL | scenario-publish.component.ts:212-218: `loadHistory` has no id check (Issue 1). The Файл and Перевірка tabs do guard, each with a stale-response test. |
| Error Handling | PASS | `AdminSession.restore` keeps the code on a transient failure (tests at admin-session.service.spec.ts:123-149). Upload errors go through `describeUploadError`. |
| Resources | PASS | AbortController is aborted on cancel and on destroy; `finally` resets `uploading`. |
| Boundaries | PASS | Size check is inclusive at the cap (tested); empty file and non-ZIP are refused; the 500-entry listing is capped. |
| Security | PASS | No `innerHTML` or `bypassSecurityTrust*` in non-spec code. Download URL is restricted to `/scenarios/<sha>.zip`, `previewable` requires a 64-hex sha, and `returnTo` is a relative `/admin/...` path. Hostile text is tested as rendered text. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-verifying-correctness | CS-3 (stale async response / TOCTOU) | FAIL | `loadHistory` awaits `api.history(this.scenario().id)` then writes `history`/`historyError` without re-checking the id. |
| aposd-verifying-correctness | EH-1..5, RM-1..4, BC-1..4, SE-1..5 | PASS | As in the dimensions table. |
| cc-defensive-programming | External input validated at entry | PASS | File name, size and count are validated before upload; archive-derived strings are only interpolated. |
| cc-defensive-programming | No empty catch | PASS | `config()` catch sets `maxBytes` to null, which is intentional (the server stays the authority). |

## Notes (non-blocking)
- In-app impact of Issue 1 is mitigated: `ScenarioEdit` sets `scenario` to null on an id change, which destroys and recreates the child. The defect is real at component level and the edge case names it explicitly.
- `scenario-files` `loadVersions` and the `uploaded()` refetch for the same id have no ordering guard (same-id races; unlisted).
- `versionsError` in scenario-files is not cleared on a scenario change until the next successful load (minor).
- Tests cover the 409 hint and the cap refusal in the unit specs; the e2e files were only type-checked.

## Issues
1. The Публікація history does not ignore a stale response after the scenario id changes (a listed edge case).
   - File: frontend/src/app/pages/admin/scenario-publish/scenario-publish.component.ts:212-218. The file is unchanged by this phase and no test exists.
   - Demonstrated by TRACE: the history for A is in flight; `scenario` is set to B (which issues B's history); A's slower response resolves and `history.set(A rows)` overwrites B's journal. `historyError` is clobbered the same way. The existing test ("another scenario reloads the history") never flushes a late response.
   - Fix: capture `const id = this.scenario().id` in `loadHistory` and return before `set` if `id !== this.scenario().id` (in both try and catch). Add a late-flush test like the one in scenario-files.component.spec.ts:366.

**Verdict: FAIL.** Sole blocker: the stale-response guard on the Публікація history. DW-6.1 to DW-6.4 are otherwise satisfied.
