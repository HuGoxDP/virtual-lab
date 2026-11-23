// HO1g: entry that pulls the backup/ tests into the root `npm run test:scripts`
// suite. The imports are side-effecting: each module registers its node:test
// cases in this file's run. Do not add "type" to root package.json for the
// typeless retention.test.js — Node >=20.19/22.12 runs it with a one-time
// MODULE_TYPELESS_PACKAGE_JSON warning, which is accepted.
import '../../backup/restore.test.mjs';
import '../../backup/test/unit/retention.test.js';
