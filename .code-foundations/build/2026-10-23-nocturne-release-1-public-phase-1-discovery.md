# Discovery + Design: Phase 1 - Catalog data and API

## Files Found
backend/server.js (catalog 129, admin list 199, by-id 232, POST 258, PUT 298, limit 97/382), backend/migrations/001-005,
backend/test/helpers/db.js, backend/test/integration/{catalog,auth-and-crud,archives-and-telemetry}.test.js, docs/test-plan.md, Readme.md, CLAUDE.md, nginx/nginx.conf (client_max_body_size 512m > 200 MiB default: ok).

## Gaps
- seedScenarios inserts via SQL after migration, so categories rows must be seeded by the helper too (else no chips).
- archive_bytes is BIGINT: pg returns a string; item contract wants number|null -> cast ::float8 (exact to 2^53).
- No existing 413 test (test-plan #42 had none); upload errors escape the route's try.
- Readme documents the 2 GiB default; no .env.example/compose entry for MAX_ARCHIVE_BYTES.

## Assumptions
- uk-x-icu: confirmed by an ordering test. Max stored archive_bytes: cannot check (dev DB down); default stays overridable via .env.

## DW Verification
| DW-ID | Status | Tests |
|---|---|---|
| DW-1.1 | COVERED | migration-006 test file: twice, seeds/icons/order, features default |
| DW-1.2 | COVERED | catalog shape, summary/count unfiltered, invisible/unpublished-only categories |
| DW-1.3 | COVERED | sort=title Ukrainian, sort=new, dirty sort, limit/offset boundaries, q wildcard |
| DW-1.4 | COVERED | related rules, 404s |
| DW-1.5 | COVERED | config default/env (child process), 413 + temp dir empty, exact-limit accepted |
| DW-1.6 | COVERED | features boundaries/dirty, category upsert, label keeps |
| DW-1.7 | COVERED | whole suite + test-plan numbers |
All COVERED: YES

## Design Decisions
Design-it-twice (features validation / category upsert): (A) inline in routes; (B) a small deep module `backend/catalog-input.js` exposing `validateFeatures(value)` -> {value}|{error}; pure, unit-testable. Chosen B for validation; SQL stays in server.js (single shared ITEM_SELECT fragment so list/by-id/related agree). ensureCategory(db, slug, label) in server.js, run in a transaction with the scenario write. Sort is a whitelist map to fixed SQL (never interpolated user text).
## Recommendation
BUILD
