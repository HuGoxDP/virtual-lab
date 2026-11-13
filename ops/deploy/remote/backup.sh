#!/usr/bin/env bash
# ops/deploy/remote/backup.sh — one backup on demand, into `backups/`. The
# container's own path is fixed (BACKUP_HOST_DIR); only the host directory is
# configurable (research F-4). Prints the backup's name for later verification.
set -euo pipefail

DEPLOY_PATH="$1"
PROJECT="$2"
COMPOSE_FILES="$3"

cd "$DEPLOY_PATH/releases/current" 2>/dev/null || { echo "error=no-current-release" >&2; exit 1; }
NAME=$(BACKUP_HOST_DIR="$DEPLOY_PATH/backups" BACKUP_RUN_ONCE=1 \
  COMPOSE_FILE="$COMPOSE_FILES" \
  docker compose --project-name "$PROJECT" --env-file "$DEPLOY_PATH/shared/.env" \
  run --rm backup 2>/dev/null | grep -o '[0-9T:.-]*Z' | head -1 || true)
if [ -z "$NAME" ]; then
  echo "error=backup-not-created" >&2
  exit 1
fi
echo "backup_name=$NAME"
echo "backup_path=$DEPLOY_PATH/backups/$NAME"
echo "backup_ok=1"
