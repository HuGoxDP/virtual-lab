// scripts/lib/verify-backup.mjs
//
// The verifier lives in backup/verify-backup.mjs so the backup image ships it
// (the Docker build context is backup/ — scripts/ is unreachable from it).
// This module keeps the host-side import path stable: every export comes from
// the one implementation, re-exported unchanged, and its CLI entry calls the
// shared runCli.

import { isMainModule, runCli } from '../../backup/verify-backup.mjs';

export * from '../../backup/verify-backup.mjs';

if (isMainModule(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      // Whatever escapes runCli's own handling: named, once, exit 1 — never a
      // stack trace on an admin's terminal.
      process.stderr.write(`verify-backup failed: ${error?.message ?? error}\n`);
      process.exit(1);
    });
}
