#!/bin/sh
# nginx/15-lti-frame-ancestors.sh - renders /etc/nginx/lti-pick.conf from LTI_FRAME_ANCESTORS.
#
# Run by the nginx image's /docker-entrypoint.sh at container start (it executes every executable
# /docker-entrypoint.d/*.sh; Dockerfile.frontend copies this one there). nginx.conf includes the output in
# `location = /lti/pick`, where it becomes the CSP `frame-ancestors` of that one page: the LMS origins that may
# show it in an iframe (Moodle 5's "Select content" modal). Unset or blank means 'self' (nobody else).
#
# The value ends up in an nginx string and a CSP header, so anything but `'self'` or http(s) origins
# (scheme://host[:port], no path) makes this exit 1 and the container not start: an operator typo must neither
# widen who may frame the page nor break the config in a confusing way. Globbing is off so `*` stays a word
# that fails validation instead of expanding to file names.
set -eu
set -f

out="${LTI_PICK_CONF:-/etc/nginx/lti-pick.conf}"
sources=""
for entry in ${LTI_FRAME_ANCESTORS:-}; do
  case "$entry" in
    "'self'") ;;
    *)
      printf '%s' "$entry" | grep -Eq '^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$' || {
        echo "15-lti-frame-ancestors: LTI_FRAME_ANCESTORS has an invalid entry '$entry'; use 'self' or space-separated origins like https://moodle.example.edu" >&2
        exit 1
      } ;;
  esac
  sources="${sources:+$sources }$entry"
done

printf 'set $csp_ancestors "%s";\n' "${sources:-'self'}" > "$out"
