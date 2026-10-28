# Discovery + Design: Phase 7 - Admin UI: moderation

## Progress (update as you go)
- [x] Discovery, design, DW mapping (this file)
- [x] player/: config + host factory token + test-run report builder (+spec)
- [x] ui/modal (+spec)
- [x] AdminApi typing fixes (category unwrap), rules: category/key events (+specs)
- [x] pages: queue, dashboard, categories, access, test-run dialog; checks wired; shell nav «Огляд»; routes; slot deleted
- [x] unit specs for all of the above
- [x] e2e (written + type-checked, NOT run)
- [x] docs (CLAUDE.md, Readme.md, code-standards client-side-filter exception, test-plan 224+, manual-browser-checks)
- [x] full frontend suite + build + check:csp

## Files Found
- Routes: `app.routes.ts` has `slot()` placeholders for queue/categories/access; `/admin` redirects to `scenarios`.
- `AdminApi` already has every route (dashboard, categories CRUD+reorder, keys, saveTestRun, versionAction, transition).
- `scenario-checks` has `testEnabled` input + `(runTest)` output (inert).
- Viewer owns PlayerHost integration (constants PLAYER_URL/ENGINE_URL/TRANSCODER_PATH, `createPlayerHost` seam).
- Shared: `_shared.scss` mixins, `describeEvent`, `readiness`, `evaluateTestRun`, `StatusPill`, `IconPicker`, `ToastService`, `settle()`.
- e2e helpers: `api.ts` (createKey, revokeKey, uploadArchive*, versionsOf, ...), `admin-ui.ts`, `zip.ts`.

## Gaps (plan vs reality)
1. `AdminApi.createCategory/updateCategory` are typed as returning a category but the server answers `{category}`; reorder answers `{categories}` (without `scenarioCount`). Fix typing (unwrap), refetch after mutations.
2. Prototype has no dashboard/Доступ screens in the outline (research says so for Доступ); designed from the research doc.
3. Admin rows carry `pendingVersionId` but not the pending version's sha, so a pending-proposal card links to the Файл tab (which has the draft preview) rather than a direct viewer link.
4. `journal` events for `category.*` / `key.*` have no wording in `describeEvent` -> added (dashboard activity shows them).
5. After the 3 slots are real, `AdminSlotComponent` is dead -> deleted with its spec.
6. Login and guard land on `/admin/scenarios`; Decision #34 says `/admin` becomes the dashboard. Left as is for login (existing e2e/specs rely on it); the nav gets «Огляд» (`/admin`, exact).

## Code Standards
Standalone + OnPush + zoneless signals, `// path:` header, Ukrainian UI / English code, no innerHTML/bypassSecurityTrust, no fakeAsync, `window.confirm` stubbed in specs.

## Test Infrastructure
Vitest via `ng test`; `HttpTestingController`; `settle(fixture)`; `adminRow/versionRow/auditRow` factories in `admin-testing.ts`.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-7.1 | Queue lists submitted scenarios with check summary; publish/return update status and history | COVERED | queue.component.spec (tabs, chips, publish, return with note, version accept/reject, recent decisions); rules spec (events) |
| DW-7.2 | Dashboard shows role-scoped counts and activity | COVERED | dashboard.component.spec (author vs moderator, activity wording, quick actions); shell spec («Огляд») |
| DW-7.3 | Categories add/reorder/hide/delete-when-empty | COVERED | categories.component.spec (add, validation, move up/down, hide, delete disabled when used, 409 reorder refetch) |
| DW-7.4 | Issue key (token once), last use, revoke; revoked key stops working | COVERED | access.component.spec (token dialog once/copy/closed gone, last use, revoke, own revoke -> signed out); e2e (revoked key rejected) |
| DW-7.5 | Test run records TTFF, FPS, GPU, errors with device + engine build | COVERED | test-run-report.spec (truncation 500->100, UA 300, clamp), test-run.component.spec (measure -> report, crash -> error), scenario-checks.component.spec (save + show) |
| DW-7.6 | E2E author -> moderator -> catalog -> new archive -> students keep old until accepted | COVERED (written, not run) | e2e/tests/admin-moderation.spec.ts |

**All items COVERED:** YES

## Design Decisions
- `vl-modal` (ui/modal): one accessible dialog primitive (role=dialog, aria-modal, focus in, Tab trap, Escape, focus restore) used by the token dialog and the test run.
- Test run: `player/` holds `PLAYER_URL/ENGINE_URL/TRANSCODER_PATH` (viewer imports them from there), an injection token `PLAYER_HOST_FACTORY` (default `new PlayerHost`) as the test seam, and `buildTestRunReport(metrics, userAgent)` / `buildFailedRunReport(message, ...)` which is the trust boundary: untrusted-realm numbers are clamped to the server's ranges (non-finite -> failure), strings truncated to 100/300/1000. `<vl-test-run>` downloads the version's ZIP, loads it in a PlayerHost, measures 10 s, disposes the host always (finally/destroy), emits `finished(report)`; the Перевірка tab saves it and shows it.
- Queue and dashboard read `AdminApi.listScenarios()` / `dashboard()`; filtering by tab is client-side (documented exception).
- Categories: reorder via move up/down buttons (keyboard accessible); every mutation refetches so `scenarioCount` stays right.
- Access: token held only in the dialog's signal; cleared on close/destroy; never written anywhere else. Own-key revoke -> `AdminSession.signOut()` after the server accepts.

## Prerequisites
- [x] Backend routes exist; no backend change needed.

## Recommendation
BUILD

## Outcome
All items done. Frontend 45 files / 704 tests green; `npm run build` and `npm run check:csp` green; e2e type-checks (only the 2 pre-existing viewer.spec errors).
Changes from the design: Doc test-plan numbers are 225-231 (224 was already used); login and the guards now land on `/admin` (the dashboard); `LARGE_ARCHIVE_BYTES` moved to `scenario-rules.ts` (re-exported by scenario-files); `testEnabled` defaults to true.
e2e run against the vl-r2 stack (:8047, built before this phase's UI): admin-files-tab and admin-upload-wizard pass except the wizard happy path (button lookup on the old build); admin-moderation fails there as expected (UI absent) - needs a rebuilt stack.
