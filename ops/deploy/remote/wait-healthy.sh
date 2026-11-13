#!/usr/bin/env bash
# ops/deploy/remote/wait-healthy.sh — the stack answers on the port a student
# uses. Polls `/` on the frontend's published port and `/api/health` inside the
# network, for at most TIMEOUT seconds.
set -euo pipefail

PORT="$1"
TIMEOUT="${2:-300}"
URL="http://127.0.0.1:${PORT}/"

i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)
  if [ "$code" = "200" ]; then echo "healthy=1"; echo "checks=$((i + 1))"; echo "wait_ok=1"; exit 0; fi
  i=$((i + 1))
  sleep 1
done
echo "error=timeout-after-${TIMEOUT}s" >&2
exit 1
