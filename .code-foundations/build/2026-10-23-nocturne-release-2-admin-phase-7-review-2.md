# Review: Phase 7 - admin moderation UI (review 2)

## Executed Results (Step 0)
- Unit suite: `npx ng test --no-watch` (frontend/) -> 46 files, 712 tests passed, 0 failed.
- Build + CSP: `npm run build && npm run check:csp` -> built; "no import map, nonce or inline script; no bare engine import".
- e2e type-check: `tsc -p e2e/tsconfig.json --noEmit` -> only the two known base-commit errors (viewer.spec.ts 100/374).
- e2e: `playwright test admin-moderation` against localhost:8047 -> 3 passed (DW-7.6, DW-7.2, DW-7.3).
- Lint: none configured.

## Requirement Fulfillment

### DW-7.1
PREMISE: The queue lists submitted scenarios with their check summary; publish/return there update status and history.
EVIDENCE: queue.component.ts (pending/returned/cards computed, reviewChips, decide(), load()); scenario-rules.ts reviewChips.
TRACE: listScenarios + dashboard -> review/pending-version rows become cards with chips -> approve/reject calls transition/versionAction -> load() re-reads rows and journal -> card leaves, decision row appears.
VERDICT: PASS. Backed by queue spec DW-7.1 tests, reviewChips spec, and the e2e (card visible with chips, publish, card gone, decisions table shows "Опубліковано в каталозі").

### DW-7.2
PREMISE: The dashboard shows role-scoped counts and activity.
EVIDENCE: dashboard.component.ts (counters, activity, queue block gated on isModerator, actions by role); app.routes.ts '' route.
TRACE: GET /api/admin/dashboard (server-scoped) -> four status counters, activity sentences, moderator-only queue link and actions.
VERDICT: PASS. Dashboard spec DW-7.2 tests; e2e DW-7.2.

### DW-7.3
PREMISE: Categories can be added, reordered, hidden and (when empty) deleted from the UI.
EVIDENCE: categories.component.ts add/move/toggleVisible/remove/mutate (409 refetch).
TRACE: add posts and re-reads; move sends the full swapped order; 409 sets error and still refreshes; delete disabled when scenarioCount > 0 and guarded in remove().
VERDICT: PASS. Categories spec (add, reorder, conflict, hide, delete disabled/confirmed); e2e DW-7.3.

### DW-7.4
PREMISE: A moderator issues a key (token shown once), sees last use, and revokes it; the revoked key stops working.
EVIDENCE: access.component.ts issue/dismiss/copy/revoke; modal.component.ts (dismissible=false).
TRACE: createKey -> token only in `issued` signal, dialog closes only via buttons which clear it, destroy clears it; rows show lastUsed; revoke posts, own key -> session.signOut -> shell effect navigates to login.
VERDICT: PASS. Access spec (once-only, copy, own-key sign-out); e2e confirms token absent from body after close, last-use changes from "ще не використовувався", revoked token gets 403 on /api/auth/me.

### DW-7.5
PREMISE: A test run records time to first frame, average FPS, GPU memory and console errors with device and engine build.
EVIDENCE: test-run.component.ts run(); test-run-report.ts buildTestRunReport/buildFailedRunReport; scenario-checks.component.ts startTest/onTestFinished -> api.saveTestRun.
TRACE: fetch archive -> PlayerHost.measure(10) -> report clamped, strings truncated 100/300, non-finite figure -> error shape -> POST test-run -> stored run shown; host disposed on every path.
VERDICT: PASS. test-run-report spec, test-run spec, scenario-checks spec (500-char build -> 100, crashing fixture stores error, no numbers).

### DW-7.6
PREMISE: E2E: moderator issues an author key -> author uploads and submits -> moderator publishes -> in catalog -> author uploads new archive -> students still get the old one until the moderator accepts.
EVIDENCE: e2e/tests/admin-moderation.spec.ts:55-133.
TRACE: observed run: publicArchive null before publish, firstUrl after publish, unchanged after v2 upload, changed after accept; key revoked -> 403.
VERDICT: PASS (ran, 4.5 s).

**All requirements met:** YES

## Test-DW Coverage
- [x] Every DW has named tests that ran (spec names carry DW-7.x; e2e names DW-7.2/7.3/7.6).
- [x] 100% level: new routines (queue, dashboard, categories, access, test-run, modal, player-config, test-run-report, reviewChips, new API methods, shell nav, routes) each have specs; gaps: none found.

## Dead Code
None found (deleted admin-slot component and spec; no leftover references; build passes).

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | Queue load() guarded by request counter and busyId; categories/access use a busy flag; test-run uses `stopped` + AbortController. |
| Error Handling | PASS | Every API call caught and shown via describeError; clipboard failure has a fallback note; 409 triggers refetch. |
| Resources | PASS | Host disposed on finish, cancel, failure and destroy; modal restores focus. |
| Boundaries | PASS | Report clamps to server ranges, non-finite -> failure shape, text truncated 100/300/1000; slug/label validated before request. |
| Security | PASS | No innerHTML / bypassSecurityTrust in new code; engine imported only from `WebEngineTS/player-host`; token held only in a signal, dialog not dismissible by accident. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-verifying-correctness | Requirements coverage | PASS | DW-7.1 to 7.6 mapped above |
| aposd-verifying-correctness | Concurrency / errors / resources / boundaries / security | PASS | see table above |
| cc-defensive-programming | External input validated at entry (untrusted player metrics) | PASS | buildTestRunReport validates type/finite, clamps, truncates before posting |
| cc-defensive-programming | No empty catch / swallowed errors | PASS | catch blocks set error state, return, or give a user note |
| cc-defensive-programming | No side-effecting assertions | PASS | none used |

## Notes (non-blocking)
- onTestFinished keys the saved version by id captured at start, so a tab switch mid-run is safe; a moderator closing the Перевірка tab mid-run destroys the dialog and disposes the host (tested).
- The queue "Опрацьовані" count is bounded by however many journal rows the dashboard endpoint returns (server-side limit); not a requirement defect.
- Revoke of own key relies on the shell's auth effect to navigate to login; works in e2e/unit.

**Verdict: PASS**
