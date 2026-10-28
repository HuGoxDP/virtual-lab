# VERIFY discovery: nocturne-release-2-admin (HEAD 6146547)

Progress file. One section per failure. Status: TODO / DIAGNOSED / FIXED (code) / VERIFIED (e2e green).

## 1. admin-files-tab.spec.ts:134 (DW-6.2) - FIXED (spec), owning phase 6
Root cause: Phase 7 (decision #51) enabled the test run; the spec still asserted the Phase 6 inert button.
Fix: spec asserts `toBeEnabled()` (the run itself is exercised in admin-moderation.spec.ts).
Files: e2e/tests/admin-files-tab.spec.ts

## 2. admin-upload-wizard.spec.ts:55 (DW-6.3) - FIXED (product), owning phase 6
Root cause: step buttons are `<span class="num">2</span>Метадані`, so the accessible name was "2 Метадані"; the spec's
`name: 'Метадані', exact: true` never matched. The ordinal is decoration (the `<ol>` carries order), so the product was wrong
for assistive tech too (a screen reader read "2 Метадані" twice as digit + label).
Fix: `aria-hidden="true"` on `.num` -> name is the label alone. Unit test added in upload-wizard.component.spec.ts.
Files: frontend/src/app/pages/admin/upload-wizard/upload-wizard.component.ts (+ .spec.ts)

## 3. admin-workflow.spec.ts:67 (DW-5.1) - FIXED (spec), owning phase 5
Root cause: decision #47 - guard fallback is `/admin` (dashboard), author menu shows Огляд.
Fix: spec expects `/\/admin$/`.

## 4. admin-workflow.spec.ts:119 (DW-5.5 sign in) - FIXED (spec), owning phase 5
Root cause: sign-in lands on the dashboard (#47), not the list.
Fix: spec asserts the dashboard URL then opens «Мої сценарії» through the sidebar.
Files (3+4): e2e/tests/admin-workflow.spec.ts

## 5. admin-workflow.spec.ts 390px drawer (DW-5.5) - FIXED (product), owning phase 5
Root cause (diagnosed by measuring boxes at 390 px): the table sits in `.table-wrap {overflow-x:auto}` but the
`<span class="visually-hidden">Дії</span>` in the last `<th>` is `position:absolute` with no positioned ancestor, so its box
(x=682 in the 860 px table) escapes the wrapper's clip and sets the document scrollWidth to 682. Same latent defect in every
`.table-wrap` that has a visually-hidden header (access, categories, scenario-files, queue, list).
Fix: `position: relative` on every `.table-wrap`. Unit test (getComputedStyle) in scenario-list.component.spec.ts.
Files: frontend/src/app/pages/admin/{scenario-list,access,categories,queue,scenario-files}/*.component.scss

## 6. admin-workflow.spec.ts long title (DW-5.5) POST 500 - FIXED (product + spec + doc), owning phases 2 and 5
Root cause: scenarios.title VARCHAR(255); nothing validated width -> pg error -> 500.
Fix: `scenarioTextProblem` + `SCENARIO_TEXT_LIMITS` in backend/catalog-input.js (id 100, title 255, category 50,
categoryLabel 100, version 20, author 255, manifestUrl 300; type check, code-point counting), called in POST and PUT
/api/catalog -> 400 "<field>: не більше N символів". Tests: unit (catalog-input.test.js), integration
catalog-text-widths.test.js (width and width+1 per field, author and moderator, PUT, widths = real columns).
Spec: title becomes 255 chars. docs/test-plan.md line updated.

## 7. catalog-scenario-page.spec.ts:189 (r1 DW-3.4) - FIXED (spec), owning phase 3
Root cause: Phase 3 makes every new row a `draft` and the public by-id page serves only published rows; the spec created two
rows and opened them anonymously, so `.feature` was 0. Approving needs an archive, so a published row can no longer be archive-less.
Fix: spec uploads an archive and approves (`updateScenario isPublished: true`, the pattern in hostile-archive / ktx2-render).
The "no archive hides launch" clause is kept by intercepting the by-id response for the `bare` row (scenarioUrl '' / archiveBytes
null): the page decides from `scenarioUrl` alone.
Files: e2e/tests/catalog-scenario-page.spec.ts

## 8. catalog-scenario-page.spec.ts:244 (r1 DW-3.7) - FIXED (product), PREDATES this branch (release 1 / main)
Root cause (box measurement at 390 px): `.catalog-main` (margin: 0 auto in the column-flex :host) lost the default stretch and
shrink-wrapped to the chip row (619 px). Not a long title: the row titles are <= 54 chars. `main` fixed it in d8a3222
("stop the 390 px catalog scrolling sideways", after this branch's merge-base bf6d51a); the branch simply lacks that commit.
Fix: the identical one-line change (`width: 100%`, same comment) so the merge is a no-op; plus a unit test on this branch.
Files: frontend/src/app/pages/catalog/catalog.component.scss (+ .spec.ts)

## Final run (rebuilt stack vl-r2)
backend 1269/1269 (baseline 1237 + 32), frontend 715/715 (712 + 3), build + check:csp OK, e2e 114 passed / 19 skipped / 0 failed.
