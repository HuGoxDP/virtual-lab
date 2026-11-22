#!/bin/sh
# nginx/10-https-redirect.sh - renders /etc/nginx/https-redirect.conf from HTTPS_REDIRECT_PORT.
#
# Run by the nginx image's /docker-entrypoint.sh at container start (it executes every executable
# /docker-entrypoint.d/*.sh; Dockerfile.frontend copies this one there). nginx.conf includes the output
# in the server block: unset or blank = an empty include, so the plain stack is untouched; a valid port
# = `if ($vl_forwarded_proto = http)` with `return 301 https://$host:<port>$request_uri` — path+query
# preserved, host from the request, and `return` is the only safe if-in-server body (P5b D2).
#
# P5d: the condition reads the map nginx.conf already builds (`map $http_x_forwarded_proto
# $vl_forwarded_proto`, which falls back to $scheme), not `$scheme` itself. Behind the admin's own
# TLS proxy — the stack's built-for arrangement — every request reaches :80 as plain http with
# `X-Forwarded-Proto: https`, so `$scheme` would answer 301 to itself forever; the map honours the
# last proxy's word and serves the request. A direct :80 client that claims https only skips its own
# redirect, which is the same trust D4 already accepts for the API (research D4; B6 uses the map too).
#
# The value ends up in an nginx directive, so anything but a port number (1-65535) makes this exit 1
# and the container not start: an operator typo must neither break the config in a confusing way nor
# inject directives. Globbing is off so `*` stays a word that fails validation instead of expanding.
set -eu
set -f

out="${HTTPS_REDIRECT_CONF:-/etc/nginx/https-redirect.conf}"
port="$(printf '%s' "${HTTPS_REDIRECT_PORT:-}" | tr -d '[:space:]')"

if [ -z "$port" ]; then
  : > "$out"
  exit 0
fi

printf '%s' "$port" | grep -Eq '^[0-9]{1,5}$' || {
  echo "10-https-redirect: HTTPS_REDIRECT_PORT must be a port number (1-65535), got '${HTTPS_REDIRECT_PORT}'" >&2
  exit 1
}
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || {
  echo "10-https-redirect: HTTPS_REDIRECT_PORT out of range (1-65535): '${HTTPS_REDIRECT_PORT}'" >&2
  exit 1
}

printf 'if ($vl_forwarded_proto = http) {\n    return 301 https://$host:%s$request_uri;\n}\n' "$port" > "$out"
