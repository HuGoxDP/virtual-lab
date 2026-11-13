#!/usr/bin/env bash
# ops/deploy/remote/upload-bundle.sh — the release's compose files and its
# `release.env` (tag, commit, the compose file list; never a secret), unpacked
# to `releases/<id>.tmp` and renamed only when complete, so an interrupted
# upload leaves `current` untouched and the next run removes the partial.
set -euo pipefail

RELEASES_DIR="$1"
RELEASE_ID="$2"
BUNDLE="$3"        # a .tar.gz on stdin

TMP="$RELEASES_DIR/$RELEASE_ID.tmp"
rm -rf "$TMP"
mkdir -p "$TMP"
tar -xzf "$BUNDLE" -C "$TMP"
# The release is complete once its compose file list is there; the marker is what
# `compose` then reads.
mv "$TMP" "$RELEASES_DIR/$RELEASE_ID"
echo "release_dir=$RELEASES_DIR/$RELEASE_ID"
echo "upload_ok=1"
