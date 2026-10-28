# Review: nocturne-release-2-admin verification fixes (6146547..2d06b67)

## Executed Results (Step 0)
- Backend: `npm test` (DB virtual_lab_test) -> 1269 tests, 1269 pass, 0 fail, 0 skipped.
- Frontend unit: `npx ng test --no-watch` -> 715 passed (715).
- Build / CSP: `npm run build` ok; `npm run check:csp` -> "built app matches the CSP".
- e2e type-check: only the two known `viewer.spec.ts` (100, 374) errors.
- e2e targeted (admin-workflow admin-files-tab admin-upload-wizard catalog-scenario-page): 41 passed.
- e2e full suite: 114 passed, 19 skipped (editor-csp, ktx2, streaming, viewer-player `?stream=1` - environment-gated skips, none in the changed specs), 0 failed.
- Lint: none configured.
- Extra probes (ad hoc Playwright script outside the repo, scenario with 255-char title/author, 100-char category label, 600/900-char descriptions, 60/90-char feature, 100-char key label): at 390 px no horizontal overflow (documentElement/body scrollWidth == clientWidth == 390) on /catalog, /scenario/:id, /admin, /admin/scenarios, /admin/queue, /admin/upload, /admin/categories, /admin/access and the scenario tabs meta/files/checks/publish/publication/history. Live POST /api/catalog with a 256-char title -> 400 `title: не більше 255 символів`. The probe's scenario and keys were removed/revoked afterwards.

## Requirement Fulfillment

### R-1
PREMISE: POST and PUT /api/catalog refuse every width-limited text field longer than its column with a 400 and a Ukrainian message, never a 500; exact width accepted; authorization rules and audit rows unchanged.
EVIDENCE: backend/catalog-input.js:126-160 (SCENARIO_TEXT_LIMITS, exceedsWidth, scenarioTextProblem); backend/routes/catalog-admin.js:91-92 (POST), :163-164 (PUT). Widths verified: id 100, title 255, category 50, category_label 100, version 20, author 255 (db/init.sql:9-18), manifest_url 300 (migration 005:17). Integration test 181 also asserts declared widths equal information_schema widths.
TRACE: title 'Ж'x256 -> scenarioTextProblem -> exceedsWidth (code points) -> 400 `title: не більше 255 символів`, before the transaction, so no row and no audit row; 255 -> 201 (tested, also 255 emoji = 510 UTF-16 units accepted). Non-string / null title -> 400 (previously a NOT NULL 500). PUT passes `id: undefined` so the URL id is not validated as a body field. Author forbidden-field check still runs first (routes :80-83, :154-157); ownership 403/404 and the audit.record calls inside inTransaction untouched; existing suite for those (scenario 181/182) passes.
VERDICT: PASS

### R-2
PREMISE: no admin page (list, queue, Файл tab, Доступ, Напрями) and not the public catalog scroll sideways at 390 px; author-supplied text never breaks layout.
EVIDENCE: `position: relative` on `.table-wrap` in scenario-list, queue, scenario-files, access, categories scss (visually-hidden header cells escaped the overflow clip); catalog.component.scss `.catalog-main { width: 100% }`. Unit specs: scenario-list.component.spec.ts (table-wrap positioned), catalog.component.spec.ts (width 100%).
TRACE: 390 px viewport, long author text -> every page listed above measured scrollWidth == clientWidth == 390 (probe) and the e2e 390 px specs pass.
VERDICT: PASS (see Notes: queue, scenario-files, access, categories have no unit assertion of the new rule, only the list does; e2e/probe cover behaviour).

### R-3
PREMISE: wizard step buttons have accessible names equal to visible labels.
EVIDENCE: upload-wizard.component.ts:56 `<span class="num" aria-hidden="true">`; unit test "DW-6.3 a step button is named by its label alone" (passes).
TRACE: button content = aria-hidden ordinal + label text -> accessible name is the label only (e.g. «Метадані»). Wizard e2e (selects by role/name) passes against the served build.
VERDICT: PASS

### R-4
PREMISE: each changed e2e spec still asserts its original requirement; no assertion removed or loosened beyond the behaviour change.
EVIDENCE: admin-files-tab.spec.ts:150-155 (DW-6.2: Перевірка tab flow, stored checks, re-run toast and norms assertions all retained; only `toBeDisabled` -> `toBeEnabled`). admin-workflow.spec.ts: DW-5.1 author-menu assertions retained, redirect expectation `/admin/scenarios` -> `/admin$` (dashboard by design); DW-5.5 adds `toHaveURL(/\/admin$/)` and `openSection('Мої сценарії')` then the original edit/submit steps; 390 px drawer test untouched; long-title test now 255 chars for title and author, both list and editor `pageOverflows` assertions and the h1 equals-title assertion retained. catalog-scenario-page.spec.ts DW-3.4: features count/text/subtitle assertions retained, no-archive assertions (`.launch, .launch-bar, .download` count 0, no "Розмір архіву", no "Що всередині") retained; rows are now uploaded and published first (drafts by design) and "no archive" is staged by a route mock that blanks `scenarioUrl`/`archiveBytes`; DW-3.7 specs unchanged and pass.
TRACE: all four changed specs pass (41/41).
VERDICT: PASS

### R-5
PREMISE: backend, frontend unit, build/CSP and full e2e green.
EVIDENCE: see Executed Results.
VERDICT: PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] Every requirement has an executed automated test (backend integration `catalog-text-widths.test.js`, unit `catalog-input.test.js`, frontend specs, e2e).
- [x] 100% level: new routines `scenarioTextProblem` (unit + integration) and `exceedsWidth` (exercised through `scenarioTextProblem` with 255/256 emoji and over-width inputs; no direct test, covered by branch via the public routine). No new component routines were added (CSS/template attribute changes only; each has a spec except the CSS rules noted below). Gaps: none that is a new or changed routine.

## Dead Code
None found.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Validation is pure and runs before the transaction; existing `FOR UPDATE` path unchanged. |
| Error Handling | PASS | Over-width, non-string and null-on-NOT-NULL inputs now return 400 before any DB call (traced and tested); catch blocks unchanged. |
| Resources | N/A | No resources acquired. |
| Boundaries | PASS | 0/exact/+1 widths tested per field; code points vs UTF-16 handled (`exceedsWidth` shortcut `length > max*2` is valid since a code point is at most 2 units). |
| Security | PASS | Untrusted body validated at the handler entry; no new SQL concatenation; authorization and forbidden-field checks precede validation for authors. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry | PASS | scenarioTextProblem at both handlers, before DB. |
| cc-defensive-programming | No empty catch / no side-effecting assertions | PASS | none added. |
| cc-defensive-programming | Assertions only for bugs | N/A | no assertions added. |
| aposd-verifying-correctness | RC requirements mapped to code | PASS | R-1..R-5 above. |
| aposd-verifying-correctness | EH-1..5 failure points handled, no silent continue | PASS | 400 with message; no swallowed errors. |
| aposd-verifying-correctness | BC-1..5 empty/max/invalid | PASS | undefined skipped, null only for nullable, non-string refused, exact width and +1 tested. |
| aposd-verifying-correctness | SE-1, SE-5 validate / authz before action | PASS | authz and forbidden fields first for authors; validation before write. |

## Notes (non-blocking)
- On PUT, text validation runs before the ownership check, so an unauthorised author sending an over-long title gets 400 rather than 403/404. Valid requests are unchanged; only invalid input from a stranger sees a different code. No data leak.
- In the PUT the `category` slug of a moderator is covered by the 50 limit (tested, 51 -> 400). `description`/`fullDescription` are TEXT (unlimited), correctly unlisted. Postgres rejects NUL characters in text; not in scope and not changed.
- Only scenario-list has a unit assertion for the `position: relative` fix; queue/scenario-files/access/categories rely on e2e and the 390 px probe (all pass).
- catalog-scenario-page "no archive" is now staged with a route mock because a published row always has an archive; the assertion list is unchanged but the page is tested against a synthetic payload. The spec title still says "related", asserted nowhere in the body (pre-existing).
- The test-plan says scenario 215/216 "Not run"; they now run and pass (doc not updated; not a requirement).

## Issues (if FAIL)
None.

**Verdict: PASS**
