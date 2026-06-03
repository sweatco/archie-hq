#!/usr/bin/env bash
# archie-e2e: preconditions — required .env keys present (values never printed),
# memory flag, and this checkout's PORT. Resolves the repo root from its own location.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
[ -f .env ] || { echo ".env: NOT FOUND in $ROOT"; exit 1; }

# `|| true`: an absent key must yield an empty string, not abort the script (set -e + pipefail)
get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true; }

missing=0
for v in ANTHROPIC_API_KEY SLACK_BOT_TOKEN SLACK_APP_TOKEN; do
  if [ -n "$(get "$v")" ]; then echo "$v: present"; else echo "$v: MISSING"; missing=1; fi
done
mem="$(get ARCHIE_MEMORY)"
echo "ARCHIE_MEMORY: ${mem:-(unset -> enabled)}"
port="$(get PORT)"
echo "PORT: ${port:-3000}"
exit "$missing"
