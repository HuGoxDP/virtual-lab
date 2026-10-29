# Merge progress: feature/nocturne-release-2-admin into main

Do not commit, do not abort. Resolve + `git add`. (Note: shell heredocs mangle backslashes; use the Edit tool for
files containing `\`.)

## Conflicts (resolution)
- `.env.example`, `docker-compose.yml`: kept both sides (LTI vars + volume `virtual_lab_lti`, release-2 limits + `virtual_lab_previews`). DONE
- `backend/Dockerfile`: `COPY *.js` already covers `trust-proxy.js`; kept `COPY routes`, `COPY lti`; mkdir/chown now covers archives, previews, lti. DONE
- `nginx/csp.conf`: main's `frame-ancestors $csp_ancestors` + feature's `img-src 'self' data: blob:` (no https:). DONE
- `backend/server.js`: feature split + `createLtiRouter` / `parseTrustProxy` imports, trust-proxy block, `/api/lti` mounted after telemetry, before health (as main). DONE
- `backend/test/helpers/db.js`: truncate list merged (scenarios, scenario_versions, scenario_sessions, categories, publish_keys, audit_events, lti_*); `createBaseline` split out of `prepareSchema`. DONE
- `Readme.md`: both sections kept (LTI + roles) plus LTI notes on graded/published. DONE. `CLAUDE.md`: test-count conflict pending + add LTI/graded text
- `viewer.component.ts`: both field sets kept; `?lti=1` disables draft/returnTo parsing. DONE

## Migration renumbering (done)
007_keys_roles_audit -> 009, 008_status_and_versions -> 010, 009_drop_is_published -> 011, 010_previews_and_manifest_id -> 012;
tests renamed migration-007 -> migration-009.test.js, migration-008-009 -> migration-010-011.test.js; references updated in
CLAUDE.md, docs/test-plan.md, plan, csp.conf, comments. Historical phase artifacts under `.code-foundations/build/*phase-*` left as written.
New `013_scenario_versions_graded.sql`: pending.

## Semantic fixes
- LTI published rule: PUBLIC_ROW/ITEM_FROM moved to backend/scenario-rows.js (catalog-public imports them); lti/store.js getScenario uses them. lti-grades.test.js seeds status + hidden-category + review cases. DONE
- graded via versions: migration 013_scenario_versions_graded.sql; versions.js (VERSION_SELECT, pointScenarioAt, installUpload); 3 tests in scenario-graded.test.js; migration-over-main.test.js (main 001-008 -> 009-013, twice). DONE
- routes: lti/pick top-level before root **, admin ** is a child; spec added. DONE
- nginx.conf/csp.spec.ts auto-merged and checked (both sides present). DONE

## Extra
- lti-demo/reset-demo.ps1: publish AFTER the archive upload (draft model). docs/lti-demo.md, docs/test-plan.md (7.1), docs/code-standards.md, CLAUDE.md (LTI + graded text, counts), Readme.md updated.
- Verification stack vl-r2 used an extra override C:/Users/HuGox/vl-r2/override-lti.yml (virtual_lab_lti -> vl_r2_lti) so down -v never touches the shared LTI volume.

## Results
- backend npm test: 1487 pass / 0 fail. frontend ng test: 766 pass. check:csp OK. test:scripts 8 pass.
- e2e (vl-r2, :8047, fresh volumes): 122 passed, 19 skipped (streaming x14: no imported asset store; ktx2 x1; editor-csp x2: no editor stack), 0 failed.
- git diff --name-only --diff-filter=U: empty.

## Done / Left
- [x] everything. Nothing committed (orchestrator commits). Left: nothing.
