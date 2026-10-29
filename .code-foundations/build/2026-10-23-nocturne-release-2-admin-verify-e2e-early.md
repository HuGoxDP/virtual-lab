# Early e2e run (before Phase 7 finished) — 2026-10-28

Stack: `vl-r2` (compose project) built from the worktree at HEAD d6d656f **plus uncommitted partial
Phase 7 work**, on http://localhost:8047 (override: `C:/Users/HuGox/vl-r2/override.yml`, `.env` copied
from the main checkout). Catalog filled by `publish:release --release <ScenarioCreator>/ReleaseScenarios`
(upload → approve worked for every catalog scenario; 5 Benchscene1 variants lack catalog-metadata —
not this branch's concern).

Run command (from `e2e/`):
`set -a && . ../.env && set +a && E2E_SMALL_ARCHIVE=C:/Users/HuGox/WebstormProjects/WebEngine/ScenarioCreator/ReleaseScenarios/test/Benchscene1_N100.zip E2E_BASE_URL=http://localhost:8047 npx playwright test`
(`E2E_SMALL_ARCHIVE` is needed in the worktree: `helpers/api.ts` resolves ScenarioCreator relative to
the repo, which is two levels deeper here; `Benchscene1_primitives.zip` no longer exists in the release.)

Full suite: 130 tests — 96 passed, 19 skipped, 4 did not run, 11 failed; 6 of the 11 were the archive
path above. Re-run of the admin/catalog/draft specs with the override: 45 passed, **5 failed**:

1. `admin-upload-wizard.spec.ts:55` DW-6.3 — after step 1, `getByRole('button', {name: 'Метадані', exact: true})`
   never appears (90 s timeout at line 65). Phase 6.
2. `admin-workflow.spec.ts:198` DW-5.5 — at 390 px the admin list widens the page (`pageOverflows` true, line 205). Phase 5.
3. `admin-workflow.spec.ts:220` DW-5.5 — `POST /api/catalog` with a 300-char title → **500** "Помилка сервера"
   (`scenarios.title` is VARCHAR(255); the backend does not validate title length → unhandled DB error).
   Backend (Phase 2/4 input validation) + the spec's 300-char premise vs the 255 column.
4. `catalog-scenario-page.spec.ts:189` DW-3.4 (release 1) — `.feature` count 0, expected 2 (line 201).
   Likely the spec's created row is now a `draft` (Phase 3: every new row starts as draft) and never approved.
5. `catalog-scenario-page.spec.ts:244` DW-3.7 (release 1) — the catalog scrolls sideways at 390×844 (line 247).
   Unknown cause; possibly a leftover/long-title row or a layout change.

Playwright error contexts: `e2e/test-results/*/error-context.md` (gitignored, overwritten by the next run).
