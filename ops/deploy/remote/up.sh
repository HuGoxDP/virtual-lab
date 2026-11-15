#!/usr/bin/env bash
# ops/deploy/remote/up.sh — bring the release up. `--no-build`: a release runs
# images, never a compiler (decision D-2), so a build here would mean the host
# has images it was not shipped. The compose file list travels as a positional
# argument, so a path in a value cannot become a flag.
#
# After the stack is up, `releases/current` points at this release: every script
# that asks the *running* stack something (`backup.sh`, `migrations.sh`,
# `restore-db.sh`) runs compose from there, so the pointer is what makes "current"
# a fact rather than a directory listing. The swap goes through a temp name and
# `mv -T`, so a reader never sees a missing `current`.
set -euo pipefail

DEPLOY_PATH="$1"
RELEASE_ID="$2"
PROJECT="$3"
COMPOSE_FILES="$4"

RELEASE_DIR="$DEPLOY_PATH/releases/$RELEASE_ID"
cd "$RELEASE_DIR" || { echo "error=no-release" >&2; exit 1; }
# The services declare `env_file: .env`, which compose resolves against the
# compose file's directory — the release directory, where there is no `.env`:
# the secrets live in `shared/.env` (D-12). So the release's compose override
# points each service at the shared file, and this variable is that path
# (OPS1 phase 5: without it `up` answers "env file …/releases/<id>/.env not found").
export VL_SHARED_ENV="$DEPLOY_PATH/shared/.env"
COMPOSE_FILE="$COMPOSE_FILES" docker compose --project-name "$PROJECT" \
  --env-file "$DEPLOY_PATH/shared/.env" \
  --env-file "$RELEASE_DIR/release.env" \
  up -d --no-build --remove-orphans

CURRENT_LINK="$DEPLOY_PATH/releases/current"
ln -sfn "$RELEASE_ID" "$CURRENT_LINK.tmp"
mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"

echo "release_id=$RELEASE_ID"
echo "current=$RELEASE_DIR"
echo "up_ok=1"