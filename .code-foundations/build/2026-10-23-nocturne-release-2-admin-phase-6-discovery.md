# Discovery + Design: Phase 6 - Admin UI: files, checks and upload wizard

## Progress (update as you go)
- [x] Discovery, design, DW mapping (this file)
- [x] Services: AdminApi upload (progress + abort, memoised config, typed from-archive), AdminSession.restore keeps code on transient failure, AdminService legacy CRUD removed
- [x] Rules (+spec): test-run norms in scenario-rules.ts
- [x] ui/shared pieces: archive-upload (dropzone+progress+cancel), check-list
- [x] pages: scenario-files, scenario-checks, upload-wizard; edit page wired; routes
- [x] legacy admin deleted (component, route, nav link, styles spec, e2e)
- [x] unit tests (done so far: admin-api, admin-session, admin-login, scenario-rules, admin.service specs updated)
- [x] e2e (written + type-checked, NOT run)
- [x] docs (test-plan 217+, manual-browser-checks, CLAUDE.md legacy lines)
- [x] full frontend suite + build + check:csp

## Files Found
- Phase 5 admin: `pages/admin/{scenario-edit,scenario-meta-form,scenario-publish,scenario-list,admin-shell}`, `scenario-rules.ts`, `_shared.scss`, `admin-testing.ts`, `admin-guards.ts`.
- Services: `admin-api.service.ts` (typed routes; `uploadArchive` delegates to `AdminService.uploadArchive`, no abort), `admin.service.ts` (token + legacy CRUD + `uploadArchive` + `describeError`), `admin-session.service.ts`.
- Legacy: `pages/admin/legacy/*` (component+html+scss+spec), route `admin/legacy`, shell nav link «Старий інтерфейс», `styles/nocturne-styles.spec.ts` DW-2.6 block, `styles/_legacy.scss` (`app-admin` host + `.legacy-admin` scope), e2e `admin-golden-path.spec.ts`, `nocturne-foundation.spec.ts` (DW-2.6 e2e), `admin-workflow.spec.ts` (two legacy tests), CLAUDE.md l.194/202, docs.
- Backend contract read: archives.js (409 review message, from-archive shape), versions.js (accept/reject/restore moderator; DELETE: current 409, archived moderator only, pending owner or moderator), version-tools.js, archive-checks.js (`{ok, items:{level,label,note}}`), test-run-input.js.

## Gaps (plan vs reality)
1. `AdminApi.fromArchive` is typed `ArchiveUploadResult & {id}`; real body is `{scenario, version, manifest, warnings}` -> new `FromArchiveResult` type.
2. `AdminApi.uploadArchive` cannot abort -> replaced by an observable-based upload that unsubscribes (cancels the XHR) on an `AbortSignal`.
3. `AdminSession.restore()` drops the code on any failure, including 5xx/network (Phase 5 review note) -> keeps it, reports `restoreProblem`.
4. "/admin/legacy -> not found": admin children `**` redirects to the list (Phase 5 design). Kept; the e2e asserts the old screen is gone and the URL lands on the list.
5. The checks stored on a version carry no timestamp/duration (backend), so «Остання перевірка…» is not shown; only items, and the test run's own `ranAt`/`ranBy`.
6. `styles/` is outside the file scope but the plan's file hints name `nocturne-styles.spec.ts`; the legacy block of the spec and the dead legacy rules in `_legacy.scss` go with the legacy admin (minimal edit).
7. `/admin/legacy` removal leaves AdminService CRUD (`listScenarios/createScenario/updateScenario/deleteScenario`, `ScenarioDraft`) without callers -> removed with its spec cases.

## Code Standards
Angular standalone + OnPush + zoneless signals, `// path:` header, UI Ukrainian / code English, no `innerHTML`/`bypassSecurityTrust*`, no `fakeAsync`; `window.confirm` stubbed in specs that reach it.

## Test Infrastructure
Vitest via `ng test`; `HttpTestingController`; `settle(fixture)` from `admin-testing.ts`; real router via `RouterTestingHarness` where navigation matters.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-6.1 | Файл: replace with progress+cancel, versions with role-appropriate restore/delete, pending banner with preview link and actions | COVERED | scenario-files.component.spec, archive-upload.component.spec, admin-api.service.spec (upload progress/abort) |
| DW-6.2 | Перевірка: stored checks + test-run vs norms, re-run | COVERED | scenario-checks.component.spec, scenario-rules.spec (evaluateTestRun) |
| DW-6.3 | Wizard: ZIP -> draft with prefilled manifest, save/submit, size guard, 409 message | COVERED | upload-wizard.component.spec, archive-upload.component.spec |
| DW-6.4 | e2e wizard -> submit, pending accept from Файл; old admin and /admin/legacy gone | COVERED | e2e/tests/admin-upload-wizard.spec.ts, admin-files-tab.spec.ts (unrun); unit: app.routes legacy absent, no legacy files |

**All items COVERED:** YES

## Design Decisions
- One deep module `vl-archive-upload` (drop zone, file input, client guards, progress, cancel, error text) used by both Файл and the wizard; callers give it a `send(file, onProgress, signal)` closure and a `maxBytes`. Cancel = AbortController; destroy also aborts, so leaving mid-upload leaves no half-created scenario.
- Client guards before upload: not `.zip`, empty, `> maxArchiveBytes` (from memoised `GET /api/config`); the server stays the authority.
- Upload errors via pure `describeUploadError`: 409 mentioning review adds the withdraw hint; cancel is silent.
- Файл: one pending version (backend invariant); its banner carries the actions (moderator accept/reject, author retract = DELETE). Table rows: restore (moderator, archived), delete (moderator archived; author none; pending handled in banner).
- Перевірка: shows the current version, or a segmented choice current/pending when a pending exists; `(runTest)` output + `testEnabled` input (default false) so the button is visibly inert until Phase 7.
- Wizard keeps the draft: leaving after step 1 deletes nothing. Replace in step 1 after the draft exists uses the per-scenario archive route.
- Test-run norms live in `scenario-rules.ts` (`TEST_NORMS`, `evaluateTestRun`).
- Archive paths, manifest fields, check notes, user agent: interpolation only.

## Prerequisites
- [x] Backend routes exist (read)
- [x] Phase 5 components reusable (`vl-scenario-meta-form`, status pill, shared scss)

## Recommendation
BUILD

## Outcome
All items done. Frontend 39 files / 593 tests green; `npm run build` and `npm run check:csp` green; e2e type-checks (only the 2 pre-existing viewer.spec errors); e2e NOT run.
Changed from the design above: `AdminApi.config()` is NOT memoised (it broke Phase 5 specs that open the form twice per test; each screen asks once).
`/admin/legacy` lands on the list (admin `**` redirect). `styles/_legacy.scss` deleted with its `@use` (dead without the old admin).
