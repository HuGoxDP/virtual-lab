# Discovery + Design: Phase 2 - Keys, roles and authorization

## Files Found
- `backend/server.js` (927 lines, all routes), `archive-validation.js` (uncapped `zip.entryData`), `storage.js`, `migrations.js`, `catalog-input.js`, migrations 001-006.
- Tests: `test/integration/{auth-and-crud,archives-and-telemetry,archive-limit,catalog-api,catalog}.test.js`, `test/unit/*`, `test/helpers/{db,fixtures}.js` (`truncateAll` lists tables explicitly).
- `scripts/publish-release.mjs`, `import-release-assets.mjs` use `ADMIN_TOKEN` as a bearer client (bootstrap principal keeps working).

## Current State
Single `ADMIN_TOKEN`, `requireAdmin` (503 unset / 401 no Bearer / 403 mismatch). `inTransaction` exists and is used by POST/PUT catalog only; DELETE and archive attach use bare pool queries. `categories` table has `is_visible`.

## Gaps
- Baseline measured on this HEAD: first full run 346/348 (flake: `archive upload rejects bad input without leaking temp files`, the 404 subtest — the handler's `finally` unlinks the temp file *after* `res.json` has been flushed, so the test can read `tmp/` before the unlink; pre-existing race, passes alone and on rerun). Second full run: **348/348** (the plan's baseline).
- Assumption check (archive caps): measured 17 ScenarioCreator release ZIPs plus the 12 objects in the dev stack's `VlLocalBackend` store: max entries **31**, largest manifest/scene entry **3 059 bytes**, max compression ratio 4.1. Defaults (10 MiB / 20 000) exceed the measured maxima by >3 000x and >600x; no change to the defaults needed.
- Assumption check (editor sends Bearer): HIGH confidence, unchanged; `Authorization: Bearer` is already the platform's only scheme.

## Code Standards
Path comment on every file; CommonJS; Ukrainian user-facing errors, English logs `[AREA]`; migrations idempotent with a why-header; named UPPER_SNAKE constants; new table into `truncateAll`; spec headers cite `docs/test-plan.md` numbers; auth tests are table-driven.

## Test Infrastructure
`node:test` + supertest against real Postgres :55432, serial. Run with the env in the dispatch prompt.

## DW Verification (audited against the code and tests on the final tree)

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | Route split is its own commit, suite green before and after | COVERED | commits `6bc48e7` (split) and `6ee54c4` (transactions); 348/348 before and after the split |
| DW-2.2 | Keys SHA-256 only, shown once; /api/keys* moderator-only; /me for any principal, 403 revoked | COVERED | scenario 178 `keys.test.js` (issue once, 64-hex hash, list has no token/hash, log capture, /me x3, revoke, role/label 400s, author 403); 186 `sha256Hex` |
| DW-2.3 | Route table pinned by table-driven tests | COVERED | 179 `route-table.test.js` (7 callers x 12 routes, denied call leaves state), 180 dirty headers (empty, bare, Basic, lowercase, double space, 10 KB, duplicated, ADMIN_TOKEN unset); 186 `requireRole`, `canEditScenario` |
| DW-2.4 | Author field rules | COVERED | 181 `author-rules.test.js` (each forbidden field on POST and PUT, unknown slug 400 with no category row, categoryLabel ignored, owner/unpublished/author label, other author 403, upload published 403); 186 `forbiddenAuthorFields` |
| DW-2.5 | One audit row per authenticated mutation, in the transaction | COVERED | 182 `audit.test.js` (per route, reads/telemetry/dry-run/refused none, forced rollback, history outlives delete) |
| DW-2.6 | Both rate limits, validation caps, last_used_at | COVERED | 183 `rate-limits.test.js` (29/30/31, successes uncounted, valid key never limited, author 20/21, moderator and bootstrap 21st, last_used_at); 184 `archive-caps` unit + integration (10 MiB+1, 20 001 entries, lying bomb, EOCD count); 186 `createWindowCounter`, `limitAuthorUploads`, `parsePositiveInt` |
| DW-2.7 | Migration 007 twice | COVERED | 185 `migration-007.test.js` (twice, from scratch, constraints) |

**All items COVERED:** YES (DW count 7 = prompt's 7)

## Design Decisions
- **Split by concern (actor):** `db.js` (pool, `inTransaction`, `scenarioExists`), `config.js`, `auth.js`, `routes/{catalog-public,catalog-admin,archives,storage-admin,telemetry,health}.js`; `server.js` keeps wiring, bootstrap/shutdown and its exact exports. Route paths stay absolute inside each Router, so mounting order cannot change behaviour.
- **Principal:** `authenticate` resolves `Authorization: Bearer` to `req.principal` (bootstrap `ADMIN_TOKEN` -> moderator, keyId null, label `bootstrap`; else SHA-256 lookup in `publish_keys`). `requireRole`, `canEditScenario` pure. `ADMIN_TOKEN` read per request so tests can toggle it.
- **Transactions:** each mutation route runs in one `inTransaction`; `audit.record(client, ...)` joins it.
- **Archive caps:** declared size checked before read, then streamed with a byte counter that aborts at the cap (a lying central directory cannot exceed it); entry count checked before iteration.

## Prerequisites
- [x] Files exist; DB up; skills loaded

## Recommendation
BUILD. Commit 1 (split) done with suite 348/348 before and after.

## Resume audit (final state)
- Suite on the tree: **610/610** (588 inherited + 22 in the new `test/unit/auth-and-limits.test.js`, scenario 186).
- Audit found no defect in the interrupted agent's routes, auth, limiter, caps or migration; the gaps were missing unit tests for the new routines (`requireRole`, `canEditScenario`, `createWindowCounter`, `limitAuthorUploads`, `parsePositiveInt`, `forbiddenAuthorFields`, `sha256Hex`) and the three doc/env items, all now done.
- Docs/env done: `CLAUDE.md` (Backend bullets, Critical rule 4, test count), `docs/test-plan.md` (scenarios 178-186; 18 and 22 amended), `.env.example`, `docker-compose.yml` (four optional limit vars; `AUTH_FAILURES_PER_WINDOW` is an addition beyond the plan so tests and ops can tune the 30/15 min limit).
- Left alone: `docs/code-standards.md:96` still says auth middleware answers 503 for an unset token (outside this phase's file scope); `docs/tech-stack.md`/`implementation-plan.md` are history. Frontend `admin.service.ts` still maps 503 to an ADMIN_TOKEN message — harmless dead branch until the Phase 4+ UI work.
- Known pre-existing flake unchanged: `archive upload rejects bad input without leaking temp files` (404 subtest).
