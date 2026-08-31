#!/usr/bin/env bash
#
# campaign.sh — collect a speed campaign, one sample per process.
#
# Every sample is a separate `run.ts` invocation. At temperature 0, repetitions
# inside one process are correlated: a loop of N reps is closer to a single draw
# counted N times than to N independent draws. Rounds also rotate the case order
# so no case is permanently first (and permanently paying the cold cache).
#
# Two-arm mode alternates A and B round by round, calling your switch script
# between rounds, so latency drift over the measurement window hits both arms
# equally instead of being read as a difference between them.
#
# Usage:
#   ./campaign.sh <runs> <arm>                               single arm, no switching
#   ./campaign.sh <runs> <armA> <armB> <switch-script>       two arms, alternating
#   ./campaign.sh <runs> --arms a,b,c --switch <script>      N arms, round-robin
#
#   <switch-script> is invoked as `<switch-script> <arm-name>` before each round
#   and must leave the instance serving that arm (flip the setting, restart,
#   wait for health). It must exit non-zero if it could not.
#
# If an arm can only be selected by redeploying and you have no switch script,
# run each arm as its own single-arm campaign — and read the comparison knowing
# the arms are separated in time. Prefer ABBA over AB in that case: run A, then
# B, then B, then A, and check A reproduces itself before trusting A-vs-B.
set -uo pipefail

cd "$(dirname "$0")"

RUNS="${1:-}"
shift || true

ARMS=()
SWITCH=""
if [[ "${1:-}" == "--arms" ]]; then
  IFS=',' read -r -a ARMS <<< "${2:-}"
  shift 2 || true
  [[ "${1:-}" == "--switch" ]] && { SWITCH="${2:-}"; shift 2 || true; }
else
  # Legacy positional forms: <arm> | <armA> <armB> <switch-script>
  [[ -n "${1:-}" ]] && ARMS+=("$1")
  [[ -n "${2:-}" ]] && ARMS+=("$2")
  SWITCH="${3:-}"
fi

if [[ -z "$RUNS" || ${#ARMS[@]} -eq 0 ]]; then
  sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
if [[ ${#ARMS[@]} -gt 1 && -z "$SWITCH" ]]; then
  echo "multi-arm mode needs a switch script — see the header, or run each arm separately" >&2
  exit 1
fi
if [[ -n "$SWITCH" && ! -x "$SWITCH" ]]; then
  echo "switch script '$SWITCH' is not executable" >&2
  exit 1
fi
echo "arms: ${ARMS[*]}  runs: $RUNS"

OUT="${SPEED_OUT:-results}"
LOGS="${SPEED_LOGS:-logs}"
mkdir -p "$OUT" "$LOGS"

# Read ids off the marker-prefixed listing, not off column 1 of arbitrary
# output: tooling in the environment can print a banner to stdout before we do.
# A while-read loop rather than `mapfile`, which needs bash 4 (macOS ships 3.2).
CASES=()
while IFS= read -r id; do
  [[ -n "$id" ]] && CASES+=("$id")
done < <(npx tsx run.ts --ids 2>/dev/null | sed -n 's/^CASE\t//p')

if [[ ${#CASES[@]} -eq 0 ]]; then
  echo "no cases found — is the harness importable? try: npx tsx run.ts --list" >&2
  exit 1
fi
echo "cases: ${CASES[*]}"

# A failing run is data, not a reason to abandon the campaign: a change that
# makes one case time out must still show up in the fold as a timeout.
failures=0

run_round() {
  local arm="$1" round="$2" offset="$3"
  if [[ -n "$SWITCH" ]]; then
    echo "--- switching to arm '$arm'"
    if ! "$SWITCH" "$arm"; then
      echo "switch script failed for arm '$arm'; aborting" >&2
      exit 1
    fi
  fi
  local n=${#CASES[@]}
  for ((i = 0; i < n; i++)); do
    local c="${CASES[$(((i + offset) % n))]}"
    echo "[$arm r$round] $c"
    npx tsx run.ts --case "$c" --arm "$arm" --out "$OUT" \
      >>"$LOGS/$arm-r$round.log" 2>&1 || failures=$((failures + 1))
    tail -n 2 "$LOGS/$arm-r$round.log"
  done
}

# Round-robin, not arm-at-a-time: every arm is sampled in every round, so API
# latency drift over a multi-hour campaign lands on all of them equally instead
# of being read as a difference between the arm that ran first and the one that
# ran last.
for ((r = 1; r <= RUNS; r++)); do
  for arm in "${ARMS[@]}"; do
    run_round "$arm" "$r" "$r"
  done
done

echo
echo "campaign done — $failures failing run(s) (kept, not discarded)"
echo "fold each arm:"
for arm in "${ARMS[@]}"; do
  echo "  npx tsx measure.ts fold --runs $OUT --arm $arm"
done
if [[ ${#ARMS[@]} -gt 1 ]]; then
  echo "then compare each against the first:"
  for arm in "${ARMS[@]:1}"; do
    echo "  npx tsx measure.ts compare $OUT/samples-${ARMS[0]}.json $OUT/samples-$arm.json"
  done
fi
