#!/usr/bin/env bash
# ops/deploy/remote/up.sh — bring the release up. `--no-build`: a release runs
# images, never a compiler (decision D-2), so a build here would mean the host
# has images it was not shipped. The compose file list travels as a positional
# argument, so a path in a value cannot become a flag.
set -euo pipefail

DEPLOY_PATH="$1"
RELEASE_ID="$2"
PROJECT="$3"
COMPOSE_FILES="$4"

RELEASE_DIR="$DEPLOY_PATH/releases/$RELEASE_ID"
cd "$RELEASE_DIR" || { echo "error=no-release" >&2; exit 1; }
COMPOSE_FILE="$COMPOSE_FILES" docker compose --project-name "$PROJECT" \
  --env-file "$DEPLOY_PATH/shared/.env" \
  --env-file "$RELEASE_DIR/release.env" \
  up -d --no-build --remove-orphans
echo "release_id=$RELEASE_ID"
echo "up_ok=1"
