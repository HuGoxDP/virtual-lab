#!/usr/bin/env bash
# ops/deploy/remote/migrations.sh — which migrations the database has applied.
# Read-only: it asks `schema_migrations`, it does not run anything (the backend
# applies the rest at start-up). Prints the set as comma-separated names, which
# is what `needsDbRestore` compares before and after a deploy.
set -euo pipefail

DEPLOY_PATH="$1"
PROJECT="$2"
COMPOSE_FILES="$3"

# The release that is running now: `up` records its id in `releases/current` (a
# file, not a symlink — see `up.sh`).
CURRENT_RELEASE=$(cat "$DEPLOY_PATH/releases/current" 2>/dev/null || true)
[ -n "$CURRENT_RELEASE" ] || { echo "migrations_error=no-current-release" >&2; exit 1; }
RELEASE_DIR="$DEPLOY_PATH/releases/$CURRENT_RELEASE"
cd "$RELEASE_DIR" || { echo "migrations_error=no-current-release" >&2; exit 1; }
# The base compose reads its `env_file` from this variable: a release directory
# has no `.env` of its own, and the secrets live in `shared/.env` (D-12).
export VL_SHARED_ENV="$DEPLOY_PATH/shared/.env"
SET=$(COMPOSE_FILE="$COMPOSE_FILES" \
  docker compose --project-name "$PROJECT" --env-file "$DEPLOY_PATH/shared/.env" \
  --env-file "$RELEASE_DIR/release.env" \
  exec -T database \
  psql -U "$(grep -m1 '^DB_USER=' "$DEPLOY_PATH/shared/.env" | cut -d= -f2)" \
       -d "$(grep -m1 '^DB_NAME=' "$DEPLOY_PATH/shared/.env" | cut -d= -f2)" \
       -tAc "select string_agg(filename, ',' order by filename) from schema_migrations" 2>/dev/null || true)
echo "migrations=${SET}"
echo "migrations_ok=1"
