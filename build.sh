#!/bin/sh
# The entire build. There is no bundler, no npm install and no output
# directory -- this writes one 60-byte file and stops.
#
# It exists because a version stamp is only worth having if nobody has to
# remember to update it. Cloudflare Workers Builds puts the commit it is
# building in the environment; this copies it where the pages can read it.
#
# Set as the project's Build command:  sh build.sh
set -e

SHA="${WORKERS_CI_COMMIT_SHA:-${CF_PAGES_COMMIT_SHA:-unknown}}"
REF="${WORKERS_CI_BRANCH:-${CF_PAGES_BRANCH:-unknown}}"
BUILT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf '{ "sha": "%s", "ref": "%s", "built": "%s" }\n' "$SHA" "$REF" "$BUILT" > version.json

echo "version.json:"
cat version.json
