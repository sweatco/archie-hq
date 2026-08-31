#!/usr/bin/env bash
#
# switch-arm.example.sh — template for the arm switcher campaign.sh calls.
#
# A template rather than a working script because arms are experiment-specific:
# there is no permanent set of flags to switch between, and shipping a stale one
# named after tweaks that no longer exist would be worse than shipping none.
# Copy this to `switch-arm.sh` (gitignored) and fill in the case block.
#
# The two things that matter, both learned the hard way:
#
#  1. RESET EVERY KNOB FIRST. Without the reset an arm inherits the previous
#     arm's setting and quietly measures both at once.
#  2. CONFIRM THE ARM ACTUALLY TOOK, from the instance's own output — not from
#     the fact that your shell exported a variable. An arm whose setting never
#     reached the process records as "that tweak did nothing", which is the one
#     wrong conclusion the whole exercise exists to avoid. Make the app log what
#     it is running under, and grep for it here.
#
# Usage: ./switch-arm.sh <arm-name>
set -uo pipefail
cd "$(dirname "$0")/../.."

ARM="${1:-}"

# 1. Reset. List every knob any arm sets.
unset ARCHIE_EXAMPLE_FLAG_A ARCHIE_EXAMPLE_FLAG_B

# 2. Select. One knob per arm, so a difference is attributable to one thing.
case "$ARM" in
  baseline) ;;
  arm-a)    export ARCHIE_EXAMPLE_FLAG_A=1 ;;
  arm-b)    export ARCHIE_EXAMPLE_FLAG_B=1 ;;
  *) echo "unknown arm '$ARM'" >&2; exit 1 ;;
esac

# `src/` and `prompts/` are bind-mounted in docker-compose.yml, so this is a
# recreate (~20-30s), not a rebuild. Env changes need the recreate; code and
# prompt edits are picked up without one.
docker compose up -d --force-recreate archie >/dev/null 2>&1 \
  || { echo "compose up failed for arm '$ARM'" >&2; exit 1; }

URL="http://localhost:${PORT:-3000}/health"
for _ in $(seq 1 60); do
  if curl -s --max-time 3 "$URL" >/dev/null 2>&1; then
    # 3. Confirm. Replace this with a real check against the instance's own log:
    #    banner=$(docker compose logs --no-color --tail=400 archie | grep -m1 'Running with:')
    #    [[ "$banner" == *"$ARM"* ]] || { echo "arm did not take" >&2; exit 1; }
    echo "arm=$ARM healthy — NOTE: add a positive confirmation before trusting a result"
    exit 0
  fi
  sleep 3
done

echo "arm '$ARM': instance never became healthy" >&2
docker compose logs --no-color --tail=30 archie >&2
exit 1
