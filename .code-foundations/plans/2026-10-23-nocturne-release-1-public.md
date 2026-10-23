# Plan: Release 1 — the public site on Nocturne
**Created:** 2026-10-23
**Status:** in-progress
**Started:** 2026-10-23 12:00
**Current Phase:** 1
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
number shown is real; `/scenario/:id` replaces the modal; pause on Space works and restores the previous
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

### Phase 4: Viewer
**Model:** sonnet
**Skills:** welc-legacy-code, aposd-verifying-correctness
**Gate:** Standard

**Goal:** Restyle the viewer as prototype screens 2c (loading) and 2d (running) and add the HUD: real FPS,
pause on Space, restart, fullscreen, control hints — keeping every behaviour the viewer has today.

**Scope:**
- IN: loading view (ring, title, "X з Y МБ", stage, "Скасувати"); HUD ("Вийти", title + FPS, pause /
  restart / fullscreen, hints on wide screens, `?diag=1` button); error, unsupported and context-lost states
  in Nocturne; the time-scale reset below; the engine-gap entry; unit + e2e tests.
- OUT: running the scenario in an iframe (release 2 Phase 1); the prototype's decorative orbits/stars.

**Constraints:** `?stream=1`, abort on leave, `dispose()`, telemetry, the diagnostics policy and the
restart-disabled-when-streamed rule behave exactly as now — `ViewerComponent` has no unit spec, so pin them
first (characterization via sprouted, testable units + `e2e/tests/viewer.spec.ts`). **The engine never
resets `Time.timeScale`** (`Time._reset()` has no caller; it is a module-level static), so a paused or
slowed scenario leaks its scale into the next run: first write gap G5's entry in `docs/upstream/webenginets.md`
(evidence, effect, workaround — the shared index row already exists), then the viewer sets
`Time.timeScale = 1` before every load and restart and on destroy.
**Edge cases:** pause saves `Time.timeScale` and resume restores it, whatever the scenario set; restart or a
new load clears the paused state; Space on a focused HUD button must not toggle twice; unknown
`Content-Length` → "X МБ" without a total; the FPS sampler stops on destroy and while hidden.
**Depends on:** Phase 2, Phase 3 | **Unlocks:** release 2 Phase 1
**File scope:** `frontend/src/app/pages/viewer/**`, `e2e/tests/viewer.spec.ts`, `docs/test-plan.md`,
`docs/manual-browser-checks.md`, `docs/upstream/webenginets.md`
**Produces:** presentational components fed only by inputs, which release 2 re-hosts around the isolated player:
`<vl-viewer-loading [title] [percent] [loadedBytes] [totalBytes] [stage] (cancel)>` and
`<vl-viewer-hud [title] [fps: number|null] [paused] [canRestart] [diagnosticsEnabled] (exit) (togglePause)
(restart) (fullscreen) (toggleDiagnostics)>`.

**File hints:** `frontend/src/app/pages/viewer/viewer.component.ts` — lifecycle, token guard, diagnostics
policy to preserve; `WebEngineTS/src/engine/core/Time.ts:280` — the uncalled `_reset()`.

**Done when:**
- [ ] DW-4.1: Loading shows the ring + percent, the title, "Завантаження архіву — X з Y МБ", the stage label
  and "Скасувати", which aborts the download and returns to `/scenario/:id`.
- [ ] DW-4.2: Running shows "Вийти" (→ `/scenario/:id`), title + FPS measured from frames (not a constant),
  pause/restart/fullscreen buttons with Ukrainian `aria-label`s, and hints on wide screens only; at 390 px the
  controls stay reachable and the hints are hidden.
- [ ] DW-4.3: Space and the button pause and resume; `Time.timeScale` is `0` while paused and the previous
  value afterwards (e2e reads it through `import('WebEngineTS')`).
- [ ] DW-4.4: Restart re-runs from the buffer at scale 1 and unpaused; leaving while paused and opening another
  scenario starts it at scale 1; restart stays disabled for a streamed run.
- [ ] DW-4.5: Error, unsupported-WebGL2 and context-lost states render in Nocturne with their existing actions.
- [ ] DW-4.6: G5's entry is in `docs/upstream/webenginets.md` with evidence and the workaround, and the shared
  `ENGINE-GAPS.md` G5 row points at it.
- [ ] DW-4.7: Unit tests for the sprouted pieces (FPS sampler, pause controller, byte label); e2e viewer spec
  updated; all suites green.

**Difficulty:** MEDIUM
**Uncertainty:** A scenario that reads Space itself also pauses — accepted per the prototype (Notes).

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
- [ ] FPS sampler: synthetic frame times → expected average; stops on destroy and while `document.hidden` (DW-4.2)
- [ ] Pause controller: 1 → 0 → 1; scenario-set 0.5 → 0 → 0.5; restart while paused → unpaused at 1 (DW-4.3, DW-4.4)
- [ ] Byte label: known total, unknown total (0), loaded > total (DW-4.1)
- [ ] Dirty: Space on a focused HUD button toggles once; Space while loading does nothing (DW-4.3)
- [ ] e2e: loading UI then HUD; cancel during download returns to the scenario page; FPS text changes over time; `aria-label`s present; hints hidden at 390 px (DW-4.1, DW-4.2)
- [ ] e2e: `Time.timeScale` 0 while paused and restored; pause → exit → open another scenario → scale 1; restart enabled for ZIP, disabled with `?stream=1` (DW-4.3, DW-4.4)
- [ ] e2e: forced context loss shows the restyled state with "reload"; unsupported state via a WebGL2-less context (DW-4.5)
- [ ] Review: the upstream entry names `Time.ts:280` and the workaround (DW-4.6)

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
| Host resets `Time.timeScale` around runs, gap recorded | Wait for an engine fix | Students would see frozen scenes now; the rule is "record, then work around" | 4 |
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
- Release 2 Phase 1 re-hosts the viewer on an isolated player; Phase 4's input-only components are what keep that a re-host, not a rewrite.
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
---
## Execution Log
_To be filled during /code-foundations:build_
