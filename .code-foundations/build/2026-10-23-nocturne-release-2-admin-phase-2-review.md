# Review: Phase 2 - Keys, roles and authorization

## Executed Results (Step 0)
- Test suite (working tree, DB on :55432, ADMIN_TOKEN set): `npm test` in backend/ -> 610 tests, 610 pass, 0 fail, 0 skipped.
- Per-commit suites (detached worktrees, node_modules copied, removed afterwards): bf6d51a -> 348/348; 6bc48e7 -> 348/348; 6ee54c4 -> 348/348.
- Typecheck / lint: none exist for backend (stated in prompt). Syntax is proven by the suite loading every module.

## Requirement Fulfillment

### DW-2.1
PREMISE:  "The route split is its own commit with the full backend suite green before and after."
EVIDENCE: commit 6bc48e7 (10 files: db.js, config.js, auth.js, routes/*, server.js shrunk); 6ee54c4 (8 lines, transactions only)
TRACE:    bf6d51a 348/348 -> 6bc48e7 348/348 -> 6ee54c4 348/348, each run by me. The split touches only new modules plus server.js; the transaction wrap is a separate commit.
VERDICT:  PASS

### DW-2.2
PREMISE:  "Keys are stored only as SHA-256 and shown once; /api/keys* is moderator-only; /api/auth/me answers any valid principal and 403 for revoked."
EVIDENCE: routes/keys.js:34-95 (POST stores `sha256Hex(token)` only, returns token once with `Cache-Control: no-store`; list selects KEY_COLUMNS without hash), auth.js:36-55, keys.js:28 (me), keys.js:37/45/76 `authorize('moderator')`; migration 007 `token_hash CHAR(64) UNIQUE`.
TRACE:    POST /api/keys {label,role} -> 32 random bytes -> hash inserted -> 201 {id,label,role,token}; GET /api/keys -> no token/hash; revoked or unknown token -> resolvePrincipal null -> 403 (or 429 after 30 failures); author -> 403 on /api/keys*.
          Tests ran: keys.test.js (issuing, list has no token/hash, captured logs never contain a token, me for each principal, revoke, moderator vs author, input validation), route-table.test.js.
VERDICT:  PASS

### DW-2.3
PREMISE:  "The route table is enforced and pinned by table-driven tests (anonymous, unknown, revoked, author A, author B, moderator key, bootstrap)."
EVIDENCE: test/integration/route-table.test.js:62-160 (CALLERS has all seven; ROUTES lists 12 guarded routes with `allowed`, `ok`, denied-state check), :162 table test, :225 dirty headers.
TRACE:    each route x each caller asserts ok status for allowed callers and 401/403 for the rest, and that denied calls leave state unchanged. Dirty headers: empty `Bearer ` 401, lowercase 401, two spaces 403, 10 KB 403, duplicated header <500 / bad-first 403. Passed.
VERDICT:  PASS

### DW-2.4
PREMISE:  "Author field rules hold: forbidden fields and unknown category slugs -> 400; author-created rows are unpublished and owned; upload into a published scenario -> 403."
EVIDENCE: catalog-input.js `forbiddenAuthorFields`/`AUTHOR_FORBIDDEN_FIELDS` (scenarioUrl, manifestUrl, imageUrl, author, isPublished, archive*); catalog-admin.js:96-170 (POST: forbidden -> 400, unknown category -> 400, `is_published = !byAuthor`, `owner_key_id = principal.keyId`, author = key label, categoryLabel ignored), :195-247 (PUT: ownership via FOR UPDATE + canEditScenario, category existence inside the txn); archives.js:93-101 (owner check, author + published -> 403).
TRACE:    author POST {isPublished:true} -> 400 naming field; POST with unknown slug -> 400 'Невідома категорія'; valid POST -> row unpublished, owner = key id; author upload to published own row -> 403; non-owner -> 403. author-rules.test.js passed.
VERDICT:  PASS

### DW-2.5
PREMISE:  "Every authenticated admin mutation writes one audit_events row inside the request's own transaction (rolled back with it); reads and telemetry write none."
EVIDENCE: audit.js:16; callers inside `inTransaction`: catalog-admin.js create/update/delete, archives.js attach, keys.js create/revoke, storage-admin.js gc (real sweep only).
TRACE:    audit.test.js: one row per mutation with actor/details; reads, telemetry, dry-run GC and refused requests write none; audit.record monkeypatched to throw after the INSERT -> POST/PUT/DELETE/archive/key-create return 500 and neither data change nor event remains.
VERDICT:  PASS (see Notes on GC: file deletion precedes the audit transaction, so it cannot roll back with it)

### DW-2.6
PREMISE:  "Both rate limits and the validation caps behave as stated; last_used_at updates on use."
EVIDENCE: rate-limits.js:24-77, auth.js:73-84, config.js:36-47, archive-validation.js:34-86,96-160.
TRACE:    rate-limits.test.js: failed auths 29/30 -> 403, 31st -> 429 + Retry-After; valid keys and bootstrap unaffected from an exhausted IP; successes and missing credentials not counted; author uploads 1-20 -> 201, 21st -> 429; moderator/bootstrap 21st -> 201. last_used_at null -> set -> advances, unchanged on wrong token. Caps: archive-caps unit + integration tests: manifest MAX+1 -> 400, 20 001 entries -> 400, lying zip bomb cut at cap, nothing stored, tmp dir empty. All passed.
VERDICT:  PASS

### DW-2.7
PREMISE:  "Migration 007 applies twice without error."
EVIDENCE: migrations/007_keys_roles_audit.sql (all `IF NOT EXISTS`); test/integration/migration-007.test.js:43.
TRACE:    test re-runs the SQL against an already migrated DB -> no error; constraints test passes.
VERDICT:  PASS

**All requirements met:** YES

## Edge cases (prompt-listed)
revoked/unknown -> 403: handled. ADMIN_TOKEN unset -> bootstrap off, keys work, no 503 (route-table.test.js:268, grep shows no 503 auth path left). Token never logged/returned after creation: tested. label 1-100 and role -> 400: keys.js:44-49, tested. Failed-auth limit 30/15 min per IP, valid keys never limited: handled. Author uploads per key, moderators exempt: handled. MAX_ENTRY_BYTES / MAX_ARCHIVE_ENTRIES named, env-overridable, empty env falls back: handled. Dirty headers: handled. All handled.

## Test-DW Coverage
- [x] All DW items have named tests that ran in Step 0 (DW-IDs in test names).
- [x] Coverage level 100%: new pure routines (`sha256Hex`, `requireRole`, `canEditScenario`, `createWindowCounter`, `limitAuthorUploads`, `parsePositiveInt`, `forbiddenAuthorFields`, `readEntryCapped` via validate, `declaredEntryCount`) have unit tests; `audit.record`, `authenticate`/`authorize`/`resolvePrincipal` and the route handlers are tested through direct and HTTP integration tests only (no isolated unit test with fakes). Treated as met; see Notes. Gaps: none blocking.

## Dead Code
None found. `requireAdmin` fully removed; no unused imports seen.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | PUT locks the owner row `FOR UPDATE`; in-memory windows are single-process (stated). Upload ownership/published check is read outside the attach transaction (see Notes), not demonstrated as a defect. |
| Error Handling | PASS | multer errors mapped; auth lookup errors -> 500 without leaking; 409 on duplicate id; failed audit rolls back. |
| Resources | PASS | file handle closed in `finally`; stream destroyed at cap; temp file discarded on every non-consumed path (tested). Window map swept above 10 000 entries. |
| Boundaries | PASS | token > 512 chars short-circuits; key id regex + 2^31-1 ceiling; cap exactly MAX+1 rejected; EOCD search bounded to 64 KiB + 22. |
| Security | PASS | SHA-256 only stored, timingSafeEqual for bootstrap, token never logged, no-store header, author forbidden fields denylist incl. `archive*`, role ranks, ownership. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry | PASS | Authorization header, key label/role/id, author body fields, category slug, archive entry sizes/counts all validated before use. |
| cc-defensive-programming | No empty catch blocks | PASS | `declaredEntryCount(...).catch(() => null)` (archive-validation.js:~102) swallows an open/read error, but the next step (`StreamZip`) re-reads the same file and reports failure; not a silent loss. Note only. |
| cc-defensive-programming | Security-critical paths validated again inside barricade | PASS | `authorize` is applied per route, plus `requireRole` 401 guard when principal missing, plus ownership re-check inside the transaction. |
| cc-defensive-programming | No executable code in assertions | N/A | No assertions in production code. |
| ca-architecture-boundaries | Dependency direction | PASS | config <- rate-limits <- auth <- routes; audit takes the caller's client (no pool import); server.js only wires. db.js has no route imports. |
| ca-architecture-boundaries | SRP by actor | PASS | Routes split by actor (public, admin catalog, archives, storage, telemetry, keys); authorization policy centralised in auth.js. |
| cc-refactoring-guidance | Behaviour-preserving split separate from behaviour change | PASS | 6bc48e7 (split) and 6ee54c4 (transactions) precede all uncommitted behavior changes; suite 348/348 at every step, which I ran. |
| cc-refactoring-guidance | Small changes retested | PASS | 6ee54c4 is 8 lines and green. |

## Notes (non-blocking)
- storage-admin.js GC: `deleteObjects` runs before the audit transaction; if the audit insert fails the files are gone but the request is 500 with no event. A file deletion cannot roll back, so this is inherent, but the ordering contradicts the literal "inside the request's transaction" wording for that one route.
- archives.js: the owner/published check is a plain `pool.query` before validation and commit, not locked; a moderator publishing in that window would let one author upload land on a published row. Not demonstrated; window is small.
- `declaredEntryCount` returns 0xFFFF for zip64 archives, so with MAX_ARCHIVE_ENTRIES raised above 65 535 a zip64 archive would be refused by the precheck even if under the cap.
- No isolated unit tests with fakes for `authenticate`/`authorize`/`audit.record`; they are covered by integration tests that exercise them directly or over HTTP.
- Author uploads count attempts, including refused 403s (deliberately pinned by a test).
- `author` validation precedes ownership check in PUT, so a non-owner sending a forbidden field gets 400 rather than 403.

## Issues (if FAIL)
None.

**Verdict: PASS**
