#!/bin/zsh
# Arm-interleaved decorrelated campaign.
#
# Two lessons are baked in here. Reps inside one process are correlated samples,
# so each arm is sampled as RUNS separate invocations. And API latency/behaviour
# drifts over a measurement window, so the two arms alternate run by run rather
# than one arm going first — each pair of runs is adjacent in time.
#
#   ./campaign3.sh <candidate> <runs> <armA-name> <armA-prompt> <armB-name> <armB-prompt>
#
# <candidate> is a key from providers.mjs's CANDIDATES map, e.g. cerebras-gemma-4-31b (what
# production runs) or haiku-4.5 (a comparison arm). Per-run logs land in
# logs/defect-<arm>-r<n>.log and logs/quality-<arm>-r<n>.log; per-run graded
# quality rows land in results/quality-<arm>-r<n>.json. defect.mjs writes its own
# results/defect-<arm>-<candidate>.json per invocation, already named by arm.
#
# The two arms here are two prompt files. To compare *context* arms instead —
# bare against full, on one prompt — the interleaving is the same shape but the
# variable is CONTEXT_ARM; the README's "Running the full-context arm" section
# has the loop, and it deliberately labels the two with different ARM prefixes so
# the result files can be globbed apart afterwards.
#
# Pacing is inherited, not set here: `POOL=3 MIN_GAP_MS=1500 ./campaign3.sh ...`
# paces every run of the campaign, and unset means each driver's own historical
# concurrency with no inter-request gap. That matters for a large candidate — the
# tokens-per-minute limit is per account, so two overlapping campaigns share one
# budget. Each run's log ends with a `sample ...` line stating how many rows it
# actually graded; a run that lost rows to a 429 says so there and is fenced with
# a banner. Read those before reading any comparison built from the files.
set -e
cd "$(dirname "$0")"
mkdir -p logs results
# emitter.mjs imports src/voice/comprehension.ts directly (the real parser,
# not a hand copy — see emitter.mjs's own doc), so the drivers need tsx's
# loader, not plain node, which fails fast with ERR_UNKNOWN_FILE_EXTENSION on
# a .ts import. The local binary is used directly rather than `npx tsx`: npx's
# own resolution adds ~250-350ms/process that a dozen-process campaign gains
# nothing from paying.
TSX="../../node_modules/.bin/tsx"
CANDIDATE=$1; RUNS=$2; A=$3; AP=$4; B=$5; BP=$6
# This script's two arms are two PROMPT FILES. The context arm is a different
# axis and is inherited from the environment, unchanged, by every run — so
# `CONTEXT_ARM=full ./campaign3.sh ...` compares two prompts with production's
# whole request, which is a legitimate thing to want. What it must not do is
# lose track of where quality.mjs wrote its output: that filename carries the
# context arm too, and a stale `mv` under `set -e` would abort the campaign
# mid-run. TAG mirrors `armFileTag` in context-arm.mjs (empty for bare, which is
# what keeps an ordinary run writing exactly where it always has); defect.mjs
# needs nothing here, because it names its own file.
TAG=""
if [[ -n "${CONTEXT_ARM:-}" && "${CONTEXT_ARM}" != "bare" ]]; then TAG="-${CONTEXT_ARM}"; fi
for i in $(seq 1 $RUNS); do
  for pair in "$A:$AP" "$B:$BP"; do
    NAME="${pair%%:*}"; PROMPT="${pair##*:}"
    PROMPT_FILE="$PROMPT" ARM="${NAME}-r${i}" "$TSX" defect.mjs "$CANDIDATE" 2 > "logs/defect-${NAME}-r${i}.log" 2>&1
    PROMPT_FILE="$PROMPT" "$TSX" quality.mjs "$CANDIDATE" 1 > "logs/quality-${NAME}-r${i}.log" 2>&1
    mv "results/quality${TAG}-${CANDIDATE}.json" "results/quality${TAG}-${NAME}-r${i}.json"
  done
  echo "run $i of $RUNS done (both arms)"
done
