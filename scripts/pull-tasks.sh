#!/usr/bin/env bash
#
# pull-tasks.sh — download Archie task session folders from a remote host that
# runs Archie directly on disk (sessions live under a host path, not a docker
# volume — that's what scripts/pull-remote-data.sh is for).
#
# Streams an uncompressed-on-disk / gzip-on-the-wire tar of one or more
# sessions/<taskId> folders out of the remote host over SSH and extracts them
# locally. Tasks can be named explicitly by id, and/or selected by the day they
# were created (task ids are `task-YYYYMMDD-HHMM-<rand>`, so a day maps to the
# glob `task-YYYYMMDD-*`).
#
# The per-task repos/ git worktrees are excluded by default — they are
# redundant checkouts and can be gigabytes. Pass --include-repos to keep them.
#
# Usage:
#   scripts/pull-tasks.sh [options] [TASK_ID ...]
#
# Arguments:
#   TASK_ID       One or more task folder names (with or without the `task-`
#                 prefix), e.g. task-20260608-1152-ag25iy or 20260608-1152-ag25iy
#
# Options:
#   -d, --day DATE        Pull every task created on DATE (YYYYMMDD; dashes ok,
#                         e.g. 2026-06-08). Repeatable. Combine with TASK_IDs.
#   -o, --out DIR         Extract into DIR (default: <repo>/workdir/debug)
#   -H, --host HOST       SSH target (user@host or ssh_config alias). Required;
#                         defaults to the ARCHIE_SSH_HOST env var if set.
#       --remote-dir DIR  Remote sessions dir
#                         (default: /opt/apps/archie-hq/workdir/sessions, or the
#                         ARCHIE_SSH_SESSIONS_DIR env var if set)
#   -r, --include-repos   Keep sessions/*/repos worktrees (default: excluded)
#       --no-sudo         Don't run the remote tar via sudo (default: use sudo)
#   -n, --dry-run         Resolve and list matching task folders, download nothing
#   -h, --help            Show this help
#
# Examples (set ARCHIE_SSH_HOST once, or pass -H deploy@host each time):
#   export ARCHIE_SSH_HOST=deploy@archie.example.com
#   scripts/pull-tasks.sh task-20260608-1152-ag25iy   # → workdir/debug/
#   scripts/pull-tasks.sh -o ./snapshot 20260608-1152-ag25iy 20260609-0903-xk12qd
#   scripts/pull-tasks.sh --day 2026-06-08
#   scripts/pull-tasks.sh -H deploy@host -n -d 20260608 -d 20260609
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'; }

# Repo root = parent of this script's dir, so the default output lands in the
# repo's workdir/debug regardless of the caller's cwd.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Host has no hardcoded default (this is an open-source repo — keep infra
# hostnames out of it). Set ARCHIE_SSH_HOST in your environment, or pass -H.
HOST="${ARCHIE_SSH_HOST:-}"
REMOTE_DIR="${ARCHIE_SSH_SESSIONS_DIR:-/opt/apps/archie-hq/workdir/sessions}"
OUT="$REPO_ROOT/workdir/debug"
INCLUDE_REPOS=0
SUDO=1
DRY_RUN=0

IDS=()
DAYS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--day)          DAYS+=("$2"); shift 2 ;;
    -o|--out)          OUT="$2"; shift 2 ;;
    -H|--host)         HOST="$2"; shift 2 ;;
    --remote-dir)      REMOTE_DIR="$2"; shift 2 ;;
    -r|--include-repos) INCLUDE_REPOS=1; shift ;;
    --no-sudo)         SUDO=0; shift ;;
    -n|--dry-run)      DRY_RUN=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    --)                shift; while [[ $# -gt 0 ]]; do IDS+=("$1"); shift; done ;;
    -*)                echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)                 IDS+=("$1"); shift ;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "error: no SSH host — pass -H HOST or set ARCHIE_SSH_HOST" >&2
  usage >&2
  exit 2
fi

if [[ ${#IDS[@]} -eq 0 && ${#DAYS[@]} -eq 0 ]]; then
  echo "error: specify at least one TASK_ID or --day" >&2
  usage >&2
  exit 2
fi

# --- Build the remote glob patterns, validating every input -------------------
# Patterns are matched (and globbed) on the remote inside the sessions dir. Each
# input is validated against the known task-id charset so it is safe to embed in
# the remote shell command below.
PATTERNS=()

for id in "${IDS[@]:-}"; do
  [[ -z "$id" ]] && continue
  id="${id#task-}"                       # normalize: accept with or without prefix
  if [[ ! "$id" =~ ^[0-9]{8}-[0-9]{4}-[a-z0-9]+$ ]]; then
    echo "error: '$id' is not a valid task id (expected [task-]YYYYMMDD-HHMM-xxxx)" >&2
    exit 2
  fi
  PATTERNS+=("task-$id")
done

for day in "${DAYS[@]:-}"; do
  [[ -z "$day" ]] && continue
  day="${day//-/}"                        # tolerate 2026-06-08
  if [[ ! "$day" =~ ^[0-9]{8}$ ]]; then
    echo "error: '$day' is not a valid day (expected YYYYMMDD)" >&2
    exit 2
  fi
  PATTERNS+=("task-$day-*")
done

# Remote sudo prefix. `sudo -n` fails fast instead of hanging on a password
# prompt with no tty when passwordless sudo isn't configured.
SUDO_CMD=""
[[ "$SUDO" -eq 1 ]] && SUDO_CMD="sudo -n"

# --- Resolve patterns to real task folders on the remote ----------------------
# Glob expansion runs *inside* sudo (as root) so it works even when the SSH user
# can't read REMOTE_DIR. A pattern that matches nothing is dropped by the
# `[ -d ]` test rather than passed on as a literal.
echo "› Resolving tasks on $HOST:$REMOTE_DIR ..." >&2
# NB: no single quotes inside this string — it is wrapped in sh -c '...' below,
# so an inner ' would terminate that quoting. `echo` (not printf '%s\n') keeps
# it quote-free; task folder names are plain `task-...` so echo can't mangle them.
RESOLVE="cd \"$REMOTE_DIR\" || exit 3; for p in ${PATTERNS[*]}; do for d in \$p; do [ -d \"\$d\" ] && echo \"\$d\"; done; done"

MEMBERS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && MEMBERS+=("$line")
done < <(ssh "$HOST" "$SUDO_CMD sh -c '$RESOLVE'" | sort -u)

if [[ ${#MEMBERS[@]} -eq 0 ]]; then
  echo "error: no matching task folders found under $HOST:$REMOTE_DIR" >&2
  exit 1
fi

echo "› Matched ${#MEMBERS[@]} task(s):" >&2
printf '    %s\n' "${MEMBERS[@]}" >&2

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "› Dry run — nothing downloaded." >&2
  exit 0
fi

# --- Pull & extract -----------------------------------------------------------
EXCLUDE=""
[[ "$INCLUDE_REPOS" -eq 0 ]] && EXCLUDE="--exclude='*/repos'"

mkdir -p "$OUT"

echo "› Downloading into $OUT/ ..." >&2
# shellcheck disable=SC2029  # $SUDO_CMD/$EXCLUDE/members are meant to expand locally
if ! ssh "$HOST" "$SUDO_CMD tar -C \"$REMOTE_DIR\" $EXCLUDE -czf - ${MEMBERS[*]}" | tar -xzf - -C "$OUT"; then
  echo "error: download/extract failed (see message above)." >&2
  exit 1
fi

echo "✓ Pulled ${#MEMBERS[@]} task(s) into $OUT/" >&2
