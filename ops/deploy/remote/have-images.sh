#!/usr/bin/env bash
# ops/deploy/remote/have-images.sh — which of the images the release needs the
# server already holds. The worker ships only what is missing (decision D-2).
# Prints `image_<i>_have=true|false` and `image_<i>_id=…` per name.
set -euo pipefail

i=0
for name in "$@"; do
  id=$(docker image inspect --format '{{.Id}}' "$name" 2>/dev/null || true)
  present=false
  if [ -n "$id" ]; then present=true; fi
  echo "image_${i}_name=${name}"
  echo "image_${i}_have=${present}"
  echo "image_${i}_id=${id}"
  i=$((i + 1))
done
echo "count=${i}"
echo "have_images_ok=1"
