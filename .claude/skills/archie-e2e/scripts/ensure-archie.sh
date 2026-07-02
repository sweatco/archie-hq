#!/usr/bin/env bash
# archie-e2e: ensure a healthy, Slack-connected Archie for THIS checkout.
# Boots it (npm run docker:dev) when down. Pass --restart to force a
# clean container restart (use when unhealthy or socket-mode warnings spam logs).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"

# Health comes from the compose healthcheck (authoritative, and independent of the
# host port mapping — which varies per worktree): `docker compose ps` shows the
# STATUS as "(healthy)". Note that "(unhealthy)" and "(health: starting)" do NOT
# contain the literal substring "(healthy)", so the fixed-string match is exact.
healthy() { docker compose ps archie 2>/dev/null | grep -qF '(healthy)'; }

if [ "${1:-}" = "--restart" ]; then
  # Fall back to a fresh build+up when there is no container yet (fresh worktree's first run).
  # `npm run docker:dev -- -d` => `docker compose up --build -d` (detached, so we can poll status).
  docker compose restart archie || npm run docker:dev -- -d
elif ! healthy; then
  npm run docker:dev -- -d
fi

echo "waiting for archie to become healthy ..."
ok=""
for _ in $(seq 1 60); do
  if healthy; then ok=1; break; fi
  sleep 3
done
[ -n "$ok" ] || { echo "FAILED: archie did not become healthy"; docker compose ps 2>/dev/null || true; exit 1; }
docker compose ps archie
echo
echo "--- startup/slack lines ---"
docker compose logs archie 2>/dev/null \
  | grep -iE "socket mode connected|cli-only mode|bot user id|server is running" \
  | tail -6 || true
