// scripts/lib/verify-backup.mjs
//
// The verifier lives in backup/verify-backup.mjs so the backup image ships it
// (the Docker build context is backup/ — scripts/ is unreachable from it).
// This module keeps the host-side import path stable: every export comes from
// the one implementation, re-exported unchanged, and its CLI entry calls the
// shared runCli.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../backup/verify-backup.mjs';

export * from '../../backup/verify-backup.mjs';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2)).then(code => process.exit(code));
}
