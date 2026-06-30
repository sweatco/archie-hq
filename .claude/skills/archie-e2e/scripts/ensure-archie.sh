#!/usr/bin/env bash
# archie-e2e: ensure a healthy, Slack-connected Archie for THIS checkout.
# Boots it (npm run docker:dev) when down. Pass --restart to force a
# clean container restart (use when unhealthy or socket-mode warnings spam logs).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true)"
PORT="${PORT:-3000}"
HEALTH="http://localhost:$PORT/health"

if [ "${1:-}" = "--restart" ]; then
  # Fall back to a fresh build+up when there is no container yet (fresh worktree's first run).
  # `npm run docker:dev -- -d` => `docker compose up --build -d` (detached, so we can poll /health).
  docker compose restart archie || npm run docker:dev -- -d
elif ! curl -fsS -m 5 "$HEALTH" >/dev/null 2>&1; then
  npm run docker:dev -- -d
fi

echo "waiting for health on :$PORT ..."
# Manual retry loop instead of `curl --retry-all-errors` (that flag needs curl
# >=7.71, absent on stock macOS which ships 7.64): retries on ANY failure incl.
# connection-refused during boot, portable across macOS/Linux curl versions.
ok=""
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "$HEALTH" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
[ -n "$ok" ] || { echo "FAILED: no health on :$PORT"; exit 1; }
curl -fsS -m 5 "$HEALTH" || true
echo
echo "--- startup/slack lines ---"
docker compose logs archie 2>/dev/null \
  | grep -iE "socket mode connected|cli-only mode|bot user id|server is running" \
  | tail -6 || true
