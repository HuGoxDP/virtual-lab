// scripts/lib/verify-backup.mjs
//
// The verifier lives in backup/verify-backup.mjs so the backup image ships it
// (the Docker build context is backup/ — scripts/ is unreachable from it).
// This module keeps the host-side import path stable: every export comes from
// the one implementation, re-exported unchanged.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBackup } from '../../backup/verify-backup.mjs';

export * from '../../backup/verify-backup.mjs';

// CLI: `node scripts/lib/verify-backup.mjs <backup-dir>` — the step the restore
// procedure in docs/backup-restore.md runs before `restore.mjs` will accept a
// backup. One line per check, exit 0 only when the marker was written.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/lib/verify-backup.mjs <backup-dir>');
    process.exit(2);
  }
  const result = verifyBackup(dir);
  for (const check of result.checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  console.log(result.ok ? `verified: ${dir}` : `not verified: ${result.error}`);
  process.exit(result.ok ? 0 : 1);
}
