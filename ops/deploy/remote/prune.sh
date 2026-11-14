#!/usr/bin/env bash
# ops/deploy/remote/prune.sh — remove the images no release record keeps (never
# the current, the previous, or the one before: decision D-3). Dry by default;
# `apply` deletes.
set -euo pipefail

MODE="$1"; shift
KEEP="$1"; shift

apply=false
if [ "$MODE" = "apply" ]; then apply=true; fi

# The keep list is comma-separated (`keepForPrune` names the ids), and an unquoted
# `$KEEP` would split on nothing: commas are not IFS, so `vl-a,vl-b` would be one
# unkeepable word and every release's images would look prunable.
IFS=',' read -ra KEEP_IDS <<< "$KEEP"

removed=0
for name in "$@"; do
  skip=false
  for keep in "${KEEP_IDS[@]}"; do
    [ -z "$keep" ] && continue
    if [ "$name" = "$keep" ]; then skip=true; break; fi
  done
  if [ "$skip" = true ]; then echo "keep=$name"; continue; fi
  if [ "$apply" = true ]; then
    if docker image rm "$name" >/dev/null 2>&1; then removed=$((removed + 1)); echo "removed=$name"; fi
  else
    echo "would_remove=$name"
  fi
done
echo "prune_ok=1"
