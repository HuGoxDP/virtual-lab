#!/usr/bin/env bash
# ops/deploy/remote/prune.sh — remove the images no release record keeps (never
# the current, the previous, or the one before: decision D-3). Dry by default;
# `apply` deletes.
set -euo pipefail

MODE="$1"; shift
KEEP="$1"; shift

apply=false
if [ "$MODE" = "apply" ]; then apply=true; fi

# The keep list is comma-separated *tags*, not release ids: an image is named
# `repo/service:<tag>` and a release id is `vl-a1b2c3d`, so comparing the two
# kept nothing and pruned every image of every release (OPS1 phase 5). Splitting
# on commas is the other half — an unquoted `$KEEP` splits on IFS only, so
# `a,b` would have been one unkeepable word.
IFS=',' read -ra KEEP_TAGS <<< "$KEEP"

removed=0
for name in "$@"; do
  # The tag is everything after the last colon: `virtual-lab/backend:<tag>`.
  tag="${name##*:}"
  skip=false
  for keep in "${KEEP_TAGS[@]}"; do
    [ -z "$keep" ] && continue
    if [ "$tag" = "$keep" ]; then skip=true; break; fi
  done
  if [ "$skip" = true ]; then echo "keep=$name"; continue; fi
  if [ "$apply" = true ]; then
    if docker image rm "$name" >/dev/null 2>&1; then removed=$((removed + 1)); echo "removed=$name"; fi
  else
    echo "would_remove=$name"
  fi
done
echo "prune_ok=1"
