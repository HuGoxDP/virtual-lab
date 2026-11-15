#!/usr/bin/env bash
# ops/deploy/remote/backup.sh — one backup on demand, into `backups/`. The
# container's own path is fixed (BACKUP_HOST_DIR); only the host directory is
# configurable (research F-4). Prints the backup's name for later verification.
set -euo pipefail

DEPLOY_PATH="$1"
PROJECT="$2"
COMPOSE_FILES="$3"

# The release that is running now: `up` records its id in `releases/current` (a
# file, not a symlink — see `up.sh`). Nothing else on the host knows it.
CURRENT_RELEASE=$(cat "$DEPLOY_PATH/releases/current" 2>/dev/null || true)
[ -n "$CURRENT_RELEASE" ] || { echo "error=no-current-release" >&2; exit 1; }
RELEASE_DIR="$DEPLOY_PATH/releases/$CURRENT_RELEASE"
cd "$RELEASE_DIR" || { echo "error=no-current-release" >&2; exit 1; }
# The one-off backup prints `backup -> <dir>`, and the dir's name is the backup's
# name. Everything the container says is kept: a backup that fails has already
# removed its own partial directory, so the container's last words are the only
# evidence there is (OPS1 phase 5 — a bare "error=backup-not-created" made R-4
# undiagnosable).
OUT=$(BACKUP_HOST_DIR="$DEPLOY_PATH/backups" BACKUP_RUN_ONCE=1 \
  COMPOSE_FILE="$COMPOSE_FILES" \
  docker compose --project-name "$PROJECT" --env-file "$DEPLOY_PATH/shared/.env" \
  --env-file "$RELEASE_DIR/release.env" \
  run --rm backup 2>&1 || true)
NAME=$(printf '%s\n' "$OUT" | grep -o '[0-9T:.-]*Z' | head -1 || true)
if [ -z "$NAME" ]; then
  echo "error=backup-not-created" >&2
  printf '%s\n' "$OUT" | tail -6 >&2
  exit 1
fi
echo "backup_name=$NAME"
echo "backup_path=$DEPLOY_PATH/backups/$NAME"
echo "backup_ok=1"
