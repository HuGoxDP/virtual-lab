# Plan: Release 2 — admin, roles and scenario isolation on Nocturne
**Created:** 2026-10-23
**Status:** ready
**Superseded in part (Phase 1):** by `.code-foundations/plans/2026-10-24-player-isolation.md` — completed 2026-10-27. Phases 2–7 are unchanged; a build resumes at Phase 2.
**Complexity:** complex
**Review cadence:** 2
**Check-ins:** checkpoints
---
## Context
Catalog writes are guarded by one `ADMIN_TOKEN` that cannot be handed to teachers, there is no author/moderator
workflow, no archive history, no category management, and (until the player-isolation plan) a scenario's code ran on
the API's origin — so any personal key would have been readable by the next archive a moderator opens. This plan is **release 2 of 2**: the new
admin from the prototype (2e–2m), personal keys with roles, moderation, versions, and scenario isolation.
**It starts only after release 1** (`.code-foundations/plans/2026-10-23-nocturne-release-1-public.md`) has
landed: it reuses that plan's Nocturne classes, shared components, `categories` table (with `is_visible`),
features and the viewer's input-only HUD components. (Release 1 dropped the page-side `Time.timeScale` reset: every
scenario now runs in a fresh player frame, which is the fix for engine gap G5 — nothing here needs a reset.)

Requirements and decisions: `.code-foundations/research/2026-10-23-nocturne-redesign.md` (sections "Релиз 2",
"Принятые решения", "Решения по бывшим открытым вопросам"). Key design: `WebEngineTSEditor/docs/unity-editor-plan.md`
§7 (publish keys, permission matrix, draft for archives of published scenarios). Platform plan: `../../.claude-shared/PLAN.md`
§2.6 (publish keys); §2.9 (isolation before keys) is closed by the player-isolation plan. Design files: as in release 1's Context.

**Success criteria:** an author with a personal code uploads, fills metadata and preview, and submits; a moderator
reviews (static checks + a test run in their browser), publishes or returns with a note; the catalog shows only
`published`; a new archive for a published scenario reaches students only after a moderator accepts it; moderators
issue/revoke codes, manage categories and roll back versions; history and activity are visible; scenario code runs
in the engine's sandboxed player (opaque origin, shipped by the player-isolation plan) and can neither read an
access code nor call the API as the user; all suites green.

## Constraints
- Personal keys are §7's design extended with a role: `publish_keys` (`label`, `role`, `token_hash` SHA-256,
  `last_used_at`, `revoked_at`), `scenarios.owner_key_id`; the token is shown once; `ADMIN_TOKEN` stays as the
  bootstrap moderator. The same key authenticates the admin UI and the editor's Publish (`Authorization: Bearer`).
- Session as today: the browser keeps the code in `sessionStorage` until the tab closes or the user signs out.
- **Ordering policy:** Phase 2 does not consume Phase 1's output, but it follows it so that no author key can
  exist on a build where scenario code shares the platform's origin. In production, issue author keys only once
  the player-isolation plan (its Phase 5) is deployed.
- Statuses `draft → review → published | rejected`; unpublish returns to `draft`. No "hidden"/"unlisted" statuses;
  a scenario in a hidden category is treated as unpublished by every public endpoint.
- Authors edit **content fields** of their own scenarios directly in any status (Phase 2's field table); a new
  archive for a published scenario is a pending version until a moderator accepts it (§7, decision B).
- Every archive version is kept and counts as a GC reference until it is deleted (by a moderator, or by its
  author while pending); at most 50 versions per scenario.
- Existing rows: `published`/`draft` from `is_published`, no owner; `author` stays the display name, defaults to
  the creating key's label, and only moderators edit it.
- Migrations `007`–`010` (`010`: Phase 4's clearing of external `imageUrl`s); idempotent; `docs/code-standards.md` applies throughout.
- CSP: the platform pages already gained `frame-src 'self'` and lost `blob:` from `script-src` (player-isolation plan);
  this plan may still drop `https:` from `img-src` (Phase 4); nothing else loosens.
- Author-supplied text is rendered as text only — no `innerHTML`, no `bypassSecurityTrust*`.
- Out of scope: frame capture, headless checks, launch statistics, e-mail, SSO, "recommended" placement.

## Chosen Approach
**Isolation is delivered by `.code-foundations/plans/2026-10-24-player-isolation.md`, not here:** the engine ships a sandboxed player page, its header snippet and a
host client (`WebEngineTS/player-host`); the viewer drives it. Opaque origin on the same host only, no `PLAYER_ORIGIN`.
This plan builds on that for Phase 7's test run. Its own approach: backend routes are split into modules by actor
before new routes are added; archive history is a `scenario_versions` table whose `pending` row is §7's "pending archive".

## Rejected Approaches
- **Isolate the admin instead of the player (`admin.<host>`):** leaves the next login on the main origin (LTI, PLAN §2.10) beside untrusted code.
- **`pending_archive_sha256` column only:** covers the draft but not history and rollback, which then need a second mechanism.
- **Keep adding routes to `server.js`:** 783 lines today, ~15 more routes coming, four actors in one file.

---
## Implementation Phases

### Phase 1: Player isolation — DONE, superseded by the player-isolation plan
**Model:** sonnet
**Skills:** none -- completed by the player-isolation plan
**Gate:** Standard
**Depends on:** none | **Unlocks:** Phases 2, 7
**File scope:** none -- nothing left to build here

**Completed by `.code-foundations/plans/2026-10-24-player-isolation.md`** (2026-10-24 to 2026-10-27). Do not build this phase: the Execution
Log records it as satisfied, and a build resumes at Phase 2. Commits: virtual-lab `9b0ae09` and `2bf3a12`
(branch `feature/player-isolation`), WebEngineTS `02fdc1f` (the engine's Phases 1-3 are earlier commits on the same branch).

**What replaced it:** every scenario runs in an engine-shipped, sandboxed player (`<iframe sandbox>` on an opaque
origin, same host, no second-origin mode) driven by `PlayerHost` from `WebEngineTS/player-host`. The platform page
runs no scenario code: `/` has no import map, and its `script-src` is `'self'`. Specifics are in the isolation plan and
in `virtual-lab/CLAUDE.md` (Engine integration, CSP).

**Dependencies on this phase are satisfied:** Phases 2 and 7 depend on Phase 1; the isolation plan meets that dependency.
The plan's ordering policy (no author key in production before isolation is deployed) now reads "once the isolation plan is deployed".

**References in Phases 3 and 7 to `frontend/src/app/player/**` and `protocol.ts` (`measure`/`metrics`)** are the old design.
They now mean the engine's `WebEngineTS/player-host` (`PlayerHost.measure()` returning `PlayerMetrics`); the
phase text itself is unchanged.

### Phase 2: Keys, roles and authorization
**Model:** sonnet
**Skills:** cc-defensive-programming, ca-architecture-boundaries, cc-refactoring-guidance
**Gate:** Standard

**Goal:** Replace the single admin token with personal, revocable keys carrying a role; enforce the route and
field permissions below on every write; harden uploads now that authors are untrusted uploaders; journal actions.

**Scope:**
- IN: a behaviour-preserving split of `server.js` into actor modules (own commit; `server.js` stays the entry
  point and keeps its exports `{app, pool, escapeLikePattern, tokensMatch, parseLimit, parseOffset}`);
  migration `007` (`publish_keys`, `scenarios.owner_key_id`, `audit_events`); principal middleware; keys API;
  `GET /api/auth/me`; rate limits; archive-validation caps; tests; `CLAUDE.md` auth section.
- OUT: statuses and versions (Phase 3); any UI.

**Constraints:** routes — public GETs: anyone; `GET /api/admin/scenarios`: author → own rows, moderator → all;
`POST /api/catalog`: author (row created unpublished, owner = self, `author` = key label) or moderator;
`PUT /api/catalog/:id`: owner author (content fields only) or moderator; `DELETE /api/catalog/:id`, storage, GC,
telemetry summary, `/api/keys*`: moderator; `POST /api/scenarios/:id/archive`: owner author while unpublished
(published → 403 until Phase 3 makes it pending) or moderator; `/api/auth/me`: any principal. Author content
fields: `title, description, fullDescription, category, version, features` — `category` must be an existing
slug (400 otherwise; release 1's create-on-unknown-slug is moderator-only from here) and `categoryLabel` is
ignored; never `scenarioUrl, manifestUrl, archive*, author, isPublished, imageUrl` (400).
**Constraints (cont.):** the split also wraps each mutation route in one client transaction (`BEGIN … COMMIT`) — a deliberate addition, so it lands in its own commit after the behaviour-preserving split, not inside it.
**Edge cases:** revoked or unknown key → 403; `ADMIN_TOKEN` unset → bootstrap off, keys still work (the 503
path goes); token never logged or returned after creation; key `label` 1–100 chars and `role` other than
`author|moderator` → 400; failed auth limited per IP (30 per 15 min → 429, successes not counted, valid keys
never limited); **author** uploads limited per key (`AUTHOR_UPLOADS_PER_HOUR`, default 20 → 429; moderators and
bootstrap exempt — `publish:release` uploads ~13 archives per run); validation reads at most
`MAX_ENTRY_BYTES` (default 10 MiB) per manifest/scene entry and `MAX_ARCHIVE_ENTRIES` (default 20 000) entries
→ 400, not OOM — named constants, overridable by env.
**Depends on:** Phase 1 | **Unlocks:** Phase 3
**File scope:** `backend/**`, `docker-compose*.yml`, `.env.example`, `CLAUDE.md`, `docs/test-plan.md`
**Produces:** `req.principal = {role: 'author'|'moderator', keyId: number|null, label: string}`;
`authenticate`, `requireRole(role)`, `canEditScenario(principal, row)`; `audit_events(id, scenario_id NULL (no FK — history survives scenario deletion, like `scenario_sessions`),
actor_key_id NULL, actor_label, action, details JSONB, created_at)` + `audit.record(client, principal, action,
scenarioId?, details?)` (joins the caller's transaction); `GET/POST /api/keys`, `POST /api/keys/:id/revoke`
(POST returns `{id, label, role, token}` once); `GET /api/auth/me` → `{role, label, keyId}`.
**Security-sensitive:** yes
**Rollback:** migration `007` is additive; redeploying the previous build ignores the new tables and restores `ADMIN_TOKEN`-only access.

**File hints:** `backend/server.js:57-82` (auth), `backend/test/integration/auth-and-crud.test.js:40` (`GUARDED`),
`backend/test/helpers/db.js:48` (`truncateAll`), `backend/archive-validation.js` (uncapped `entryData`),
`backend/scripts/publish-release.mjs:190-208` (an `ADMIN_TOKEN` client).

**Done when:**
- [ ] DW-2.1: The route split is its own commit with the full backend suite green before and after.
- [ ] DW-2.2: Keys are stored only as SHA-256 and shown once; `/api/keys*` is moderator-only; `/api/auth/me` answers any valid principal and 403 for revoked.
- [ ] DW-2.3: The route table is enforced and pinned by table-driven tests (anonymous, unknown, revoked, author A, author B, moderator key, bootstrap).
- [ ] DW-2.4: The author field rules hold: forbidden fields and unknown category slugs → 400; author-created rows are unpublished and owned; upload into a published scenario → 403.
- [ ] DW-2.5: Every authenticated admin mutation writes one `audit_events` row inside the request's own transaction (rolled back with it); reads and telemetry write none.
- [ ] DW-2.6: Both rate limits and the validation caps behave as stated; `last_used_at` updates on use.
- [ ] DW-2.7: Migration `007` applies twice without error.

**Difficulty:** HIGH
**Uncertainty:** None.

### Phase 3: Publishing workflow and versions
**Model:** sonnet
**Skills:** aposd-designing-deep-modules, cc-defensive-programming, aposd-verifying-correctness
**Gate:** Standard

**Goal:** Statuses with moderator decisions, per-scenario archive history with rollback, §7's pending archive for
published scenarios, a draft preview the viewer can play, and GC aware of all of it.

**Scope:**
- IN: migration `008` (`status`, `moderator_note`, `submitted_at`, `scenario_versions`; backfill) and `009` (drop
  `is_published`, its own file); transition, version, from-archive and preview-by-version endpoints; an
  `isPublished` compatibility field until Phase 6 deletes the old admin; `publish-release.mjs` on the new
  endpoints; the viewer/service reading `/play/:id?draft=<sha256>`; GC references; tests.
- OUT: categories, previews, checks, bulk, dashboard (Phase 4); new UI.

**Constraints:** every new row starts as `draft` (it has no archive yet) — `publish-release.mjs` uploads, then
calls `approve`; `admin-golden-path.spec.ts:88` is updated to the same order. Transitions —
`submit`: draft|rejected → review (owner or moderator; needs a current version);
`withdraw`: review → draft (owner or moderator); `approve`: review|draft|rejected → published (moderator; needs a
current version); `reject {note?}`: review → rejected (moderator; default note "Потрібні уточнення від
модератора.", ≤2000 chars); `unpublish`: published → draft (moderator; an existing pending version stays pending); anything else → 409.
Archive upload — draft/rejected: new current (old → archived; any pending row deleted); review: 409
("Відкличте з перевірки"); published: moderator → new current, author → `pending` (replacing any earlier
pending). Version routes — `GET …/versions`: owner or moderator; `accept`, `restore`, `DELETE` of an archived
version: moderator; `reject` of a pending version (moderator) and `DELETE` of one's own pending version (owner)
**delete the row** — its object is left to GC; `from-archive`: author (owner = self, counts toward the author
upload limit) or moderator. Compatibility: responses carry `isPublished = status === 'published'`; a
moderator's PUT `{isPublished}` maps to approve/unpublish (so `true` on a row without an archive is now 409); `isPublished` in a POST is ignored. Published rows that are streaming-only (a `manifest_url`, no archive) get no version and keep `published`; re-approving one after an unpublish needs an archive first. The test helper `backend/test/helpers/db.js` (`CREATE TABLE`/`INSERT … is_published`, lines 39, 62) is rewritten to `status` — `009` breaks it otherwise.
**Edge cases:** `:vid` not of `:id` → 404; current version cannot be deleted; >50 versions → 409; two concurrent
approves → one 409; accept/restore are single transactions; `?version=` not 64-hex → 400; dedup re-upload refreshes
the object's mtime so GC cannot race it; the backfill reads `is_published IS TRUE` (the column is nullable);
`from-archive` takes the id from untrusted manifest data — it must match `^[a-z0-9][a-z0-9-]{1,99}$` (400 with a
hint to rebuild with ScenarioCreator otherwise, never a 500); a draft preview's exit goes back to the admin
`Файл` tab via a `returnTo` that must be a relative `/admin/…` path (a non-published scenario has no public page).
**Depends on:** Phase 2 | **Unlocks:** Phase 4
**File scope:** `backend/**`, `frontend/src/app/pages/viewer/**`, `frontend/src/app/services/scenario.service*`,
`frontend/src/app/services/admin.service*` (the session bearer the viewer sends), `frontend/src/app/player/**`,
`e2e/**`, `docs/test-plan.md`, `CLAUDE.md`
**Produces:** `status: 'draft'|'review'|'published'|'rejected'`, `moderatorNote`, `submittedAt` on admin rows;
`POST /api/scenarios/:id/{submit|withdraw|approve|reject|unpublish}`; `scenario_versions(id, scenario_id, sha256,
bytes, manifest_id, manifest_version, engine_version, uploaded_by_key_id, uploaded_at, state
'current'|'pending'|'archived', checks JSONB, test_run JSONB)`; `GET /api/scenarios/:id/versions`;
`POST …/versions/:vid/{accept|reject|restore}`; `DELETE …/versions/:vid`; `POST /api/scenarios/from-archive`
(multipart) → `{scenario, version, manifest: {id, name, version, entryPoint, resourceCount, engineVersion}, warnings}`
(draft, id = manifest id, 409 if taken); `GET /api/catalog/:id?version=<sha256>` → public projection,
`Cache-Control: no-store`; a non-published scenario needs its owner or a moderator (the viewer sends the session's bearer).
**Security-sensitive:** yes
**Rollback:** `008` is additive. `009` is the point of no return — take a `pg_dump` before deploying it; the
down-migration in its header is `ALTER TABLE scenarios ADD COLUMN is_published BOOLEAN DEFAULT true;
UPDATE scenarios SET is_published = (status = 'published');` (versions and pending state are not recoverable by it).

**File hints:** `backend/server.js:391` (`attachArchive`), `:470` (`referencedArchives` — the GC seam),
`backend/storage.js:151` (`classifyObjects`, ages by mtime), `backend/scripts/publish-release.mjs:190-208`;
`isPublished` readers to keep green via the compat field: `e2e/tests/ktx2.spec.ts:40`, `viewer.spec.ts:17`,
`archives-and-telemetry.test.js:434`, `catalog.test.js:241`.

**Done when:**
- [ ] DW-3.1: `008` and `009` apply twice without error; existing rows become `published`/`draft` with one `current` version; the catalog shows exactly the published ones.
- [ ] DW-3.2: The transition table holds for every (status × action × role), each success writing an audit event.
- [ ] DW-3.3: The upload-by-status rules hold; a pending archive leaves students on the old one until accept.
- [ ] DW-3.4: Accept, reject and author retract of a pending version; restore of an archived one; delete rules and `:vid` ownership.
- [ ] DW-3.5: `/play/:id?draft=<sha256>` plays that version for its owner/moderator (also for a scenario in review); anonymous access to a non-published scenario's version → 404.
- [ ] DW-3.6: `from-archive` creates a draft from a ZIP and reports its manifest; a taken id → 409.
- [ ] DW-3.7: GC keeps every object referenced by a scenario or any version; a deleted version's object becomes collectible under the existing mtime/`GC_MIN_AGE_MS` rule.
- [ ] DW-3.8: New rows start as `draft`; the old `/admin` (create → upload → publish), `publish:release` (dry run and real, upload then approve) and every existing suite stay green on the compatibility field.

**Difficulty:** HIGH
**Uncertainty:** None.

### Phase 4: Catalog management API
**Model:** sonnet
**Skills:** cc-defensive-programming, aposd-designing-deep-modules
**Gate:** Standard

**Goal:** The server side of the moderator's tools — categories, preview images, archive checks and contents,
test-run results, bulk actions, the dashboard, and the admin row data the queue needs.

**Scope:**
- IN: category CRUD + reorder + visibility; a second content-addressed store for previews (volume, nginx
  `^~ /previews/`, GC and `/api/admin/storage` over both stores); preview upload/remove; CSP `img-src` loses
  `https:`; static checks per version + re-run; contents listing; test-run intake; bulk; dashboard; extended
  admin rows; `/api/config` preview limits.
- OUT: UI (Phases 5–7).

**Constraints:** `imageUrl` changes through preview upload/remove (owner or moderator); in a PUT/POST only a
moderator may send it, and only as `''`, its current value, or a `/previews/…` path (the old admin form and
`publish-release.mjs:175` send it on every save); `backend/scripts/catalog-metadata.mjs:49`'s external Unsplash
URL is removed and migration `010` clears any stored external `imageUrl` (listing the rows in its log) before `img-src` drops `https:`. A hidden
category makes its scenarios unpublished to every public endpoint (list, summary, related, `/:id`, play); a
category in use cannot be deleted (409). Roles — `GET /api/categories`: any principal (authors pick from it,
hidden ones flagged); category mutations, bulk, test-run: moderator; preview upload/remove, contents, check
re-run: owner or moderator; dashboard and admin rows: any principal, scoped.
**Edge cases:** preview type by magic bytes (PNG/JPEG only; SVG, GIF, disguised files → 400), ≤5 MB, width
≥800 px, 16:10 ±5% else a warning; a file shorter than its header → 400; slug `^[a-z0-9-]{2,50}$`; test-run
numbers range-checked (TTFF 0–600 000 ms, FPS 0–1000, GPU 0–64 GiB, errors 0–100 000) and strings capped
(`engineBuild` 100, `userAgent` 300); bulk returns per-id results, each id in its own transaction; checks and
contents reuse Phase 2's caps.
**Depends on:** Phase 3 | **Unlocks:** Phases 5, 6, 7
**File scope:** `backend/**`, `nginx/**`, `Dockerfile.frontend`, `docker-compose*.yml`, `.env.example`,
`e2e/tests/csp.spec.ts`, `docs/test-plan.md`, `CLAUDE.md`
**Produces:** `GET/POST /api/categories`, `PUT/DELETE /api/categories/:slug`, `POST /api/categories/reorder {slugs}`;
`POST /api/scenarios/:id/preview` (multipart) → `{imageUrl, warnings}`, `DELETE …/preview`;
`GET …/versions/:vid/contents` → `{path, bytes, dir}[]`; `POST …/versions/:vid/checks` (re-run) →
`{ok, items: {level: 'error'|'warning'|'ok', label, note}[]}`; `POST …/versions/:vid/test-run {timeToFirstFrameMs,
avgFps, gpuMemoryBytes, consoleErrors, engineBuild, userAgent}` (moderator);
`POST /api/scenarios/bulk {ids, action: 'approve'|'unpublish'|'set-category'|'delete', category?}` →
`{results: {id, ok, error?}[]}` (moderator); `GET /api/admin/dashboard` → `{counts: Record<status, number>,
queueSize, activity: AuditRow[]}` scoped to the principal, where `AuditRow = {id, scenarioId: string|null,
scenarioTitle: string|null, actorLabel, action, details, createdAt}`; `GET /api/scenarios/:id/history` →
`AuditRow[]` (owner or moderator); admin rows gain `ownerLabel`, `pendingVersionId`,
`currentVersion: {id, sha256, bytes, checks: {errors, warnings}}`; `/api/config` gains `preview: {maxBytes, minWidth, aspect}`.
**Security-sensitive:** yes

**File hints:** `backend/storage.js` (`OBJECT_NAME` accepts only `<sha>.zip` — generalise per store),
the `^~ /scenarios/` location in the nginx server config (moved under `templates/` by Phase 1), `backend/archive-validation.js`, `backend/scripts/catalog-metadata.mjs:49`,
`backend/scripts/publish-release.mjs:175`.

**Done when:**
- [ ] DW-4.1: Category CRUD, reorder and visibility work for moderators; deleting a used category → 409; a hidden category's scenarios disappear from every public endpoint.
- [ ] DW-4.2: A valid PNG/JPEG preview is stored by hash and served from `/previews/`; invalid files → 400; GC and the storage report cover previews; `img-src` no longer allows `https:`.
- [ ] DW-4.3: Every new version carries check results; re-run refreshes them; contents lists files and sizes within the caps.
- [ ] DW-4.4: Test-run results are stored on the version; out-of-range or oversized values → 400.
- [ ] DW-4.5: Bulk reports per id; the dashboard and admin rows carry the stated fields, scoped (author → own scenarios).
- [ ] DW-4.6: `/api/config` returns the preview limits; the old `/admin` edit and `publish:release` still work under the `imageUrl` rule; backend and CSP suites green.

**Difficulty:** MEDIUM
**Uncertainty:** None.

### Phase 5: Admin UI — sign-in, shell, list, metadata and publication
**Model:** sonnet
**Skills:** aposd-designing-deep-modules, aposd-verifying-correctness, cc-defensive-programming
**Gate:** Standard

**Goal:** Replace the old `/admin` with the prototype's admin frame and the screens every author uses daily:
sign-in, shell, scenario list, and the Метадані and Публікація tabs.

**Scope:**
- IN: `/admin/login` (2e — no demo codes, no "12 годин"); shell (sidebar with role-aware items and badges, user
  card, sign-out; narrow top bar + burger drawer); list (2f: status chips with counts, category filter, table,
  selection + bulk bar for moderators); Метадані (2g: fields with the 0/160 counter, features editor, icon picker,
  preview upload with warnings, live card = catalog card, «Готовність до публікації»; `author` editable by
  moderators only); Публікація (2j: status, submit/withdraw, approve/return with note/unpublish, «Відкрити в
  каталозі», history from audit); the old admin moved to `/admin/legacy` (moderators only — it is the only
  upload UI until Phase 6); e2e API helpers parameterised by key instead of the hardcoded `ADMIN_TOKEN`; unit + e2e.
- OUT: Файл and Перевірка tabs, wizard, deleting the old admin (Phase 6); moderator pages and test run (Phase 7).

**Edge cases:** unsaved edits survive tab switches and warn on leaving; 401/403 mid-session → login with the
reason; buttons follow the role but the API stays the authority; long author text never breaks layout.
**Depends on:** Phase 4 | **Unlocks:** Phase 6
**File scope:** `frontend/src/app/pages/admin/**`, `frontend/src/app/services/**`, `frontend/src/app/models/**`,
`frontend/src/app/ui/**`, `frontend/src/app/app.routes.ts`, `e2e/**`, `docs/**`, `CLAUDE.md`
**Produces:** `<vl-admin-shell>` with child routes `/admin`, `/admin/scenarios`, `/admin/scenarios/:id/:tab`
(`meta|files|checks|publish`), `/admin/upload`, `/admin/queue`, `/admin/categories`, `/admin/access` (the last
four as slots); `AdminApi` (root service) with one method per Phase 2–4 route, e.g. `me()`,
`listScenarios()`, `updateScenario(id, patch)`, `transition(id, action, note?)`, `uploadPreview(id, file)`,
`versions(id)`, `history(id)`, `bulk(ids, action, category?)`, `dashboard()`, `categories()`, `keys()`;
`<vl-icon-picker [value] (valueChange)>`; `<vl-scenario-meta-form [scenario] [role] (saved)>` — the Метадані form,
reused by Phase 6's wizard.
**Security-sensitive:** yes

**File hints:** `frontend/src/app/pages/admin/*`, `frontend/src/app/services/admin.service.ts` (token storage to keep).

**Done when:**
- [ ] DW-5.1: Sign-in by code shows name and role from `/api/auth/me`; the code lives only in `sessionStorage` and is cleared on sign-out; the old admin answers only at `/admin/legacy`, for moderators.
- [ ] DW-5.2: The list filters by status and category, shows status pills; moderators get the bulk bar and its results.
- [ ] DW-5.3: Метадані saves fields, up to six features and a preview; the live card matches the catalog card; the readiness list reflects missing description/preview/archive.
- [ ] DW-5.4: Публікація performs each allowed transition for the role and shows the audit history.
- [ ] DW-5.5: Unsaved-changes guard and mid-session 401/403 behave as stated; at 390 px the shell uses the drawer; e2e covers sign-in → edit → submit.

**Difficulty:** HIGH
**Uncertainty:** None.

### Phase 6: Admin UI — files, checks and upload wizard
**Model:** sonnet
**Skills:** aposd-verifying-correctness, cc-defensive-programming
**Gate:** Standard

**Goal:** The archive side of authoring — the Файл and Перевірка tabs and the four-step upload wizard.

**Scope:**
- IN: Файл (2h: current archive, replace by drag-and-drop with progress and cancel, pending banner with
  `/play/:id?draft=<sha256>` link and accept/reject (moderator) or retract (owning author), versions table with restore/delete by
  role, contents tree, large-archive warning over 50 MB); Перевірка (2i: stored static checks, re-run, stored
  test-run results against the norms — ≤5 s, ≥30 FPS, ≤1 GB, 0 errors); wizard (2l: Файл → Метадані → Перевірка →
  Публікація over `from-archive`, reusing `<vl-scenario-meta-form>`); deletion of the old admin and
  `/admin/legacy`; unit + e2e.
- OUT: running a test (Phase 7).

**Edge cases:** cancelling an upload aborts it and leaves no half-created scenario; leaving the wizard after
step 1 keeps the draft (listed); a 409 for an upload in review explains withdrawal; an archive over
`maxArchiveBytes` is refused before upload.
**Depends on:** Phase 5 | **Unlocks:** Phase 7
**File scope:** `frontend/src/app/pages/admin/**`, `frontend/src/app/services/**`, `frontend/src/app/models/**`, `e2e/**`, `docs/**`
**Produces:** routes `/admin/scenarios/:id/files`, `/admin/scenarios/:id/checks`, `/admin/upload` filled; a
`(runTest)` output on the Перевірка tab that Phase 7 wires.
**Security-sensitive:** yes — renders manifest fields and archive paths from untrusted archives (text only) and uploads files.

**File hints:** `frontend/src/app/services/admin.service.ts:92` (upload with progress), `frontend/src/app/pages/admin/`
(the legacy admin to delete), `e2e/tests/admin-golden-path.spec.ts`.

**Done when:**
- [ ] DW-6.1: Файл replaces the archive with progress and cancel, shows versions with role-appropriate restore/delete, and the pending banner with its preview link and actions.
- [ ] DW-6.2: Перевірка shows stored checks and test-run results with the norms and re-runs checks.
- [ ] DW-6.3: The wizard turns a ZIP into a draft with prefilled manifest fields, then saves or submits it; the size guard and the 409 message work.
- [ ] DW-6.4: e2e covers wizard → submit and pending accept from the Файл tab; the old admin and `/admin/legacy` are gone.

**Difficulty:** MEDIUM
**Uncertainty:** None.

### Phase 7: Admin UI — moderation
**Model:** sonnet
**Skills:** aposd-verifying-correctness, cc-defensive-programming
**Gate:** Standard

**Goal:** The moderator's pages — queue, dashboard, categories, access codes — and the in-browser test run, then
the end-to-end author → moderator path.

**Scope:**
- IN: queue (2k: Очікують/Повернуті/Опрацьовані from the extended admin rows, check chips, decide inline, recent
  decisions); dashboard (role-aware counts, activity, quick actions); Напрями (2m); Доступ (issue with a one-time
  token dialog + copy, list with last use, revoke with confirm); «Тестовий запуск» on Перевірка via
  `PlayerHost.measure()` saved through the test-run API; docs (`CLAUDE.md`, `Readme.md`, the admin
  client-side-filter exception in `docs/code-standards.md`).
- OUT: anything listed out of scope in Constraints.

**Edge cases:** a closed token dialog can never show the token again; revoking one's own key signs out; a test
run that errors stores the error instead of numbers; metrics are advisory (they come from the untrusted realm)
and the host truncates `engineBuild`/`userAgent` to the server's caps (100/300) before posting; a reorder
conflict re-fetches.
**Depends on:** Phase 1, Phase 4, Phase 6 | **Unlocks:** none
**File scope:** `frontend/src/app/pages/admin/**`, `frontend/src/app/services/**`, `frontend/src/app/player/**`,
`e2e/**`, `docs/**`, `CLAUDE.md`, `Readme.md`
**Produces:** none (terminal) — the user-visible moderator workflow.
**Security-sensitive:** yes

**File hints:** `frontend/src/app/player/protocol.ts` (`measure`/`metrics` from Phase 1), the Перевірка tab's
`(runTest)` output from Phase 6, `docs/code-standards.md` § Forbidden Patterns (the client-side-filter rule to amend).

**Done when:**
- [ ] DW-7.1: The queue lists submitted scenarios with their check summary; publish/return there update status and history.
- [ ] DW-7.2: The dashboard shows role-scoped counts and activity.
- [ ] DW-7.3: Categories can be added, reordered, hidden and (when empty) deleted from the UI.
- [ ] DW-7.4: A moderator issues a key (token shown once), sees last use, and revokes it; the revoked key stops working.
- [ ] DW-7.5: A test run records time to first frame, average FPS, GPU memory and console errors with device and engine build.
- [ ] DW-7.6: E2E: moderator issues an author key → author uploads and submits → moderator publishes → it is in the
  catalog → author uploads a new archive → students still get the old one until the moderator accepts.

**Difficulty:** MEDIUM
**Uncertainty:** None.

---
## Test Coverage
**Level:** 100% (default — the coverage question went unanswered at planning): unit tests for every new or
changed routine, and every DW has at least one named test below.

## Test Plan
Backend = `node:test` integration against the test Postgres; frontend = vitest specs; e2e = Playwright on the stack.
New scenarios get numbers in `docs/test-plan.md` and are cited in each spec header.

**Phase 1** — done by the player-isolation plan (its Test Plan and e2e carry the checks).

**Phase 2**
- [ ] Route split: full suite green on the commit before and after (DW-2.1)
- [ ] Key issue returns the token once; DB holds a 64-hex hash; list never includes tokens; captured logs contain no token; `/me` for author, moderator, bootstrap; revoked → 403 (DW-2.2)
- [ ] Route table: {anonymous, unknown, revoked, author A, author B, moderator key, bootstrap} × every admin route → expected 401/403/200 (DW-2.3)
- [ ] Dirty headers: `Bearer ` empty, 10 KB header, lowercase `bearer`, duplicated header; `ADMIN_TOKEN` unset → keys work (DW-2.3)
- [ ] Author field rules: each forbidden field → 400; unknown `category` slug → 400 and no category row created; `categoryLabel` ignored; POST by author → unpublished, owner set, `author` = label; upload into published → 403 (DW-2.4)
- [ ] One audit row per authenticated mutation, rolled back with a failed transaction; none for reads/telemetry (DW-2.5)
- [ ] Boundary: 29/30/31 failed auths → 403/403/429; successes don't count; author 20/21 uploads per hour → 200/429 (a `from-archive` upload counts), a moderator's 21st → 200; `last_used_at` moves (DW-2.6)
- [ ] Dirty archives: manifest entry of 10 MiB + 1 byte, 20 001 entries, zip bomb ratio → 400 without memory growth beyond the cap (DW-2.6)
- [ ] `POST /api/keys {role: 'admin'}`, label empty / 101 chars → 400; migration `007` twice (DW-2.2, DW-2.7)

**Phase 3**
- [ ] `008`/`009` twice; seeded DB → statuses + one current version per archived row; catalog count unchanged (DW-3.1)
- [ ] Transition matrix: every (from-status × action × {owner author, other author, moderator, anonymous}) → 200/403/409 with audit rows; new rows start as `draft` (DW-3.2, DW-3.8)
- [ ] Dirty: two concurrent approves → one 409; reject note 2000/2001 chars; reject without note → default text (DW-3.2)
- [ ] Upload by status: draft, rejected, review (409), published by moderator (current) and by author (pending; a second replaces it); `/api/catalog/:id` keeps the old URL until accept (DW-3.3)
- [ ] Pending accept/reject (row deleted)/owner retract; another author cannot retract it; unpublish keeps a pending row; a draft upload deletes it; restore archived; delete current → 409; `:vid` of another scenario → 404; 51st version → 409; version routes × role table (DW-3.4)
- [ ] `?version=`: 63/65 chars or non-hex → 400; foreign hash → 404; non-published scenario anonymous → 404, owner/moderator → 200; `Cache-Control: no-store`; e2e `/play/:id?draft=` plays and its exit navigates to the validated `returnTo` (the tab itself arrives in Phase 6); `returnTo` of `https://evil.example` or `//evil` is ignored (DW-3.5)
- [ ] `from-archive`: valid ZIP → draft with manifest fields, owned by the author; taken id → 409; manifest id of 101 chars, with `/`, with spaces, reverse-domain → 400; invalid ZIP → 400 with no row left (DW-3.6)
- [ ] GC: archived and pending objects survive; deleted version's object collectible once older than `GC_MIN_AGE_MS`; dedup re-upload refreshes mtime (DW-3.7)
- [ ] Old admin publish toggle, `publish:release --dry-run` and real run, `ktx2`/`viewer` e2e green on `isPublished` compat (DW-3.8)

**Phase 4**
- [ ] Categories: CRUD, reorder, hide → scenarios gone from list/summary/related/`:id`; delete used → 409; slug 1/2/50/51 chars and uppercase (DW-4.1)
- [ ] Preview accepting: PNG and JPEG at 800 px, 16:10, 5 MB exactly; 16:9 → stored with a warning (DW-4.2)
- [ ] Preview dirty: PNG named `.jpg`, JPEG claiming `image/png`, SVG, GIF, file shorter than its header, 5 MB + 1 byte, 799 px → 400; author PUT with any `imageUrl` → 400; moderator PUT with an external URL → 400, with `''`/current/`/previews/…` → 200; stored external URLs cleared by migration `010` (run twice); CSP header lacks `https:` in `img-src` (DW-4.2, DW-4.6)
- [ ] Phase 4 route × role table (categories, preview, contents, checks, test-run, bulk, dashboard, history) (DW-4.1–4.5)
- [ ] Checks on upload, re-run refresh; contents of a nested archive; caps respected (DW-4.3)
- [ ] Test-run accepting and dirty bodies (negative, NaN, 10^12 ms, 101-char build, missing field) (DW-4.4)
- [ ] Bulk mixed ids → per-id results; dashboard and admin rows for author vs moderator (DW-4.5)
- [ ] `/api/config` preview limits; old-admin save and `publish:release` run green after the `imageUrl` rule (DW-4.6)

**Phase 5**
- [ ] Login: author and moderator codes, revoked code, empty input; sign-out clears `sessionStorage`; `/admin/legacy` → moderators only (DW-5.1)
- [ ] List filters and pills; bulk bar only for moderators with per-id result display (DW-5.2)
- [ ] Метадані: save; six features max; icon picker; preview upload + warning; live card equals catalog card; readiness list; `author` read-only for authors (DW-5.3)
- [ ] Публікація: each transition per role; history entries (DW-5.4)
- [ ] Unsaved edits survive a Метадані → Публікація → Метадані switch and warn on leaving; a 300-char unbroken title keeps the layout; 401 mid-session → login with reason; 390 px drawer; e2e sign-in → edit → submit with the archive seeded through the key-parameterised API helper (DW-5.5)

**Phase 6**
- [ ] Файл: replace with progress and cancel; versions by role; pending banner link and actions (DW-6.1)
- [ ] Перевірка: checks and test-run results vs norms; re-run (DW-6.2)
- [ ] Wizard: ZIP → draft with manifest prefill → save/submit; leaving after step 1 keeps the draft in the list; cancel during upload leaves no row; oversize refused client-side; 409 message for review; a manifest name with `<script>` renders as text (DW-6.3)
- [ ] e2e wizard → submit; pending accept via Файл; `/admin/legacy` → not found (DW-6.4)

**Phase 7**
- [ ] Queue tabs, inline decisions, recent decisions (DW-7.1)
- [ ] Dashboard counts by role (DW-7.2)
- [ ] Categories UI: add, reorder, hide, delete disabled when used; reorder conflict re-fetches (DW-7.3)
- [ ] Access: token visible once, copy, revoke own key → signed out, revoked key rejected (DW-7.4)
- [ ] Test run: metrics saved and shown; a crashing fixture stores an error; an engine build string of 500 chars is truncated to 100 before posting (DW-7.5)
- [ ] e2e full author → moderator path including pending archive (DW-7.6)

**Manual** (`docs/manual-browser-checks.md`, supports DW-5.5, DW-7.x): every admin screen beside the prototype
at 1440 px and 390 px. (The hostile-archive check in Firefox and Safari belongs to the player-isolation plan.)

## Assumptions
| Assumption | Confidence | Verify Before Phase | Fallback If Wrong |
|---|---|---|---|
| `MAX_ENTRY_BYTES` 10 MiB / `MAX_ARCHIVE_ENTRIES` 20 000 exceed every real scenario's largest manifest/scene entry and entry count | MED | Phase 2 (measure the archives store and the current ScenarioCreator release) | Raise the defaults to 2× the measured maximum |
| The editor's Publish can send `Authorization: Bearer <key>` | HIGH (§7) | Phase 2 | Adjust the editor's dialog; no platform change |
| `publish-release.mjs` is the only script writing `isPublished`; `import-release-assets.mjs` only PUTs `manifestUrl` | HIGH (checked) | Phase 3 | Move any other writer onto the transition endpoints |
| Production rows have no external `imageUrl` (PLAN §2.4), but `catalog-metadata.mjs` ships an Unsplash URL for `solar-system` | MED | Phase 4 (`SELECT`) | The migration clears external URLs and logs them; the owner uploads previews |
| PNG/JPEG dimensions can be read from headers without decoding | HIGH | Phase 4 | Add a small, maintained header-parsing dependency |

## Decision Log
| Decision | Alternatives Considered | Rationale | Phase |
|---|---|---|---|
| Split `server.js` by actor first, as its own commit | Add routes in place | Refactor separate from feature; four actors in one file | 2 |
| Field-level write rules for authors | Route-level only | `PUT {scenarioUrl}` would bypass moderation; `imageUrl` would be a tracking beacon | 2 |
| `audit_events` (not per-scenario only) | `scenario_events` | Key issue/revoke has no scenario | 2 |
| Uploads during review → 409 (withdraw first) | Approve bound to a version id | Simplest rule that stops publishing unseen bytes | 3 |
| Every new row starts as `draft`; `publish:release` uploads then approves | Moderator rows default to published | A published row without an archive would violate "approve needs a current version" | 3 |
| Authors pick only existing categories | Release 1's create-on-unknown-slug for everyone | Category creation is a moderator tool (2m) | 2 |
| Author-only upload limit | Limit every key | `publish:release` uploads ~13 archives per run under the bootstrap key | 2 |
| Old admin kept at `/admin/legacy` until Phase 6 | Delete it in Phase 5 | It is the only upload UI until Phase 6's Файл tab and wizard exist | 5–6 |
| `scenario_versions` with a `pending` state | `pending_archive_sha256` column (§7 wording) | One mechanism for draft, history and rollback | 3 |
| Drop `is_published` in its own migration `009` | Keep both columns in sync | Two sources of truth drift; only one step is irreversible | 3 |
| Draft preview: owner/moderator for non-published, public for a published scenario's versions | Public by hash for everything (§7) | Dedup can make a draft's hash public | 3 |
| `from-archive` creates the draft (id = manifest id) | Client-side ZIP reading; inspect endpoint + second upload | ScenarioCreator emits slugs as manifest ids; one upload | 3 |
| Hidden category hides its scenarios everywhere | Hide only the chip | Otherwise it is the "unlisted" status the owner ruled out | 4 |
| `imageUrl` only via upload; `img-src` drops `https:` | Keep URL field | Closes the beacon; tightens CSP | 4 |
| Admin list filtered client-side | Server paging | Unpaged admin list; the server-side rule targets the paged public catalog (documented exception) | 5 |
| Admin UI in three phases | Two phases | Shell/list/meta, files/wizard and moderation are each a reviewable deliverable | 5–7 |

---
## Notes
- Do not issue author keys in production until the player-isolation plan (its Phase 5) is deployed; bootstrap `ADMIN_TOKEN` keeps working throughout.
- **Do not release between Phase 5 and Phase 6:** `/admin/legacy` is moderators-only, so authors would have no upload UI in that window.
- **Residual risk:** `/editor/` shares the platform origin (`nginx/editor.conf`); an editor preview of an imported
  archive still runs there. Moving the editor's preview onto the player is the editor's task — add it to `PLAN.md` §3.
- The editor plan's "migration 006" for `publish_keys` lands here as `007`; update `WebEngineTSEditor/docs/unity-editor-plan.md` §7 when this ships.
- `PLAN.md` §2.6 (publish keys) is closed by this plan — move it to `CHANGELOG.md` after release. §2.9 (isolation) was closed by the player-isolation plan.
- The `isPublished` compatibility field can be removed once nothing reads it (after Phase 6); not scheduled here.
- Safari's sandboxed-iframe behaviour is the least predictable; the manual check covers it.
---
## Decided During Build
_Filled by /code-foundations:build — one row per decision an agent made or question it raised:_
| # | Phase | Decision or question | Source | Status |
---
## Execution Log
_To be filled during /code-foundations:build_

### Phase 1: Player isolation (Gate: Standard)
- [x] SKIPPED — completed by `.code-foundations/plans/2026-10-24-player-isolation.md` (virtual-lab 9b0ae09, 2bf3a12; WebEngineTS 02fdc1f)
