# Review: merge of feature/nocturne-release-2-admin into main (independent)

Status: in progress (e2e running). Updated at the end.

## Executed Results
- Backend `npm test` (DB 55432): 1487 tests, 1487 pass, 0 fail, 0 skipped.
- Frontend `ng test --no-watch`: 50 files, 766 tests pass.
- `npm run build && npm run check:csp`: build ok; check:csp "matches the CSP".
- `npm run test:scripts`: 8 pass / 0 fail.
- e2e: pending.
