# Discovery + Design: Phase 4 - Serve the player in virtual-lab (additive)

## Files Found
nginx/nginx.conf, nginx/csp.conf, Dockerfile.frontend, frontend/angular.json, e2e/tests/csp.spec.ts, docs/test-plan.md,
viewer-profiler.spec.ts, viewer-lifecycle.spec.ts, .github/workflows/ci.yml (nginx -t job).

## Current State
Release tarball installed; node_modules/WebEngineTS/dist/player/{player.html,player.js,player.nginx.conf} present.
Engine bundle served from /assets/WebEngineTS.standalone.js, transcoder from /assets/basis/ (both by the static regex block, no ACAO).

## Gaps
- The snippet defines two exact `location =` blocks (not one `^~ /player/` location); including it at server level is what the snippet documents. Added a `^~ /player/` 404 block for everything else.
- CI `nginx -t` would fail without the snippet (outside the listed file scope; fixed by extracting it from the tarball).
- Highest scenario number in test-plan is 157 -> new ones 158-163.

## Code Standards
docs/code-standards.md absent in worktree; followed file conventions (CRLF, comment style).

## DW Verification
| DW-ID | Item | Status | Tests |
|---|---|---|---|
| DW-4.1 | headers + ACAO | COVERED | player-serving: CSP/sandbox test, ACAO x7, regex-block test |
| DW-4.2 | top-level origin null + refusal | COVERED | player-serving: DW-4.2 |
| DW-4.3 | existing suites unchanged | COVERED | full unit/backend/e2e runs |
| DW-4.4 | CSP per location | COVERED | csp.spec: DW-4.4 |
| DW-4.5 | viewer profiler specs | COVERED | existing specs, reset via _resetDiagnosticsPolicy |
**All items COVERED:** YES

## Design Decisions
- Snippet included at server level; exact-match locations beat the regex block. `^~ /player/` returns 404 for the rest (no SPA fallback).
- ACAO added as narrow locations: `= /assets/WebEngineTS.standalone.js`, `^~ /assets/basis/`, and on both `/a/` locations; each repeats the platform headers + csp.conf.
- DW-4.5: every `diagnosticsAllowed = true` in the two specs became `_resetDiagnosticsPolicy()` (identical semantics: open gate).

## Recommendation
BUILD
