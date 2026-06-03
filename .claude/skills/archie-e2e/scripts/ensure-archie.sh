#!/usr/bin/env bash
# archie-e2e: ensure a healthy, Slack-connected Archie for THIS checkout.
# Boots it (docker compose up --build -d) when down. Pass --restart to force a
# clean container restart (use when unhealthy or socket-mode warnings spam logs).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)"
PORT="${PORT:-3000}"
HEALTH="http://localhost:$PORT/health"

if [ "${1:-}" = "--restart" ]; then
  docker compose restart archie
elif ! curl -fsS -m 5 "$HEALTH" >/dev/null 2>&1; then
  docker compose up --build -d
fi

echo "waiting for health on :$PORT ..."
curl --retry 60 --retry-delay 3 --retry-all-errors -fsS -m 5 "$HEALTH" \
  || { echo "FAILED: no health on :$PORT"; exit 1; }
echo
echo "--- startup/slack lines ---"
docker compose logs archie 2>/dev/null \
  | grep -iE "socket mode connected|cli-only mode|bot user id|memory layer initialized|server is running" \
  | tail -6 || true
