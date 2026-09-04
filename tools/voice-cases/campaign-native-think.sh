#!/bin/zsh
# One campaign, kept out of campaign3.sh on purpose.
#
# campaign3.sh varies the PROMPT FILE and holds the candidate fixed. This comparison cannot use it, because the change under test moved the request shape as well as the prompt: arm A is the
# prompt that asks for `<think>` tags against the pre-thinking body (no `reasoning_effort`, a 600-token cap), arm B is the live prompt against the body production sends now (`reasoning_effort:
# medium`, 2000). Two candidates, two prompts, and one switch — STRIP_THINK — that belongs to arm A alone, because only its prompt asks for tags a room must not hear.
#
# Both of this directory's standing properties are kept: each rep is its own process (reps inside one process are correlated at temperature 0), and the arms alternate run by run so latency and
# behaviour drift over the window cannot be read as a difference between them. Pacing is the drivers' own defaults, as the campaign brief asked: POOL=5 in defect.mjs, no inter-dispatch gap.
set -e
cd "$(dirname "$0")"
mkdir -p logs results
TSX="../../node_modules/.bin/tsx"

A_PROMPT="/private/tmp/claude-501/-Users-khmelev-Projects-swc-archie-hq--claude-worktrees-shard-trigger-folder-explore-51bab5/7678b222-24d2-4d84-9664-f598b7959c37/scratchpad/voice-speaking.prompted-think.md"
B_PROMPT="../../prompts/voice-speaking.md"
A_MODEL="cerebras-gemma-4-31b"
B_MODEL="cerebras-gemma-4-31b-thinking"

for i in 1 2 3; do
  # Arm A — production before native thinking.
  PROMPT_FILE="$A_PROMPT" STRIP_THINK=1 ARM="prompted-think-r${i}" \
    "$TSX" defect.mjs "$A_MODEL" 1 > "logs/defect-prompted-think-r${i}.log" 2>&1
  PROMPT_FILE="$A_PROMPT" STRIP_THINK=1 \
    "$TSX" quality.mjs "$A_MODEL" 1 > "logs/quality-prompted-think-r${i}.log" 2>&1
  mv "results/quality-${A_MODEL}.json" "results/quality-prompted-think-r${i}.json"

  # Arm B — production now.
  PROMPT_FILE="$B_PROMPT" ARM="native-think-r${i}" \
    "$TSX" defect.mjs "$B_MODEL" 1 > "logs/defect-native-think-r${i}.log" 2>&1
  PROMPT_FILE="$B_PROMPT" \
    "$TSX" quality.mjs "$B_MODEL" 1 > "logs/quality-native-think-r${i}.log" 2>&1
  mv "results/quality-${B_MODEL}.json" "results/quality-native-think-r${i}.json"

  echo "run $i of 3 done (both arms)"
done
echo "CAMPAIGN DONE"
