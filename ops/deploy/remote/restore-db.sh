#!/usr/bin/env bash
# ops/deploy/remote/restore-db.sh — the rollback's database restore (D-10).
# Refuses unless the backup exists and carries a `verified` marker: an
# unverified backup is not a rollback target, and restoring one would trade an
# outage for a data loss.
set -euo pipefail

DEPLOY_PATH="$1"
BACKUP_NAME="$2"
PROJECT="$3"
COMPOSE_FILES="$4"

BACKUP_PATH="$DEPLOY_PATH/backups/$BACKUP_NAME"
[ -d "$BACKUP_PATH" ] || { echo "error=no-backup" >&2; exit 1; }
if [ ! -f "$BACKUP_PATH/verified" ]; then
  echo "error=backup-not-verified" >&2
  exit 1
fi
# The release that is running now: `up` records its id in `releases/current` (a
# file, not a symlink — see `up.sh`). The rollback has already stopped the new
# release, so this names the one to restore *from*.
CURRENT_RELEASE=$(cat "$DEPLOY_PATH/releases/current" 2>/dev/null || true)
[ -n "$CURRENT_RELEASE" ] || { echo "error=no-current-release" >&2; exit 1; }
cd "$DEPLOY_PATH/releases/$CURRENT_RELEASE" || { echo "error=no-current-release" >&2; exit 1; }
COMPOSE_FILE="$COMPOSE_FILES" \
docker compose --project-name "$PROJECT" \
  --env-file "$DEPLOY_PATH/shared/.env" \
  run --rm --entrypoint node \
  -e BACKUP_DIR=/backups -v "$BACKUP_PATH:/backups" \
  backup restore.mjs "$BACKUP_NAME" --yes >/dev/null
echo "restored=$BACKUP_NAME"
echo "restore_ok=1"
