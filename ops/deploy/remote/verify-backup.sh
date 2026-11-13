#!/usr/bin/env bash
# ops/deploy/remote/verify-backup.sh — the read-back that makes a backup a
# backup (decision D-9): the dump decompresses, its SQL parses far enough to
# name the tables it holds, the manifest is valid JSON, and the volume archives
# are readable tars. A truncated file is a named failure, not a red `ls`.
set -euo pipefail

BACKUP_PATH="$1"
fail() { echo "verify_error=$1" >&2; exit 1; }

[ -f "$BACKUP_PATH/db.sql.gz" ] || fail "db.sql.gz missing"
gzip -t "$BACKUP_PATH/db.sql.gz" 2>/dev/null || fail "db.sql.gz is not a valid gzip"
TABLES=$(gzip -dc "$BACKUP_PATH/db.sql.gz" | grep -c '^CREATE TABLE ' || true)
[ "$TABLES" -gt 0 ] || fail "db.sql.gz holds no tables"
[ -f "$BACKUP_PATH/manifest.json" ] || fail "manifest.json missing"
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$BACKUP_PATH/manifest.json" 2>/dev/null \
  || fail "manifest.json is not valid JSON"
if [ -d "$BACKUP_PATH/volumes" ]; then
  for archive in "$BACKUP_PATH"/volumes/*.tar.gz; do
    [ -e "$archive" ] || continue
    gzip -t "$archive" 2>/dev/null || fail "volume archive $(basename "$archive") is truncated"
    tar -tzf "$archive" >/dev/null 2>&1 || fail "volume archive $(basename "$archive") is unreadable"
  done
fi
echo "verified=1"
echo "tables=$TABLES"
echo "verify_ok=1"
