#!/usr/bin/env bash
# ops/deploy/remote/state.sh — read or write the release record (OPS1 phase 5).
#
# The record is what a rollback goes *back to*: the id, tag and commit of the
# release that is running now, the one before it, and a short history. It lives
# in `releases/state.json` and is rewritten through a temp file, so an
# interrupted write leaves the previous record intact rather than a truncated
# one.
#
#   state.sh <DEPLOY_PATH> read
#   state.sh <DEPLOY_PATH> write <id> <tag> <commit> <migrated> [backup]
#
# `migrated` and `backup` are facts about the release being recorded, never
# secrets: a rollback reads them to decide whether the database has to come back
# and from which verified dump.
set -euo pipefail

DEPLOY_PATH="$1"
ACTION="$2"

mkdir -p "$DEPLOY_PATH/releases"
STATE="$DEPLOY_PATH/releases/state.json"

if [ "$ACTION" = "read" ]; then
  if [ -f "$STATE" ]; then cat "$STATE"; else echo '{"current":null,"previous":null,"history":[]}'; fi
  exit 0
fi

if [ "$ACTION" != "write" ]; then
  echo "state_unhandled=$ACTION" >&2
  exit 1
fi

ID="$3"
TAG="$4"
COMMIT="$5"
MIGRATED="$6"
BACKUP="${7:-}"

[ -n "$ID" ] || { echo "error=no-release-id" >&2; exit 1; }
[ -n "$COMMIT" ] || { echo "error=no-commit" >&2; exit 1; }

# The record's own fields, in one place. `at` is the host's clock: the record is
# a history of what ran here, so a worker's clock would be wrong the moment the
# host is in another timezone.
AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="$STATE.tmp"
node -e '
const fs = require("fs");
const [file, id, tag, commit, at, migrated, backup] = process.argv.slice(1);
const cap = 10;
let state = { current: null, previous: null, history: [] };
try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* a truncated record is no record */ }
const record = { id, tag, commit, at, migrated: migrated === "true" };
if (backup) record.backup = backup;
// current → previous, and the history is "what ran before this", one entry per
// release, capped so a year of deploys cannot grow one file forever.
const history = [state.current, ...(state.history ?? [])].filter(Boolean).slice(0, cap);
const tmp = file + ".tmp";
fs.writeFileSync(tmp, JSON.stringify({ current: record, previous: state.current ?? null, history }) + "\n");
fs.renameSync(tmp, file);
' "$STATE" "$ID" "$TAG" "$COMMIT" "$AT" "$MIGRATED" "$BACKUP"

echo "state_written=$ID"
echo "state_ok=1"