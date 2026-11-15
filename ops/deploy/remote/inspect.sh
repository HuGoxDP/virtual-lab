#!/usr/bin/env bash
# ops/deploy/remote/inspect.sh — what is on the server. Read-only: it changes
# nothing, and it never reads the content of `shared/.env` — only whether it
# exists (D-12). Prints machine-readable key=value lines.
set -euo pipefail

DEPLOY_PATH="$1"

echo "os=$(uname -s | tr 'A-Z' 'a-z')"
echo "arch=$(uname -m)"
# Every command that could inherit the script's own stdin gets `< /dev/null`:
# the script travels on it (`bash -s --`, decision D-14), and a child that reads
# it consumes the rest of the script.
echo "docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null < /dev/null || echo missing)"
echo "compose=$(docker compose version --short 2>/dev/null < /dev/null || echo missing)"
echo "user_docker=false"
if docker info < /dev/null >/dev/null 2>&1; then echo "user_docker=true"; fi
echo "free_disk_kb=$(df -Pk "$DEPLOY_PATH" 2>/dev/null < /dev/null | awk 'NR==2{print $4}')"
echo "env_present=false"
if [ -f "$DEPLOY_PATH/shared/.env" ]; then echo "env_present=true"; fi
# The release the host is running now, by the id `up` recorded. A host with none
# is a fresh install — and this is the host's own answer, not the record the
# pipeline keeps for itself (a hand-made deployment has no record and is still
# not fresh: OPS1 phase 5).
CURRENT=$(cat "$DEPLOY_PATH/releases/current" 2>/dev/null || true)
echo "current=${CURRENT:-none}"
echo "releases=$(ls -1 "$DEPLOY_PATH/releases" 2>/dev/null | wc -l)"
echo "containers=$(docker ps --format '{{.Names}}' 2>/dev/null < /dev/null | wc -l)"
echo "projects=$(docker ps --format '{{.Label \"com.docker.compose.project\"}}' 2>/dev/null < /dev/null | sort -u | tr '\n' ',' || true)"
for v in virtual_lab_pgdata virtual_lab_archives virtual_lab_assets virtual_lab_lti virtual_lab_previews; do
  if docker volume inspect "$v" < /dev/null >/dev/null 2>&1; then echo "volume_$v=present"; else echo "volume_$v=absent"; fi
done
echo "inspect_ok=1"
