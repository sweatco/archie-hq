#!/usr/bin/env bash
# archie-e2e: resolve the dev bot identity + workspace from SLACK_BOT_TOKEN via
# Slack auth.test. Prints bot_user_id / bot_user / team. Never prints the token.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
tok="$(grep -E '^SLACK_BOT_TOKEN=' "$ROOT/.env" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true)"
[ -n "$tok" ] || { echo "SLACK_BOT_TOKEN missing in .env"; exit 1; }

resp="$(curl -fsS -m 10 -X POST -H "Authorization: Bearer $tok" https://slack.com/api/auth.test)"
field() { printf '%s' "$resp" | grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
ok="$(printf '%s' "$resp" | grep -oE '"ok":(true|false)' | head -1 | cut -d: -f2 || true)"

echo "ok: ${ok:-unknown}"
echo "bot_user_id: $(field user_id)"
echo "bot_user: $(field user)"
echo "team: $(field team) $(field team_id)"
err="$(field error || true)"
[ -n "$err" ] && echo "error: $err"
[ "$ok" = "true" ]
