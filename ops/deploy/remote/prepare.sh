#!/usr/bin/env bash
# ops/deploy/remote/prepare.sh — the directories a deploy needs, and the shared
# `.env` only when the host has none (decision D-12). Nothing here overwrites:
# `set -o noclobber` and `cp -n`, so a hand-made deployment keeps its own
# secrets — the pipeline never sees them at all.
#
# A fresh host has no `.env`, and a stack cannot start without one, so `prepare`
# makes one from `releases/shared.env.template`. Every `${GENERATED}` placeholder
# becomes a fresh random secret: a host nobody has configured gets secrets
# nobody has seen, rather than a value that shipped in the bundle. The generated
# file is never printed and never read back by the pipeline (D-13).
set -euo pipefail

DEPLOY_PATH="$1"

mkdir -p "$DEPLOY_PATH/releases" "$DEPLOY_PATH/shared" "$DEPLOY_PATH/backups"
echo "dirs_ok=1"

if [ -f "$DEPLOY_PATH/shared/.env" ]; then
  # An adopted host: the operator put this here, so it stays byte for byte.
  echo "env=kept"
elif [ -f "$DEPLOY_PATH/releases/shared.env.template" ]; then
  # A `>` under noclobber cannot overwrite the `kept` case above; it is the
  # second half of the never-overwrite rule for the generated file.
  secret() {
    openssl rand -hex 32 2>/dev/null \
      || head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n'
  }
  (
    set -o noclobber
    {
      while IFS= read -r line; do
        case "$line" in
          *'${GENERATED}'*)
            # One substitution per line, and the placeholder word is the whole
            # value: a template that put text around a secret would leak the shape
            # of what it replaced.
            printf '%s\n' "${line//\$\{GENERATED\}/$(secret)}"
            ;;
          *) printf '%s\n' "$line" ;;
        esac
      done < "$DEPLOY_PATH/releases/shared.env.template"
    } > "$DEPLOY_PATH/shared/.env"
  )
  chmod 600 "$DEPLOY_PATH/shared/.env" 2>/dev/null || true
  echo "env=created"
else
  echo "env=absent"
fi
echo "prepare_ok=1"