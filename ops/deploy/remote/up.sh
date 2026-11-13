#!/usr/bin/env bash
# ops/deploy/remote/up.sh — bring the release up. `--no-build`: a release runs
# images, never a compiler (decision D-2), so a build here would mean the host
# has images it was not shipped.
set -euo pipefail

DEPLOY_PATH="$1"
RELEASE_ID="$2"
PROJECT="$3"

cd "$DEPLOY_PATH/releases/$RELEASE_ID" || { echo "error=no-release" >&2; exit 1; }
docker compose --project-name "$PROJECT" \
  --env-file "$DEPLOY_PATH/shared/.env" \
  --env-file "$DEPLOY_PATH/releases/$RELEASE_ID/release.env" \
  up -d --no-build --remove-orphans
echo "release_id=$RELEASE_ID"
echo "up_ok=1"
