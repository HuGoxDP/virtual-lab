#!/usr/bin/env bash
# ops/deploy/remote/restore-db.sh — the rollback's database restore (D-10).
# Refuses unless the backup exists and carries a `verified` marker: an
# unverified backup is not a rollback target, and restoring one would trade an
# outage for a data loss.
set -euo pipefail

DEPLOY_PATH="$1"
BACKUP_NAME="$2"
PROJECT="$3"

BACKUP_PATH="$DEPLOY_PATH/backups/$BACKUP_NAME"
[ -d "$BACKUP_PATH" ] || { echo "error=no-backup" >&2; exit 1; }
if [ ! -f "$BACKUP_PATH/verified" ]; then
  echo "error=backup-not-verified" >&2
  exit 1
fi
cd "$DEPLOY_PATH/releases/current" || { echo "error=no-current-release" >&2; exit 1; }
docker compose --project-name "$PROJECT" \
  --env-file "$DEPLOY_PATH/shared/.env" \
  run --rm --entrypoint node \
  -e BACKUP_DIR=/backups -v "$BACKUP_PATH:/backups" \
  backup restore.mjs "$BACKUP_NAME" --yes >/dev/null
echo "restored=$BACKUP_NAME"
echo "restore_ok=1"
