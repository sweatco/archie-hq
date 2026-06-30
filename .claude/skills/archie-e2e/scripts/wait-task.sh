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
case "$TIMEOUT" in ''|*[!0-9]*) echo "timeout must be a positive integer (got '$TIMEOUT')"; exit 2 ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PORT="$(grep -E '^PORT=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true)"
PORT="${PORT:-3000}"
API="http://localhost:$PORT/api"

# One time budget shared by discovery + event polling: `wait-task.sh <nonce> 240`
# means "spend up to 240s total locating the task and waiting for it to settle".
DEADLINE=$(( $(date +%s) + TIMEOUT ))

# 1) find the task whose knowledge log contains the nonce. Scan a generous window
#    (head -40): task ids are minute-granular with a random suffix, so the newest
#    task is not guaranteed to sort first. `-m 5` so a hung API can't stall the loop.
TASK=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  for id in $(curl -fsS -m 5 "$API/tasks" 2>/dev/null | grep -oE '"task_id":"task-[^"]+"' | cut -d'"' -f4 | head -40); do
    if curl -fsS -m 5 "$API/tasks/$id" 2>/dev/null | grep -qF -- "$NONCE"; then TASK="$id"; break 2; fi
  done
  sleep 3
done
[ -n "$TASK" ] || { echo "NO_TASK_FOUND for nonce $NONCE"; exit 1; }
echo "TASK=$TASK"

# 2) attribution line (first knowledge-log line: carries the @<U…:Name> marker).
#    The nonce match is ALREADY guaranteed — it is how we located the task above —
#    so assert on the @<U…:Name> marker, not on the (possibly truncated) nonce.
#    `|| true`: a transient blip here must not abort the run after the task is found.
curl -fsS -m 10 "$API/tasks/$TASK" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("LOG_HEAD: (unavailable)"); sys.exit(0)
log = d.get("knowledgeLog") or ""
print("LOG_HEAD:", log.splitlines()[0][:512] if log.strip() else "(empty)")
' || true

# 3) poll events to a terminal/actionable state. Check terminal states BEFORE
#    approval:requested: the events endpoint replays the FULL history, so a task
#    that cleared an approval gate and then finished carries both markers — terminal
#    must win, else an approved+completed task loops on APPROVAL_REQUESTED forever.
URL="$API/tasks/$TASK/events"
state="TIMEOUT"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  body="$(curl -fsS -m 5 "$URL" 2>/dev/null || true)"
  case "$body" in
    *'"type":"task:completed"'*)     state="COMPLETED"; break ;;
    *'"type":"task:stopped"'*)       state="STOPPED"; break ;;
    *'"type":"approval:requested"'*) state="APPROVAL_REQUESTED"; break ;;
  esac
  sleep 3
done
echo "STATE=$state"

# 4) pm-agent replies seen so far. `|| true` for the same transient-blip reason.
curl -fsS -m 10 "$URL" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for e in d.get("events", []):
    data = e.get("data") or {}
    if e.get("type") == "message" and data.get("from") == "pm-agent":
        print("PM_REPLY:", json.dumps(data.get("message", ""))[:300])
' || true
