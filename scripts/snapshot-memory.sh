#!/usr/bin/env bash
#
# snapshot-memory.sh — dated memory-only snapshot of the prod store.
#
# Wraps pull-remote-data.sh -m into ~/archie-snapshots/archie-memory-YYYYMMDD.tgz,
# skipping if today's snapshot already exists. The snapshot series is what
# memory:eval's trend metrics (growth, duplicate rate, turnover) run on, and
# the vehicle for watching the selection/pull sensors after the flag flips.
#
# Usage:
#   scripts/snapshot-memory.sh HOST CONTAINER [SNAPSHOT_DIR]
#
#   HOST          SSH target (user@host or ssh_config alias)
#   CONTAINER     Container name — REQUIRED here even though pull-remote-data.sh
#                 can auto-detect: auto-detect uses `mapfile`, which does not
#                 exist in the macOS /bin/bash 3.2 that launchd's default PATH
#                 (/usr/bin:/bin) resolves via the `env bash` shebang.
#   SNAPSHOT_DIR  Output dir (default ~/archie-snapshots)
#
# Env: ARCHIE_SNAPSHOT_HOST / ARCHIE_SNAPSHOT_CONTAINER / ARCHIE_SNAPSHOT_DIR
# may replace the positional args.
#
# Every run appends one line to $SNAPSHOT_DIR/snapshot.log — a failing
# scheduled run is visible there instead of silent.
#
# launchd setup (daily, survives sleep — StartCalendarInterval firings missed
# during sleep coalesce into one event on wake; StartInterval firings are
# missed outright, per launchd.plist(5)):
#
#   ~/Library/LaunchAgents/com.archie.snapshot-memory.plist:
#     <?xml version="1.0" encoding="UTF-8"?>
#     <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
#       "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
#     <plist version="1.0"><dict>
#       <key>Label</key><string>com.archie.snapshot-memory</string>
#       <key>ProgramArguments</key><array>
#         <string>/bin/bash</string>
#         <string>/PATH/TO/archie-hq/scripts/snapshot-memory.sh</string>
#         <string>YOUR_SSH_HOST</string>
#         <string>YOUR_CONTAINER_NAME</string>
#       </array>
#       <key>StartCalendarInterval</key><dict>
#         <key>Hour</key><integer>9</integer>
#         <key>Minute</key><integer>30</integer>
#       </dict>
#       <key>EnvironmentVariables</key><dict>
#         <key>PATH</key><string>/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin</string>
#       </dict>
#     </dict></plist>
#
#   launchctl load ~/Library/LaunchAgents/com.archie.snapshot-memory.plist
#
# Assumes the SSH key for HOST needs no passphrase prompt (use an ssh-agent
# available to launchd, or a dedicated key in ~/.ssh/config for this host).
# No plist is committed to the repo — it embeds a user-specific SSH host.
set -euo pipefail

HOST="${1:-${ARCHIE_SNAPSHOT_HOST:-}}"
CONTAINER="${2:-${ARCHIE_SNAPSHOT_CONTAINER:-}}"
SNAPSHOT_DIR="${3:-${ARCHIE_SNAPSHOT_DIR:-$HOME/archie-snapshots}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SNAPSHOT_DIR/snapshot.log"
STAMP="$(date +%Y%m%d)"
OUT="$SNAPSHOT_DIR/archie-memory-$STAMP.tgz"

mkdir -p "$SNAPSHOT_DIR"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$LOG"; }

if [[ -z "$HOST" || -z "$CONTAINER" ]]; then
  log "FAIL missing HOST/CONTAINER (args or ARCHIE_SNAPSHOT_HOST/ARCHIE_SNAPSHOT_CONTAINER)"
  echo "Usage: snapshot-memory.sh HOST CONTAINER [SNAPSHOT_DIR]" >&2
  exit 2
fi

if [[ -s "$OUT" ]]; then
  log "SKIP $OUT already exists"
  echo "Snapshot for $STAMP already exists: $OUT"
  exit 0
fi

if "$SCRIPT_DIR/pull-remote-data.sh" -m -o "$OUT" "$HOST" "$CONTAINER"; then
  log "OK   $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
  echo "Snapshot written: $OUT"
else
  rc=$?
  log "FAIL pull-remote-data.sh exited $rc"
  exit "$rc"
fi
