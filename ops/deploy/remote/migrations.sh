#!/usr/bin/env bash
# ops/deploy/remote/migrations.sh — which migrations the database has applied.
# Read-only: it asks `schema_migrations`, it does not run anything (the backend
# applies the rest at start-up). Prints the set as comma-separated names, which
# is what `needsDbRestore` compares before and after a deploy.
set -euo pipefail

DEPLOY_PATH="$1"
PROJECT="$2"

cd "$DEPLOY_PATH/releases/current" 2>/dev/null || { echo "migrations_error=no-current-release" >&2; exit 1; }
SET=$(docker compose --project-name "$PROJECT" --env-file "$DEPLOY_PATH/shared/.env" \
  exec -T database \
  psql -U "$(grep -m1 '^DB_USER=' "$DEPLOY_PATH/shared/.env" | cut -d= -f2)" \
       -d "$(grep -m1 '^DB_NAME=' "$DEPLOY_PATH/shared/.env" | cut -d= -f2)" \
       -tAc "select string_agg(filename, ',' order by filename) from schema_migrations" 2>/dev/null || true)
echo "migrations=${SET}"
echo "migrations_ok=1"
