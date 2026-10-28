<!-- base-commit: 709494ce6a1c2c42f08b5da9c319065a1fc52392 -->
<!-- generated: 2026-10-23 -->

# Code Standards — virtual-lab

Project-specific conventions only. Architecture, the engine-integration rules and the CSP rationale
live in `CLAUDE.md`; this file is how code is *written* here.

## Forbidden Patterns

**No zone.js, no `NgZone`, no `fakeAsync()`** — the app is zoneless (`provideZonelessChangeDetection()`):
```typescript
// BAD — a no-op in a zoneless app, and fakeAsync() throws outright
this.ngZone.run(() => this.progress = 50);
it('debounces', fakeAsync(() => { tick(300); }));

// GOOD — a signal write is what schedules a repaint; vitest fake timers drive time
this.progress.set(50);
vi.useFakeTimers(); vi.advanceTimersByTime(300);
```

**No plain-field UI state** — state that the template reads must be a signal:
```typescript
// BAD — assigned from an async callback, never repaints (the viewer ring sat at 0% this way)
downloadPercent = 0;
onProgress = (p: DownloadProgress) => { this.downloadPercent = p.percent; };

// GOOD — from catalog.component.ts: signals, derived with computed, read straight off services
readonly selectedCategory = signal('all');
readonly scenarios = this.scenarioService.scenarios;   // service exposes .asReadonly()
```

**No client-side filtering/sorting/paging of catalog data** — the API pages, so a client filter
only sees one page:
```typescript
// BAD
readonly visible = computed(() => this.scenarios().filter(s => s.category === this.cat()));

// GOOD — from scenario.service.ts:100 — every filter is a query parameter
let params = new HttpParams().set('limit', String(PAGE_SIZE)).set('offset', String(offset));
if (category && category !== 'all') params = params.set('category', category);
```

**Exception: the admin lists are filtered on the client.** `/admin/scenarios`, the moderation queue and the
dashboard read the *unpaged* `GET /api/admin/scenarios` (the whole set the principal may see), so a client filter sees
everything; the rule above exists for the *paged* public catalog. If the admin list ever becomes paged, its filters move
to the server in the same change.

**No imports from `three` or engine internals** — the app imports only `from 'WebEngineTS/player-host'`
(never the bare `'WebEngineTS'`: `check-csp-assumptions` fails the build on it, since the page has no import
map and the engine runs in the player frame); a second Three.js breaks the engine's `instanceof` checks. No engine workaround in this repo: write it up in
`docs/upstream/webenginets.md` + `../../.claude-shared/ENGINE-GAPS.md` instead.

**No schema change in `db/init.sql`** — it runs only on an empty volume. New DDL goes in
`backend/migrations/NNN_name.sql`, idempotent (`IF NOT EXISTS`), with a header comment saying why.

## Code Examples

### Express route
```javascript
// DO — from backend/server.js:129. Parse/clamp input with small named helpers, bound parameters
// only, Ukrainian user-facing error, English log line with route prefix, no stack to the client.
app.get('/api/catalog', async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const pattern = query ? `%${escapeLikePattern(query)}%` : null;
  try {
    const { rows } = await pool.query(`SELECT ... WHERE ($2::text IS NULL OR title ILIKE $2 ESCAPE '\\')`, [category, pattern]);
    res.json({ version: '1', scenarios: rows, total, limit, offset });
  } catch (err) {
    console.error('[API] GET /api/catalog error:', err.message);
    res.status(500).json({ error: 'Не вдалося завантажити каталог' });
  }
});

// DON'T — string-built SQL, raw error to the client, English message to a student
app.get('/api/catalog', async (req, res) => {
  const rows = await pool.query(`SELECT * FROM scenarios WHERE title LIKE '%${req.query.q}%'`);
  res.json(rows.rows);
});
```

### Angular service call
```typescript
// DO — from admin.service.ts: async/await over firstValueFrom, inject(), readonly signals out
async listScenarios(): Promise<AdminScenario[]> {
  const response = await firstValueFrom(
    this.http.get<{ scenarios: AdminScenario[] }>('/api/admin/scenarios', { headers: this.authHeaders() })
  );
  return response.scenarios ?? [];
}

// DON'T — subscribe in a component and keep a Subscription to clean up
this.http.get(url).subscribe(r => this.items = r);
```
Exception: upload progress uses `observe: 'events'` + `subscribe` (`AdminService.uploadArchive`)
because `fetch` cannot report upload progress.

## Error Handling

- **Backend:** each route wraps its body in `try/catch`; `console.error('[AREA] …', err.message)`;
  responds `{ error: '<Ukrainian message>' }` with 4xx/5xx. Auth middleware answers 401 (no
  credential) / 403 (unknown or revoked code, or a role/ownership refusal) / 429 (too many failed
  attempts). It no longer answers 503: an unset `ADMIN_TOKEN` only switches the bootstrap code off.
- **Frontend:** services catch, set an `_error` signal, and keep state consistent on failure
  (`scenario.service.ts:122`); `AdminService.describeError()` maps `HttpErrorResponse` to the
  server's own message.
- **Telemetry never throws** — failures are swallowed (`telemetry.service.ts`) because telemetry
  must never break playback.
- **Every temp-file path releases in `finally`** (`POST /api/scenarios/:id/archive`).
```typescript
// From scenario.service.ts — error signal + consistent state + log
} catch (err) {
  this._error.set(err instanceof Error ? err.message : 'Не вдалося завантажити каталог');
  if (!append) { this._scenarios.set([]); this._total.set(0); }
  console.error('[ScenarioService] Catalog load failed:', err);
} finally {
  this._loading.set(false);
}
```

## Imports & Dependency Direction

- Frontend: Angular → rxjs → local (`../../models`, `../../services`), blank line between groups.
  `pages/*` import `services/*` and `models/*`; services never import pages. No barrel files.
- Backend: `node:` builtins → packages → local modules (`./storage`, `./archive-validation`).
  CommonJS (`require`) in `backend/*.js`; scripts under `backend/scripts/` are `.mjs`.
- The engine is the only external runtime dependency of the viewer, and the page never bundles or
  imports it: the app imports only `WebEngineTS/player-host`, and the engine runs in the sandboxed
  player frame (no import map on `/`).
```javascript
// backend/server.js:3
const crypto = require('node:crypto');

const express = require('express');
const { Pool } = require('pg');

const { runMigrations } = require('./migrations');
const storage = require('./storage');
```

## Testing Patterns

- **Backend:** `node:test` + `node:assert/strict` + `supertest`, run serially
  (`--test-concurrency=1`). Integration tests hit a **real Postgres** (`docker-compose.test.yml`,
  :55432) — no DB mocks — and self-skip when it is unreachable via `skipUnlessDb(t)`.
- Schema in tests = `prepareSchema()` (baseline table + `runMigrations`); data = `seedScenarios()`,
  `truncateAll()` from `test/helpers/db.js`. A new table must be added to `truncateAll`.
- Auth coverage is a table of guarded routes — add every new admin route to it:
```javascript
// backend/test/integration/auth-and-crud.test.js:40
const GUARDED = [
  ['post', '/api/catalog'],
  ['get', '/api/admin/scenarios'],
  ['post', '/api/scenarios/solar-system/archive'],
];
```
- **Frontend:** vitest via `ng test`; `TestBed` with `provideHttpClient()` +
  `provideHttpClientTesting()`; fixtures from a local factory with overrides
  (`scenario(id, overrides)` in `catalog.component.spec.ts:17`). After `http.expectOne(...).flush()`
  do `await Promise.resolve()` before asserting — signal state settles in a microtask.
- Each spec file header cites the `docs/test-plan.md` scenario numbers it covers.
- **E2E:** Playwright in `e2e/`, against the running stack and a published catalog; helpers in
  `e2e/helpers/{api,engine}.ts`. Specs select by CSS class (`.scenario-card`, `.filters-bar button`)
  and ARIA state (`aria-pressed`) — markup changes must update them in the same change.

## Naming Conventions

- Files: `kebab-case.component.ts|html|scss`, `*.service.ts`, `*.model.ts`; backend modules
  `kebab-case.js`; migrations `NNN_snake_case.sql`.
- Every source file starts with a path comment: `// path: src/app/...` (frontend) or
  `// backend/...` (backend).
- Signals: private writable `_name`, public `name = this._name.asReadonly()`; booleans `is*`/`has*`.
- Module constants `UPPER_SNAKE` with a one-line doc comment (`SEARCH_DEBOUNCE_MS`, `PAGE_SIZE`).
- DB columns `snake_case`, aliased to camelCase in SQL (`image_url AS "imageUrl"`), never mapped in JS.
- Section banners: `// ==================== NAME ====================` in TS,
  `// ── METHOD /path ──` in `server.js`.
- Language: UI strings and API error messages Ukrainian; identifiers and new comments English.

## File Organization

```
frontend/src/app/
├── pages/<page>/        # one standalone component per route: .ts/.html/.scss/.spec.ts together
├── services/            # root-provided services holding signal state; .spec.ts beside
├── models/              # interfaces only (platform model, not the engine's manifest types)
└── app.routes.ts        # lazy loadComponent per route
frontend/src/assets/     # engine standalone build is copied here by angular.json, basis/ committed
backend/
├── server.js            # all routes (sectioned)
├── <concern>.js         # storage, migrations, archive-validation, player-formats
├── migrations/NNN_*.sql
├── scripts/*.mjs        # CLI: publish-release, import-release-assets, verify-ktx2
└── test/{unit,integration,helpers}/
e2e/tests/*.spec.ts
```
New page → `pages/<name>/` + a lazy route. New backend concern → its own module required by
`server.js`, unit-tested in `test/unit/`.

## Technology Decisions

- Angular 21 standalone + `OnPush` everywhere; `inject()` not constructor injection.
- SCSS per component plus `src/styles.scss` for the reset; no UI library, no Tailwind.
- Express 4 + `pg` with hand-written SQL; no ORM, no query builder.
- Admin auth is a bearer token compared with `crypto.timingSafeEqual` after a length check
  (`tokensMatch`, `server.js:57`); the browser keeps it in `sessionStorage`.
- Archives are content-addressed files on a volume, served by nginx; Express never streams them.
- `npm install`, not `npm ci`, in `Dockerfile.frontend` (Windows lockfile vs Alpine wasm fallback).
- CSP in `nginx/csp.conf` is measured per directive; any new origin, inline script or font source
  is a CSP change with a test (`e2e/tests/csp.spec.ts`).

## Exemplar Files

**`frontend/src/app/services/scenario.service.ts`** — signal state with readonly views and
`computed`, server-side filter params, error signal + consistent reset, abortable streamed download.

**`frontend/src/app/pages/catalog/catalog.component.ts`** — OnPush standalone page reading service
signals directly, debounced search, accessible modal (focus move, trap, restore).

**`backend/server.js` `GET /api/catalog` (line 129)** — input parsing helpers, bound parameters,
`Promise.all` of independent queries, camelCase aliases in SQL, Ukrainian error contract.

**`backend/migrations/003_scenario_sessions.sql`** — migration header explaining the deliberate
design choices (no FK on purpose), idempotent DDL, partial index.
