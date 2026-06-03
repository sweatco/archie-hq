#!/usr/bin/env bash
# archie-e2e: find the task created for <nonce>, print its attribution line,
# poll events until task:completed / task:stopped / approval:requested / timeout,
# then print pm-agent replies.
#
# Usage: wait-task.sh <nonce> [timeout_seconds]   (default timeout 240)
# Exit 0 with STATE=COMPLETED|STOPPED|APPROVAL_REQUESTED|TIMEOUT; exit 1 if no task found.
set -euo pipefail
NONCE="${1:?usage: wait-task.sh <nonce> [timeout_seconds]}"
TIMEOUT="${2:-240}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PORT="$(grep -E '^PORT=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)"
PORT="${PORT:-3000}"
API="http://localhost:$PORT/api"

# 1) find the task whose knowledge log contains the nonce (scan newest 5, retry)
TASK=""
for _ in $(seq 1 20); do
  for id in $(curl -fsS "$API/tasks" 2>/dev/null | grep -oE '"task_id":"task-[^"]+"' | cut -d'"' -f4 | head -5); do
    if curl -fsS "$API/tasks/$id" 2>/dev/null | grep -q "$NONCE"; then TASK="$id"; break 2; fi
  done
  sleep 3
done
[ -n "$TASK" ] || { echo "NO_TASK_FOUND for nonce $NONCE"; exit 1; }
echo "TASK=$TASK"

# 2) attribution line (first knowledge-log line: should carry @<U…:Name> + the nonce)
curl -fsS "$API/tasks/$TASK" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
log = d.get("knowledgeLog") or ""
print("LOG_HEAD:", log.splitlines()[0][:240] if log.strip() else "(empty)")
'

# 3) poll events to a terminal/actionable state
URL="$API/tasks/$TASK/events"
state="TIMEOUT"
end=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$end" ]; do
  body="$(curl -fsS -m 5 "$URL" 2>/dev/null || true)"
  case "$body" in
    *'"type":"approval:requested"'*) state="APPROVAL_REQUESTED"; break ;;
    *'"type":"task:completed"'*)     state="COMPLETED"; break ;;
    *'"type":"task:stopped"'*)       state="STOPPED"; break ;;
  esac
  sleep 3
done
echo "STATE=$state"

# 4) pm-agent replies seen so far
curl -fsS "$URL" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
for e in d.get("events", []):
    data = e.get("data") or {}
    if e.get("type") == "message" and data.get("from") == "pm-agent":
        print("PM_REPLY:", json.dumps(data.get("message", ""))[:300])
'
