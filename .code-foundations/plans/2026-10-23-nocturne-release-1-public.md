# Plan: Release 1 — the public site on Nocturne
**Created:** 2026-10-23
**Status:** complete
**Started:** 2026-10-23 12:00
**Completed:** 2026-10-26 10:45
**Duration:** ~3 days wall clock (interrupted by session limits and a branch switch)
**Current Phase:** 5
**Complexity:** complex
**Review cadence:** 2
**Check-ins:** checkpoints
---
## Context
The catalog, the scenario details and the viewer do not look like the chosen Nocturne design and lack what
the clickable prototype shows: a scenario page instead of a modal, real counters, category icons and order,
"Що всередині", related scenarios, an in-scene HUD with FPS and pause. This plan is **release 1 of 2**
(public part only); release 2 — new admin, roles, isolation — is
`.code-foundations/plans/2026-10-23-nocturne-release-2-admin.md`.

Requirements and every decision behind them:
`.code-foundations/research/2026-10-23-nocturne-redesign.md` (sections "Релиз 1", "Дизайн-система",
"Тексты, которые нельзя переносить как есть", "Решения по бывшим открытым вопросам").

Design sources (outside the repo): `C:\Users\HuGox\WebstormProjects\WebEngine\Design\Віртуальна лабораторія -
сайт (offline).html` is the source of truth; `Virtual Lab - мокапи (offline).html` screens 2a–2d add detail.
An unpacked copy lives in `C:\Users\HuGox\vl-design-extract\`: `vl-design-site/skeleton.html` (markup of every
screen), `part01.style.txt` (Nocturne tokens + component classes), `part03.style.txt` (`vl-*` keyframes),
`part04.script.txt` (prototype logic and data), `template.html` (the Inter `@font-face` rules with their
`unicode-range`s, pointing at the hash-named `*.woff2` beside it), `11bfb130-5a60-4760-8f66-0b4fe5eae25d.png`
(KSU logo); `vl-design-mockups/text-outline.txt` (all mockups as text).

**Success criteria:** catalog, scenario page and viewer match the prototype at wide and narrow widths; every
number shown is real; `/scenario/:id` replaces the modal; pause on Space works (delivered through player-isolation Phase 5) and restores the previous
`Time.timeScale`, and no scenario inherits another's time scale; empty blocks are hidden, never broken;
backend, frontend and e2e suites are green and updated.

## Constraints
- Prototype wins over the mockups; dark theme only — the light/dark toggle is removed.
- Inter (400/500, Cyrillic + Latin) and ~40 Phosphor icons are self-hosted; **`nginx/csp.conf` does not change**.
- Filtering, search, paging **and sorting** stay server-side (`docs/code-standards.md` § Forbidden Patterns).
- Zoneless + signals + OnPush; engine imported only `from 'WebEngineTS'`; schema only via
  `backend/migrations/NNN_*.sql`; UI strings Ukrainian, code and comments English.
- Unity, Google Drive and "proxy" wording from the mockups is never shipped; numbers ("60 FPS",
  "5 освітніх напрямів") are computed.
- The current `/admin` keeps working; its only functional addition is a "Що всередині" field.
- Site texts (department — full name from the prototype footer, address, `vlab@ksu.ks.ua`, logo) live in one
  config file; the owner verifies them before deploy.
- Migration `006` is taken here; release 2 numbers from `007`. `006` includes `categories.is_visible`
  (always true in release 1) so release 2 adds no column for it.
- An engine shortcoming found on the way is registered before the host-side workaround lands: the shared
  `ENGINE-GAPS.md` row first, then the full entry in `docs/upstream/webenginets.md`. G5 (time scale) was
  registered in the shared index at planning (2026-10-23, uncommitted in `.claude-shared`); Phase 4 writes its entry.

## Chosen Approach
**Global Nocturne stylesheet + a few shared components** — tokens and component classes are ported 1:1 into
`src/styles/`, Angular components exist only for repeated pieces (header, footer, scenario card, icon, toast);
Nocturne is plain CSS by design, so it stays retunable in one file. The old `/admin` already defines `.btn`,
`.btn-primary`, `.btn-ghost` and `.tag` in its own SCSS, so Phase 2 wraps it in a `legacy-admin` scope that
neutralises the global component classes until release 2 deletes it. **Fallback:** if neutralising leaks,
prefix the Nocturne component classes for release 1 only (`.n-btn` …) and drop the prefix in release 2.

## Rejected Approaches
- **Full Angular component library (`vl-button`, `vl-input`, …):** wrappers around CSS classes, with no second consumer to justify them.
- **Port the prototype markup with inline styles:** fast, but every later design change becomes a search through hundreds of `style=""`.

---
## Implementation Phases

### Phase 1: Catalog data and API
**Model:** sonnet
**Skills:** cc-defensive-programming, aposd-designing-deep-modules
**Gate:** Standard

**Goal:** Give the public API everything the new catalog and scenario page show — categories with icon and
order, "Що всередині", size and update date, server-side sort, related scenarios, the archive limit.

**Scope:**
- IN: migration `006`; `/api/catalog`, `/api/catalog/:id`, new `GET /api/config`; `features` on admin
  POST/PUT and `GET /api/admin/scenarios`; `MAX_ARCHIVE_BYTES` default 200 MiB with a proper 413; tests and
  the assertions this changes (`test/integration/catalog.test.js:56`, `docs/test-plan.md` §4.1 #2, #4);
  endpoint and limit docs in `CLAUDE.md` and `Readme.md`.
- OUT: category CRUD, statuses, previews (release 2); any frontend.

**Constraints:** `categories(slug PK, label, icon, sort_order, is_visible DEFAULT true, created_at)`;
seeded from distinct `scenarios.category` with `sort_order` = label order × 10; a later upsert appends at
max + 10. `categories.label` is canonical in every response (`COALESCE` with the row's `category_label`);
a POST/PUT with an unknown slug inserts the category from `categoryLabel`, a known slug keeps its label
(`ON CONFLICT DO NOTHING`; with no `categoryLabel` the slug is the label). Category `count` = published
scenarios in it, independent of `category`/`q`; `categories` lists only visible categories with `count ≥ 1`
(today's behaviour, and the same set `summary.categories` counts).
**Edge cases:** `sort` missing/unknown/array → `new`; a slug with no category row still lists its scenarios
(no chip); stored `features` that is not an array reads as `[]`; features: >6 items, icon not
`^[a-z0-9-]{1,40}$`, title 1–60, subtitle ≤90 → 400 Ukrainian; an oversize upload → multer's
`LIMIT_FILE_SIZE` mapped to 413 with a Ukrainian message, temp file released (today it escapes the route's
`try` and becomes a 500).
**Depends on:** none | **Unlocks:** Phase 3
**File scope:** `backend/**`, `docs/test-plan.md`, `CLAUDE.md`, `Readme.md`
**Produces:** `GET /api/catalog?category&q&sort=new|title&limit&offset` →
`{version, scenarios: Item[], categories: {category, categoryLabel, icon, count}[] (visible, by sort_order),
summary: {scenarios, categories} (published, unfiltered; categories = those with ≥1), total, limit, offset}`;
`Item` = current fields + `archiveBytes: number|null`, `updatedAt: string`,
`features: {icon, title, subtitle}[]`; `GET /api/catalog/:id` → `Item & {related: {id, title, category,
categoryLabel, imageUrl}[]}` (≤2, same category first, never itself, published only);
`GET /api/config` → `{maxArchiveBytes: number}`.
**Security-sensitive:** yes — public `sort`/`q`/`limit` reach SQL; admin-supplied JSON; upload size handling.
**Rollback:** migration `006` is additive; rolling back = redeploying the previous build (the new table and
column are ignored); the archive limit reverts through `MAX_ARCHIVE_BYTES` in `.env`.

**Approach notes:** Seeded icons follow the prototype (`part04.script.txt` `catIcons`) and must be in Phase 2's
icon set: physics `lightning`, biology `dna`, chemistry `flask`, history `bank`, astronomy `planet`; test
`cube`; any other slug `folder`.
**File hints:** `backend/server.js:129` (catalog), `:199` (admin list), `:232` (by id), `:258`/`:298`
(POST/PUT), `:97` + `:382` (limit, read once at load — tests set the env before `require`);
`backend/test/helpers/db.js` (`truncateAll` must include `categories`); `backend/migrations/003_scenario_sessions.sql` (header style).

**Done when:**
- [ ] DW-1.1: Migration `006` applies twice without error; seeds a category per distinct `scenarios.category`
  with the icons above and `sort_order` by label; `scenarios.features` defaults to `[]`.
- [ ] DW-1.2: `/api/catalog` returns `archiveBytes`, `updatedAt`, `features` per item, categories with
  `icon` + `count` in `sort_order`, and an unfiltered `summary`.
- [ ] DW-1.3: `sort=title` orders Ukrainian titles alphabetically (і, ї, є, ґ in place); `sort=new` keeps
  today's order; invalid `sort` falls back to `new`; paging stays stable under both.
- [ ] DW-1.4: `/api/catalog/:id` returns `related` per the contract; unpublished id → 404.
- [ ] DW-1.5: `/api/config` returns 209715200 by default and honours `MAX_ARCHIVE_BYTES`; a larger upload → 413, no temp file left.
- [ ] DW-1.6: Admin POST/PUT store valid `features` and reject each invalid shape with 400; an unknown slug
  creates its category row; a known slug keeps its label.
- [ ] DW-1.7: New integration tests cover DW-1.1–1.6; changed assertions updated; the whole backend suite is green.

**Difficulty:** MEDIUM
**Uncertainty:** Ukrainian ICU collation in `postgres:16-alpine` (see Assumptions).

### Phase 2: Nocturne foundation
**Model:** sonnet
**Skills:** aposd-designing-deep-modules
**Gate:** Standard

**Goal:** Put the Nocturne design system and the pieces every page repeats into the app, so the pages in
Phases 3–4 (and release 2's admin) are composed from classes and a handful of components.

**Scope:**
- IN: tokens + component classes ported 1:1 from `part01.style.txt` plus the `vl-*` keyframes; Inter
  400/500 (Cyrillic, Cyrillic-ext, Latin `@font-face` rules from `template.html`, files renamed); a Phosphor
  icon subset; `site.config.ts` with every site text and the KSU logo; shared components and format helpers;
  the `legacy-admin` scope around the old admin (Chosen Approach).
- OUT: rebuilding any page (Phases 3–4).

**Constraints:** the icon subset is generated, not hand-copied: `@phosphor-icons/core` (MIT, regular weight)
as a devDependency, `frontend/scripts/build-icons.mjs` reading `ICON_NAMES` and writing a committed
`icon-data.generated.ts` of **path data** (the generator fails on an icon that is not path-only); `<vl-icon>`
renders `<svg><path [attr.d]>` — no `innerHTML`, no `bypassSecurityTrust*`. One list drives both the asset and
the picker, and no font or request is added. The design token list the tests compare against is committed as
a fixture copied from `part01.style.txt` (the design file is outside the repo).
**Edge cases:** unknown icon name → fallback icon, no throw; a card with no `imageUrl` or a failing image →
the category gradient; Ukrainian plurals for 1/2/5/11/21; `null` bytes render nothing; long titles clamp.
**Depends on:** none | **Unlocks:** Phases 3, 4
**File scope:** `frontend/src/styles.scss`, `frontend/src/styles/**`, `frontend/src/app/ui/**`,
`frontend/src/app/site.config.ts`, `frontend/src/assets/fonts/**`, `frontend/src/assets/brand/**`,
`frontend/scripts/build-icons.mjs`, `frontend/package.json`, `frontend/package-lock.json`, `frontend/angular.json`,
`frontend/src/app/pages/admin/admin.component.{html,scss}`, `e2e/tests/nocturne-foundation.spec.ts`
**Produces:** global classes `.btn(-primary|-secondary|-ghost|-icon|-block) .input .field .seg .seg-opt
.tag(-accent|-outline|-neutral) .card-kicker .card-title .card-body .card-meta .table .hr .text-muted`;
`ICON_NAMES: readonly string[]`, `<vl-icon [name] [size]>`; `<vl-site-header [brand]="'full'|'logo'">` with
projection slots `[header-start]` and `[header-end]` — `full` puts logo + names first (catalog, 2a), `logo` puts
only the logo last so the scenario page (2b) fills the start with back + breadcrumbs; `<vl-site-footer [maxArchiveBytes]>`; `<vl-scenario-card [scenario] (open) (launch)>` over
`ScenarioCardData {id, title, description, category, categoryLabel, version?: string|null, author?: string|null,
imageUrl: string, archiveBytes?: number|null}`; `categoryGradient(slug: string): string`;
`ToastService.show(text: string): void` + `<vl-toast-host>`; `formatBytes(bytes: number|null|undefined): string`
(`''` for null; `48,2 МБ`); `formatDate(iso: string): string` (`12 бер 2026`, Europe/Kyiv, own month table —
not `Intl`'s `бер.`/`р.`; `''` when invalid); `pluralUk(n: number, forms: [one, few, many]): string`.

**Approach notes:** The icon set covers every icon the prototype uses, the six category icons Phase 1 seeds,
and ~40 picker icons for features/categories (owner decision: fixed set, not the 5.5 MB full font). The footer's
Unity text ("ZIP із WebGL-збіркою") is replaced by the real archive requirement with the limit passed in.
**File hints:** `C:\Users\HuGox\vl-design-extract\vl-design-site\` — `part01.style.txt`, `part03.style.txt`,
`template.html` (font faces), logo PNG; `frontend/src/app/pages/admin/admin.component.scss:59,221` — the colliding classes.

**Done when:**
- [ ] DW-2.1: Every Nocturne token and component class exists with the design file's values (a unit test
  compares the stylesheet source against the token list); the page ground is `#161826`; no light-theme rules remain.
- [ ] DW-2.2: Body text renders in Inter from `/assets/fonts/`; `e2e/tests/csp.spec.ts` passes unchanged.
- [ ] DW-2.3: `<vl-icon>` renders every name in `ICON_NAMES` from the generated file (inheriting colour and
  size) and falls back for unknown names; re-running the generator produces no diff.
- [ ] DW-2.4: Unit tests: the card emits `open` on click and `launch` from its button without also emitting
  `open`; no-image cards show the gradient; header/footer render `site.config.ts` texts; a toast shows and hides.
- [ ] DW-2.5: Unit tests: `formatBytes(50537267)` → `48,2 МБ`, `formatDate('2026-03-12T10:00:00Z')` → `12 бер 2026`, `pluralUk` for 1/2/5/11/21.
- [ ] DW-2.6: The old `/admin` and the viewer still look and work as before; the frontend suite is green.

**Difficulty:** MEDIUM
**Uncertainty:** Whether the `legacy-admin` scope fully neutralises the global classes (Assumptions; fallback in Chosen Approach).

### Phase 3: Catalog and scenario page
**Model:** sonnet
**Skills:** cc-refactoring-guidance, aposd-verifying-correctness, cc-defensive-programming
**Gate:** Standard

**Goal:** Rebuild the catalog as prototype screen 2a and replace the details modal with a `/scenario/:id`
page (2b), on Phase 1's API and Phase 2's components; give the old `/admin` a "Що всередині" editor.

**Scope:**
- IN: catalog page, new scenario page + route, models/services for the Phase 1 contract (incl. `/api/config`
  for the footer limit), removal of the modal and the theme toggle, the `/admin` features field, unit + e2e
  updates, `CLAUDE.md`/`docs/manual-browser-checks.md` where they describe the catalog.
- OUT: the viewer (Phase 4); any other `/admin` change.

**Constraints:** no placeholder copy for missing data — empty features, related, download or preview are
simply absent (preview → gradient). The header button reads "Увійти", or "Панель" while an admin token is in
the session; the hero's department tag and texts come from `site.config.ts`; its third item ("WebGL, без
плагінів") is static.
**Edge cases:** clipboard API missing (the server runs plain HTTP today) or rejected → show the link
selectable instead of failing; a slower response for an older filter must not overwrite a newer one; ids
need `encodeURIComponent`; unknown or unpublished id → a not-found state; a 5xx on the scenario page → an
error state with retry.
**Depends on:** Phase 1, Phase 2 | **Unlocks:** Phase 4
**File scope:** `frontend/src/app/pages/{catalog,scenario,admin}/**`, `frontend/src/app/services/**`,
`frontend/src/app/models/**`, `frontend/src/app/app.routes.ts`, `frontend/src/environments/**`, `e2e/**`,
`docs/test-plan.md`, `docs/manual-browser-checks.md`, `CLAUDE.md`
**Produces:** route `/scenario/:id` (the viewer's exit target in Phase 4); `ScenarioCatalogItem` gains
`archiveBytes: number|null`, `updatedAt: string`, `features: ScenarioFeature[]`;
`ScenarioService.fetchScenarioById(id: string): Promise<ScenarioDetail>` where
`ScenarioDetail extends ScenarioCatalogItem { related: RelatedScenario[] }` (the viewer keeps compiling).

**File hints:** `frontend/src/app/pages/catalog/` — modal, theme and focus-trap code to delete;
`e2e/tests/student-golden-path.spec.ts`, `catalog-a11y.spec.ts` (its modal focus-trap tests are replaced by
scenario-page keyboard tests), `admin-golden-path.spec.ts`.

**Done when:**
- [ ] DW-3.1: The catalog shows 2a's header ("Увійти"/"Панель"), hero (department from config, counters from
  `summary`), sort segment, chips (icon, count, API order), "Знайдено N …", card grid and footer (limit from `/api/config`).
- [ ] DW-3.2: Category, search and sort are server-side and live in the URL query; returning from a
  scenario page restores them; "load more" keeps them; a stale response never wins.
- [ ] DW-3.3: No results → "Нічого не знайдено" + "Скинути фільтри"; an API failure → error state with retry.
- [ ] DW-3.4: `/scenario/:id` renders 2b from real fields (meta table: version, author, size, updated, ID);
  absent features/related/archive hide their blocks; not-found and error states; `document.title` set.
- [ ] DW-3.5: "Копіювати посилання" copies the absolute URL with a toast, or falls back as above; the
  download link is the scenario's archive URL.
- [ ] DW-3.6: The modal and the theme toggle are gone (no `theme` key written); card → `/scenario/:id`, "Запустити" → `/play/:id`.
- [ ] DW-3.7: At 390 px: no horizontal page scroll, chips scroll, the scenario page has a sticky launch bar.
- [ ] DW-3.8: The old `/admin` edits up to six features (icon from `ICON_NAMES`) and shows the server's 400 message.
- [ ] DW-3.9: Loading catalog and scenario page makes no request to another origin (HAR in e2e).
- [ ] DW-3.10: Unit specs and e2e (catalog → filter → search → scenario page → play; keyboard a11y of chips,
  sort and scenario page; admin) updated; all suites green.

**Difficulty:** MEDIUM
**Uncertainty:** None.

### Phase 4: Viewer (presentational HUD)
**Model:** sonnet
**Skills:** welc-legacy-code, aposd-verifying-correctness
**Gate:** Standard

*Amended 2026-10-25 (owner): pause, FPS and the time-scale reset are **not** built in the page. They already
exist inside the isolated player (`WebEngineTS/player-host`, plan
`../../../.code-foundations/plans/2026-10-24-player-isolation.md`), whose Phase 5 wires this phase's components
to `PlayerHost`. Release 1 therefore ships after that plan's Phase 5.*

**Goal:** Restyle the viewer as prototype screens 2c (loading) and 2d (running) as input-only components, and keep
every behaviour the viewer has today.

**Scope:**
- IN: loading view (ring, title, "X з Y МБ", stage, "Скасувати"); HUD ("Вийти", title, an FPS slot, pause /
  restart / fullscreen buttons, hints on wide screens, `?diag=1` button); error, unsupported and context-lost
  states in Nocturne; today's actions wired to the current viewer (exit, cancel, restart from buffer, fullscreen); unit + e2e tests; G5's upstream entry.
- OUT: pause logic, the FPS sampler and any `Time.timeScale` write in the page (player-isolation Phase 5); running
  the scenario in an iframe (same); the prototype's decorative orbits/stars.

**Constraints:** `?stream=1`, abort on leave, `dispose()`, telemetry, the diagnostics policy and the
restart-disabled-when-streamed rule behave exactly as now — `ViewerComponent` has no unit spec, so pin them
first (characterization via sprouted, testable units + `e2e/tests/viewer.spec.ts`). With `[fps]` null the FPS slot
is hidden; with no `(togglePause)` consumer the pause button is not rendered, so nothing student-visible is fake.
G5 (`Time.timeScale` survives a run, `Time._reset()` has no caller): write its entry in `docs/upstream/webenginets.md`,
naming the platform's fix as "a fresh player frame per run" (player-isolation), not a page-side reset.
**Edge cases:** unknown `Content-Length` → "X МБ" without a total; Space does nothing in this phase.
**Depends on:** Phase 2, Phase 3 | **Unlocks:** player-isolation Phase 5
**File scope:** `frontend/src/app/pages/viewer/**`, `e2e/tests/viewer.spec.ts`, `docs/test-plan.md`,
`docs/manual-browser-checks.md`, `docs/upstream/webenginets.md`
**Produces:** presentational components fed only by inputs, which player-isolation Phase 5 drives from `PlayerHost`:
`<vl-viewer-loading [title] [percent] [loadedBytes] [totalBytes] [stage] (cancel)>` and
`<vl-viewer-hud [title] [fps: number|null] [paused] [canPause] [canRestart] (exit) (togglePause) (restart) (fullscreen)>`.

**File hints:** `frontend/src/app/pages/viewer/viewer.component.ts` — lifecycle, token guard, diagnostics
policy to preserve; `WebEngineTS/src/engine/core/Time.ts` — the uncalled `_reset()` (for G5's entry).

**Done when:**
- [ ] DW-4.1: Loading shows the ring + percent, the title, "Завантаження архіву — X з Y МБ", the stage label
  and "Скасувати", which aborts the download and returns to `/scenario/:id`.
- [ ] DW-4.2: Running shows "Вийти" (→ `/scenario/:id`), the title, restart/fullscreen buttons with Ukrainian
  `aria-label`s, and hints on wide screens only; at 390 px the controls stay reachable and the hints are hidden;
  the FPS slot and pause button render only when their inputs are supplied (unit-tested).
- [ ] DW-4.4: Restart re-runs from the buffer; restart stays disabled for a streamed run (today's behaviour).
- [ ] DW-4.5: Error, unsupported-WebGL2 and context-lost states render in Nocturne with their existing actions.
- [ ] DW-4.6: G5's entry is in `docs/upstream/webenginets.md` with evidence and the platform's fix, and the shared
  `ENGINE-GAPS.md` G5 row points at it.
- [ ] DW-4.7: Unit tests for the components (inputs → DOM, outputs) and the byte label; e2e viewer spec updated;
  all suites green.

**Difficulty:** MEDIUM
**Uncertainty:** None.


### Phase 5: Trim the pages and switch the profiler off
**Model:** sonnet
**Skills:** aposd-verifying-correctness
**Gate:** Standard

*Added 2026-10-25 (owner).*

**Goal:** Remove the catalog hero, the footer's main block, the scenario page's download button and launch note,
and stop the `MemoryProfiler` overlay from ever starting on the platform (it will be developed separately).

**Scope:**
- IN:
  - catalog: delete `<section class="hero">` with its glow, title, lead and facts, plus its styles and any
    component code only it used;
  - footer (`ui/site-footer`): delete `<div class="footer-inner">` (brand + about, contacts, "Розробникам" with the
    admin link and the ZIP note); the copyright bar stays; drop inputs/fetches only that block used
    (e.g. `[maxArchiveBytes]`), keeping any still used elsewhere;
  - scenario page: delete the download link (`btn btn-secondary btn-icon download`) and the
    `text-muted launch-note` line; the launch button and "Копіювати посилання" stay;
  - profiler off: the viewer sets `MemoryProfiler.diagnosticsAllowed = false` before every load,
    unconditionally, and hides the overlay after load whatever a scenario called (solar-system calls
    `enableToggle`/`showOverlay` itself); the HUD has no diagnostics button (Phase 4 already builds it without one; remove any leftover
    `toggleDiagnostics` path from the viewer); `?diag=1` keeps only the build stamp (`BuildInfo`), never the overlay;
  - unit + e2e specs updated; `docs/test-plan.md`, `docs/manual-browser-checks.md`, `CLAUDE.md` (viewer and
    diagnostics wording).
- OUT: removing the profiler from the engine (it stays engine API); editing scenario content in ScenarioCreator
  (tracked in `.claude-shared/PLAN.md` §4); the `/api/catalog` `summary` field (left for later use).

**Constraints:** `/admin` stays reachable by URL, only its footer link goes. No student-visible control opens the
overlay, with or without `?diag=1`, and no keyboard toggle (Backquote) works.
**Edge cases:** a scenario that calls `showOverlay()`/`enableToggle()` during load or later; `?diag=1` present;
pressing Backquote in the running scenario.
**Depends on:** Phase 3, Phase 4 | **Unlocks:** none
**File scope:** `frontend/src/app/pages/catalog/**`, `frontend/src/app/pages/scenario/**`,
`frontend/src/app/pages/viewer/**`, `frontend/src/app/ui/site-footer/**`, `e2e/tests/**`, `docs/test-plan.md`,
`docs/manual-browser-checks.md`, `CLAUDE.md`
**Produces:** a viewer that never shows the profiler — player-isolation Phase 5 keeps it by always sending `diag: false`.

**Done when:**
- [ ] DW-5.1: The catalog page has no `.hero`; the footer has no `.footer-inner` and still shows the copyright bar.
- [ ] DW-5.2: The scenario page has no download link and no `.launch-note`; launch and copy-link still work.
- [ ] DW-5.3: Running solar-system (which opens the overlay itself), with and without `?diag=1`, shows no profiler
  overlay, and Backquote does not open it; `?diag=1` still shows the build stamp.
- [ ] DW-5.4: Unit, e2e and build suites green; docs describe the profiler as off.

**Difficulty:** LOW
**Uncertainty:** With today's engine the `diagnosticsAllowed` setter is two-way, so the viewer must also re-close
after load (as `enforceDiagnosticsPolicy` does); the latching setter arrives with the isolation engine release.

---
## Test Coverage
**Level:** 100% (default — the coverage question went unanswered at planning): unit tests for every new or
changed routine, and every DW has at least one named test below.

## Test Plan
Backend = `node:test` integration against the test Postgres; frontend = vitest specs; e2e = Playwright on the stack.
New scenarios get numbers in `docs/test-plan.md` and are cited in each spec header.

**Phase 1**
- [ ] Migration `006` run twice; seeded categories = distinct slugs; icons; `sort_order` by label; `features` default `[]` (DW-1.1)
- [ ] Catalog item/categories/summary shape; `summary` and category `count` unchanged by `category`/`q` (DW-1.2)
- [ ] `sort=title` with `Ґанок, Єнот, Іграшка, Їжак, Яблуко` and Latin titles → Ukrainian order; `sort=new` = today's order (DW-1.3)
- [ ] Boundary: `limit` 0/1/100/101 and `offset` past the end under both sorts (DW-1.3)
- [ ] Dirty: `sort=` empty, `sort=DROP`, `sort[]=a&sort[]=b` → `new` order; `q` with `%`/`_` still literal (DW-1.3)
- [ ] `related`: same category first, ≤2, never self, never unpublished; a lone-category scenario gets 2 from others (DW-1.4)
- [ ] Dirty: unpublished id, unknown id, id with `%2F` → 404 (DW-1.4)
- [ ] `/api/config` default and env override; boundary: archive of exactly the limit accepted, limit + 1 byte → 413, temp dir empty (DW-1.5)
- [ ] Accepting boundaries: 6 features, title 60, subtitle 90, subtitle absent, icon 40 chars (DW-1.6)
- [ ] Dirty features: 7 items, icon `Atom`, `../x`, 41 chars, empty title, title 61, subtitle 91, non-array, item `null` → 400 each (DW-1.6)
- [ ] Unknown slug creates a category (label from `categoryLabel`, or the slug when absent) appended at max + 10; known slug with another label keeps the stored label; non-array stored `features` reads `[]`; slug without a row still lists (DW-1.6, Edge)
- [ ] A category set `is_visible = false` by SQL and one with only unpublished rows are absent from `categories` and from `summary.categories` (DW-1.2)

**Phase 2** (spec numbers in `docs/test-plan.md` are assigned by Phase 3, which owns the file after Phase 1)
- [ ] Token fixture vs stylesheet source; no `dark-theme` / light-theme selectors remain in any stylesheet (DW-2.1)
- [ ] e2e `nocturne-foundation.spec.ts`: `document.fonts.check('16px Inter')` true and font requests served from `/assets/fonts/` (DW-2.2)
- [ ] e2e `nocturne-foundation.spec.ts`: the old `/admin` buttons' computed background/border/font match values captured before the change (characterization) (DW-2.6)
- [ ] `<vl-icon>` renders every `ICON_NAMES` entry; dirty: `''`, unknown, `null` → fallback, no throw; generator idempotent (DW-2.3)
- [ ] Card: click → `open`; button → `launch` only; no image / image error → gradient; 200-char title clamps (DW-2.4)
- [ ] Header/footer render config texts; footer limit from input, absent input → no number (DW-2.4)
- [ ] Toast shows, auto-hides, has `aria-live` (DW-2.4)
- [ ] `formatBytes` 0, 1023, 1048576, 50537267, `null`; `formatDate` invalid → `''`, late-evening UTC → Kyiv date; `pluralUk` 0,1,2,4,5,11,12,14,21,22,25,101,111 (DW-2.5)
- [ ] e2e `csp.spec.ts` unchanged and green; old admin golden path still green (DW-2.2, DW-2.6)

**Phase 3**
- [ ] Hero counters, chips with icons/counts, "Знайдено N" plural, "Увійти" vs "Панель", footer limit, sort segment drives `sort` (DW-3.1)
- [ ] URL ↔ filters round trip; back from `/scenario/:id` restores; load more keeps the query (DW-3.2)
- [ ] Dirty: responses resolving out of order → the newest filter wins (DW-3.2)
- [ ] Empty result → empty state; reset clears URL; 500 → error state, retry reloads (DW-3.3)
- [ ] Scenario page: all fields; features `[]`, related `[]`, no `scenarioUrl` → blocks hidden; unknown id → not-found; 500 → error + retry; id with `/` and Cyrillic encoded; title set (DW-3.4)
- [ ] Copy link: clipboard ok → toast; clipboard missing / rejected → selectable link; download `href` equals the item's `scenarioUrl` (DW-3.5)
- [ ] The scenario page header uses `<vl-site-header brand="logo">` with back + breadcrumbs in `[header-start]` (DW-3.4)
- [ ] No `theme` key written, no modal in DOM; card/launch navigation targets (DW-3.6)
- [ ] e2e at 390×844: `scrollWidth <= innerWidth`, chips scroll, sticky launch bar visible (DW-3.7)
- [ ] Old `/admin`: six features saved; a seventh blocked; server 400 surfaced (DW-3.8)
- [ ] e2e HAR: every request same-origin (DW-3.9)
- [ ] e2e student golden path via the scenario page; keyboard: chips `aria-pressed`, sort radios, scenario page tab order to "Запустити"; admin golden path (DW-3.10)

**Phase 4**
- [ ] Unit: HUD hides the FPS slot when `fps` is null and the pause button when `canPause` is false; outputs fire (DW-4.2)
- [ ] Byte label: known total, unknown total (0), loaded > total (DW-4.1)
- [ ] Dirty: Space does nothing in the page (pause arrives with player-isolation Phase 5) (DW-4.2)
- [ ] e2e: loading UI then HUD; cancel during download returns to the scenario page; `aria-label`s present; hints hidden at 390 px (DW-4.1, DW-4.2)
- [ ] e2e: restart enabled for ZIP, disabled with `?stream=1` (DW-4.4)
- [ ] e2e: forced context loss shows the restyled state with "reload"; unsupported state via a WebGL2-less context (DW-4.5)
- [ ] Review: the upstream entry names `Time._reset()` and the platform's fix (DW-4.6)

**Phase 5**
- [ ] e2e: no `.hero` on `/`; no `.footer-inner`, copyright bar present (DW-5.1)
- [ ] e2e: scenario page has no download link and no `.launch-note`; launch and copy-link work (DW-5.2)
- [ ] e2e: solar-system with and without `?diag=1` → no overlay element; Backquote → still none; `?diag=1` → build stamp visible (DW-5.3)
- [ ] Dirty unit: viewer sets `diagnosticsAllowed = false` before load even with `?diag=1`; HUD has no diagnostics output (DW-5.3)
- [ ] All suites (DW-5.4)

**Manual** (`docs/manual-browser-checks.md`, supports DW-3.1, DW-3.4, DW-4.1, DW-4.2): compare catalog, scenario
page, loading and HUD against the prototype side by side at 1440 px and 390 px in Chrome and Firefox;
keyboard-only walk through catalog → scenario → play → exit.

## Assumptions
| Assumption | Confidence | Verify Before Phase | Fallback If Wrong |
|---|---|---|---|
| `postgres:16-alpine` has ICU and a Ukrainian collation (`uk-x-icu`) | MED | Phase 1 | Sort by `lower(title)` with a documented imperfect order for і/ї/є/ґ |
| No stored archive exceeds 200 MiB | HIGH | Phase 1 (`SELECT max(archive_bytes)`) | Keep the larger default in `.env` and report it |
| The prototype's Inter woff2 subsets are complete for Ukrainian | HIGH | Phase 2 | Fetch the Cyrillic subsets from the Inter release (OFL) |
| The `legacy-admin` scope neutralises the global classes for the old admin | MED | Phase 2 | Prefix the Nocturne classes for release 1 (Chosen Approach fallback) |
| `Time` is exported by the engine bundle and `timeScale` is writable | HIGH (checked in `WebEngineTS.d.ts`) | — | — |

## Decision Log
| Decision | Alternatives Considered | Rationale | Phase |
|---|---|---|---|
| Global Nocturne CSS + few components | Component library; inline-style port | Nocturne is plain CSS by design; one file to retune | 2 |
| Icon subset generated from `@phosphor-icons/core` into inline SVG | Full Phosphor font via CDN; hand-copied SVGs | CSP stays `'self'`; one list drives asset and picker | 2 |
| `categories` table now, CRUD later | Keep labels on `scenarios` only | Icons and order are needed by release 1's chips | 1 |
| Category labels canonical in `categories`, upsert keeps existing | Last writer wins | Old admin rows may disagree; the table must not flap | 1 |
| Sort on the server | Client sort | Paging makes a client sort wrong | 1 |
| Filters in the URL | Service-held state | Survives reload, back and shared links | 3 |
| No placeholder copy for missing data | "Опис не заповнено" / "ПРЕВʼЮ НЕМАЄ" from the mockups | Owner chose "hide empty" | 3 |
| No page-side pause/FPS/time-scale reset; the player frame owns them *(owner, 2026-10-25)* | Build them in the page, then move them | Already built and tested in the player; a fresh frame per run fixes G5 for the platform | 4 |
| Phase 4 after Phase 3 (serial) | Parallel with disjoint scopes | The viewer's exit/cancel target `/scenario/:id` is Phase 3's; both edit `docs/test-plan.md` | 4 |

---
## Notes
- **Engine gap G5:** the shared row was added to `.claude-shared/ENGINE-GAPS.md` at planning and is uncommitted
  there — the owner commits it in that repo; Phase 4 writes the detailed entry here.
- **Owner action before build (other repos):** `.claude-shared/tasks/B-milestone-1.md:111` and
  `WebEngineTSEditor/docs/unity-editor-plan.md:552` still name `006` for `publish_keys`; annotate them as `007`
  so no parallel session creates `006_publish_keys.sql`.
- **Space pauses even when a scenario uses Space** — the prototype states "Space — пауза"; revisit if content complains.
- The KSU logo, department name, address and `vlab@ksu.ks.ua` come from the prototype and must be confirmed by the owner before deploy.
- **Release 1 ships after player-isolation Phase 5** (`../../../.code-foundations/plans/2026-10-24-player-isolation.md`), which wires Phase 4's input-only components to `PlayerHost` and supplies pause (Space), FPS and the fresh-frame restart.
---
## Decided During Build
_Filled by /code-foundations:build — one row per decision an agent made or question it raised:_
| # | Phase | Decision or question | Source | Status |
|---|---|---|---|---|
| 1 | 1 | `sort=title` and the migration seed use `COLLATE "uk-x-icu"` (verified by test: Ґ<Є<І<Ї<Я, Latin before Cyrillic); a DB without ICU would 500 on `sort=title` | assumption verified | assumed |
| 2 | 1 | Max stored `archive_bytes` not checked (dev DB down); 200 MiB default stays overridable — run `SELECT max(archive_bytes) FROM scenarios` before deploy | assumption fallback | assumed |
| 3 | 1 | Public `archiveBytes` cast `::float8` (number); admin list still returns it as a string as before | default | assumed |
| 4 | 1 | Categories auto-created by POST/PUT get icon `folder`, `sort_order` = max + 10; only the migration seed maps prototype icons | plan | assumed |
| 5 | 1 | Category upsert and scenario write share one transaction (409/404 leaves no stray category) | default | assumed |
| 6 | 1 | `summary.categories` = number of chips; `summary.scenarios` counts all published incl. hidden/row-less categories | plan | assumed |
| 7 | 1 | Admin `features`: unknown keys dropped, title trimmed, `null` subtitle stored as absent | default | assumed |
| 8 | 1 | multer limit = cap + 1 (busboy fires on reaching `fileSize`); nginx `client_max_body_size` 512m untouched | discovered | assumed |
| 9 | 1 | Search `ESCAPE ''` bug fixed — `%`/`_` in `q` now match literally (behaviour change) | discovered | assumed |
| 10 | 1 | PUT now rejects non-string/empty `category` and non-string `categoryLabel` with 400 | default | assumed |
| 11 | 2 | "No light-theme rules" test scans `styles.scss` + `src/styles/**`; the catalog's own `dark-theme` toggle is Phase 3's to remove | file scope | assumed |
| 12 | 2 | Old reset `*{margin:0;padding:0}` kept at specificity 0 in `_base.scss` for legacy pages; Phase 3/4 may delete it | DW-2.6 | assumed |
| 13 | 2 | Card `open`/`launch` are `output<string>()` emitting the scenario id; launch stops propagation | default | assumed |
| 14 | 2 | `ICON_NAMES` (133 icons) lives in `scripts/build-icons.mjs`; generated file exports `ICON_NAMES`+`ICON_PATHS`; fallback icon `folder`; release 2's picker may filter UI-only icons | default | assumed |
| 15 | 2 | Inter ships cyrillic-ext, cyrillic, latin at 400/500 only (latin-ext/greek/vietnamese omitted) | default | assumed |
| 16 | 2 | `e2e/helpers/api.ts` (outside scope, orchestrator-allowed): `E2E_SMALL_ARCHIVE` override, then both workspace layouts and `Benchscene1_primitives`/`Benchscene1_N100` | env fix | assumed |
| 17 | 2 | Element typography neutralised for `app-admin, app-viewer, app-catalog` via `:where()` (viewer scss is out of scope); global scrollbar and accent `:focus-visible` ring are accepted drift; catalog's `.card-title` inherits global props until Phase 3 | deviation | assumed |
| 18 | 2 | Footer: "ZIP-архів зі сценарієм, до {limit}" (no number without a limit); `SITE.department` = "Кафедра інформатики, програмної інженерії та економічної кібернетики" | default | assumed |
| 19 | 3 | URL query (`category`, `q`, `sort`; defaults omitted) is the single holder of the catalog filter (`services/catalog-query.ts`) | plan + DW-3.2 | assumed |
| 20 | 3 | The scenario page's "Каталог" button returns with the last catalog filter, kept in `ScenarioService.filter` | default | assumed |
| 21 | 3 | Stale catalog responses (incl. errors and `loading`) are dropped by a request ticket in `ScenarioService` | DW-3.2 | assumed |
| 22 | 3 | `<vl-toast-host>` is mounted once in `AppComponent` (outside file scope, per Phase 2's "mount once in the shell"); Phase 4 must not mount a second | default | assumed |
| 23 | 3 | A scenario without `scenarioUrl` has no launch button, sticky bar or download; its card's "Запустити" opens the scenario page | plan edge case | assumed |
| 24 | 3 | Chips and hero counters show unfiltered API numbers (do not change with search) and survive a failed request | default | assumed |
| 25 | 3 | Catalog error text is always "Не вдалося завантажити каталог"; detail goes to the console | default | assumed |
| 26 | 3 | Counter pluralises the whole phrase (1 освітній напрям / 2 освітні напрями / 5 освітніх напрямів) | default | assumed |
| 27 | 3 | Mobile launch bar is CSS-only at `max-width: 859px` (prototype breakpoint); sidebar launch hidden there | default | assumed |
| 28 | 3 | Test-plan numbers: 112–119 Phase 2 specs, 120–137 Phase 3; scenarios 79–80 retired, not renumbered | binds later phases | assumed |
| 29 | 3 | No `overflow-x: hidden` on catalog/scenario `:host` (would break sticky); the body scrolls | default | assumed |
| 30 | 3 | DW-3.9 same-origin check uses a `page.on('request')` listener rather than a recorded HAR | default | assumed |
| 31 | 3 | Admin's new buttons are `.add-feature`/`.feature-remove` (not `.btn-small`) so the DW-2.6 characterization baseline is undisturbed | deviation | assumed |
| 32 | 4 | Byte line: loaded > total drops the total ("X МБ"); both figures in МБ with one decimal and a comma (prototype), not `formatBytes`'s per-value units; shown only when `loadedBytes` is supplied (hidden for streaming) | default / prototype | assumed |
| 33 | 4 | Stage labels "Отримання даних із сервера" (download) and "Ініціалізація сцени" (engine/streaming); the engine's English `currentOperation` is no longer shown | prototype | assumed |
| 34 | 4 | HUD keeps the `viewer-controls` / `title-badge` classes that existing e2e specs wait on | pattern reuse | assumed |
| 35 | 4 | Restart button aria-label "Спочатку" (prototype) replaces "Перезапустити сценарій" | prototype | assumed |
| 36 | 4 | Only the HUD's exit and the loader's cancel go to `/scenario/:id`; error/unsupported/context-lost keep their catalog/reload actions | plan "existing actions" | assumed |
| 37 | 4 | "Space — пауза" hint renders only with `canPause` | no-fake-controls constraint | assumed |
| 38 | 4 | HUD has no diagnostics control; `toggleDiagnostics`/`diagnosticsVisible`/`enforceDiagnosticsPolicy` left for Phase 5; e2e now asserts no button and that `?diag=1` leaves solar-system's own overlay open (Phase 5 reverses this) | orchestrator clarification | assumed |
| 39 | 4 | Viewer half of `nocturne-foundation.spec.ts` retired; `app-viewer` dropped from `_legacy.scss`; test-plan numbers 138–144 used | orchestrator allowance / #28 | assumed |
| 40 | 4 | `CLAUDE.md` still describes the old viewer diagnostics button — Phase 5 owns `CLAUDE.md`'s viewer/diagnostics wording | file scope | assumed |
| 41 | 5 | Profiler locked at init, before each load and restart, re-enforced once after load and every 1 s until destroy (two-way setter in the installed engine); the interval can go when the latching setter lands | plan uncertainty + engine d.ts | assumed |
| 42 | 5 | `diagnosticsEnabled` renamed `buildStampVisible`; query flags read before the WebGL probe, so the stamp also shows on the unsupported screen | default | assumed |
| 43 | 5 | `PlatformConfigService` + spec deleted (no consumer); `GET /api/config` stays; `summary` signal and API field stay | orchestrator allowance | assumed |
| 44 | 5 | `site.config.ts` untouched; now unused by the UI: `about`, `address`, `email`, `department`, `university`, `universityShort`, `logo` (still used: `name`, `copyright`) | orchestrator allowance | assumed |
| 45 | 5 | Test-plan #145–148 added, #123 retired; e2e relies on the engine's overlay id `#webengine-profiler` | default | assumed |
| 46 | 5 | The "lock before load even with `?diag=1`" unit test checks init (jsdom has no WebGL2); per-load locking is covered by e2e | deviation | assumed |
---
## Execution Log
_To be filled during /code-foundations:build_

### Phase 1: Catalog data and API (Gate: Standard, security-sensitive)
- [x] BUILD: Discovery + design + implementation (stub → implement → validate) complete
- [x] REVIEW: Verification passed
- [x] Committed
Commit: 8940004
Summary: Migration 006 (categories with icon/sort_order/is_visible, scenarios.features) plus `/api/catalog` (archiveBytes, updatedAt, features, categories with icon+count, summary, whitelisted `sort=new|title` in uk-x-icu), `/api/catalog/:id` with `related`, `GET /api/config {maxArchiveBytes}` (200 MiB default, oversize → 413) and validated admin `features`; backend suite 348 green.

### Phase 2: Nocturne foundation (Gate: Standard)
- [x] BUILD: Discovery + design + implementation (stub → implement → validate) complete
- [x] REVIEW: DEFERRED — batch pending (tests green at commit)
- [x] Committed
Commit: a1433b0
Summary: Nocturne tokens/components/keyframes live in `frontend/src/styles/` (ground #161826, light rules gone), Inter 400/500 and a generated 133-icon Phosphor subset are self-hosted; `ui/` provides `<vl-icon>`, `<vl-site-header [brand]>` (slots header-start/header-end), `<vl-site-footer [maxArchiveBytes]>`, `<vl-scenario-card>` (open/launch emit the id), `ToastService` + `<vl-toast-host>`, `formatBytes/formatDate/pluralUk`, `categoryGradient`, and `site.config.ts` `SITE`; old /admin and viewer unchanged in look (legacy scope); unit 136 green, e2e 30 pass / 8 skip.
- [x] 2026-10-25 Fixed batch review findings — DW-2.6 admin characterization flake (hover transition mid-flight) settled before snapshot (5e73278)
- Covered by batch review 2026-10-25 (phases 2–3)

### Phase 3: Catalog and scenario page (Gate: Standard)
- [x] BUILD: Discovery + design + implementation (stub → implement → validate) complete
- [x] REVIEW: DEFERRED — batch pending (tests green at commit)
- [x] Committed
Commit: d800252
Summary: The catalog is prototype 2a on Nocturne (real `summary` counters, icon chips in API order, sort segment, footer limit from `/api/config`) with category/q/sort in the URL query and stale responses dropped; `/scenario/:id` (2b, lazy route, logo-only header with back + breadcrumbs, meta table, features, related, copy link with fallback, sticky launch bar, not-found/error) replaced the modal and theme toggle; the old /admin edits up to six features; `ScenarioService.fetchScenarioById` returns `ScenarioDetail`; the viewer's exit target is still `/catalog` (Phase 4 switches it); unit 226 green, e2e 48 pass / 8 skip.
- Covered by batch review 2026-10-25 (phases 2–3)

### Phase 4: Viewer (presentational HUD) (Gate: Standard)
- [x] BUILD: Discovery + design + implementation (stub → implement → validate) complete
- [x] REVIEW: DEFERRED — batch pending (tests green at commit)
- [x] Committed
Commit: 9716127
Summary: The viewer is Nocturne 2c/2d built from input-only `<vl-viewer-loading [title] [percent] [loadedBytes] [totalBytes] [stage] (cancel)>` and `<vl-viewer-hud [title] [fps] [paused] [canPause] [canRestart] (exit) (togglePause) (restart) (fullscreen)>` (FPS slot, pause button and Space hint render only when supplied; no diagnostics control); exit/cancel go to `/scenario/:id`; stream/abort/dispose/telemetry/restart-from-buffer unchanged; the viewer still holds `toggleDiagnostics`/`enforceDiagnosticsPolicy` and the `?diag=1` build stamp for Phase 5 to cut down; G5 entry is `docs/upstream/webenginets.md` §6 and the shared row points at it (uncommitted in `.claude-shared`); unit 250 green, e2e 54 pass / 8 skip.
- [x] 2026-10-26 Fixed batch review findings — unit coverage of the viewer's load/restart/exit/canRestart paths incl. DW-4.4's streamed clause, via a `createApplication()` seam (dd827b6)
- Covered by batch review 2026-10-26 (phases 4–5)

_2026-10-25 15:30: the main checkout was switched to `main` by another session, discarding this plan's uncommitted edits (owner's Phase 4/5 amendments, decisions #19–40, log entries for Phases 2–4). Restored from the orchestrator's copy and committed; the build continues in `.claude/worktrees/nocturne-release-1`._

### Phase 5: Trim the pages and switch the profiler off (Gate: Standard)
- [x] BUILD: Discovery + design + implementation (stub → implement → validate) complete
- [x] REVIEW: DEFERRED — batch pending (tests green at commit)
- [x] Committed
Commit: 51bcaec
Summary: The catalog has no hero, the footer is the copyright bar only, the scenario page has no download link or launch note; the viewer locks `MemoryProfiler.diagnosticsAllowed` before every load/restart and re-closes the overlay after load and every second, so no student ever sees it (`?diag=1` shows only the BuildInfo stamp); `PlatformConfigService` deleted; CLAUDE.md describes the profiler as off; unit 242 green, e2e green after re-running two flakes (F5 progress peak, admin fixture path inside the worktree).
- [x] 2026-10-26 Fixed batch review findings — unit coverage of the profiler lock and 1000 ms guard; the guard now starts at load start and destroy invalidates an in-flight load (a352fae)
- Covered by batch review 2026-10-26 (phases 4–5)
