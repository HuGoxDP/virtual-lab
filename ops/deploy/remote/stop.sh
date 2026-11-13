#!/usr/bin/env bash
# ops/deploy/remote/stop.sh — stop a release's containers without touching its
# volumes. The first step of a rollback: whatever the new backend was doing
# stops before anything else is asked for.
set -euo pipefail

DEPLOY_PATH="$1"
PROJECT="$2"
RELEASE_ID="$3"
COMPOSE_FILES="$4"

RELEASE_DIR="$DEPLOY_PATH/releases/${RELEASE_ID:-current}"
if [ ! -d "$RELEASE_DIR" ]; then
  # No release directory: the stack cannot be running either.
  echo "stopped=0"
  echo "stop_ok=1"
  exit 0
fi
cd "$RELEASE_DIR"
COMPOSE_FILE="$COMPOSE_FILES" docker compose --project-name "$PROJECT" \
  --env-file "$DEPLOY_PATH/shared/.env" \
  down --remove-orphans >/dev/null 2>&1 || true
echo "stopped=1"
echo "stop_ok=1"
