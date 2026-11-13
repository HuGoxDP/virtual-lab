#!/usr/bin/env bash
# ops/deploy/remote/state.sh — read or write the release record. A deploy writes
# what it deployed (id, tag, commit, at, and the previous id), so a rollback has
# a name to go back to. The file is JSON, one per line appended as history.
set -euo pipefail

DEPLOY_PATH="$1"
RELEASE_ID="$2"
ACTION="$3"

STATE="$DEPLOY_PATH/releases/state.json"
if [ "$ACTION" = "read" ]; then
  if [ -f "$STATE" ]; then cat "$STATE"; else echo '{"current":null,"previous":null,"history":[]}'; fi
  exit 0
fi
echo "state_unhandled=$ACTION" >&2
exit 1
