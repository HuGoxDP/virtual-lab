#!/usr/bin/env bash
# ops/deploy/remote/upload-bundle.sh — the release's compose files and its
# `release.env` (tag, commit, the compose file list; never a secret), unpacked
# to `releases/<id>.tmp` and renamed only when complete, so an interrupted
# upload leaves `current` untouched and the next run removes the partial.
#
# The tarball travels on *stdin*, not as a path: over SSH a path is a path on the
# host, and the bundle is on the worker. Reading it as a stream is the same
# procedure for both transports (D-14), which is what makes the rehearsal prove
# the production upload rather than a local copy.
set -euo pipefail

RELEASES_DIR="$1"
RELEASE_ID="$2"

TMP="$RELEASES_DIR/$RELEASE_ID.tmp"
rm -rf "$TMP"
mkdir -p "$TMP"
# `-f -`: read the archive from stdin.
tar -xzf - -C "$TMP"

# The `.env` template has to be in the bundle: a fresh host has no `.env`, and
# `prepare` runs *before* `up`, so `releases/current` does not exist yet and this
# stable path is the only source for one (OPS1 phase 5 — the first rehearsal found
# it inside the release directory, where nothing looks). Checked *before* the
# rename, so a bundle that cannot start a host leaves nothing behind.
if [ ! -f "$TMP/ops/deploy/shared.env.template" ]; then
  echo "error=no-shared-env-template" >&2
  rm -rf "$TMP"
  exit 1
fi

# The release is complete once the rename is done; `mv` is atomic within a
# filesystem, so a reader sees either no release or all of it.
mv "$TMP" "$RELEASES_DIR/$RELEASE_ID"
cp -f "$RELEASES_DIR/$RELEASE_ID/ops/deploy/shared.env.template" "$RELEASES_DIR/shared.env.template"
echo "template=shared.env.template"
echo "release_dir=$RELEASES_DIR/$RELEASE_ID"
echo "upload_ok=1"