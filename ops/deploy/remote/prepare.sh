#!/usr/bin/env bash
# ops/deploy/remote/prepare.sh — the directories a deploy needs, and the shared
# `.env` only when the host has none (decision D-12). Nothing here overwrites:
# `set -o noclobber` and `cp -n`, so a hand-made deployment keeps its own
# secrets — the pipeline never sees them at all.
set -euo pipefail

DEPLOY_PATH="$1"

mkdir -p "$DEPLOY_PATH/releases" "$DEPLOY_PATH/shared" "$DEPLOY_PATH/backups"
echo "dirs_ok=1"

if [ -f "$DEPLOY_PATH/shared/.env" ]; then
  echo "env=kept"
else
  if [ -f "$DEPLOY_PATH/releases/shared.env.template" ]; then
    (
      set -o noclobber
      # -n: never overwrite. A host that already has a .env keeps it.
      cp -n "$DEPLOY_PATH/releases/shared.env.template" "$DEPLOY_PATH/shared/.env"
    )
    echo "env=created"
  else
    echo "env=absent"
  fi
fi
echo "prepare_ok=1"
