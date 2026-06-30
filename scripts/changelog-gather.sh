#!/usr/bin/env bash
# Build the LLM context for a day's changelog entry.
#
# The primary unit is the MERGED PULL REQUEST, not the commit: a PR's
# description is where a human explained *what and why*, which is exactly the
# intent a good changelog bullet needs — so the model never has to read code to
# understand a change. For each PR merged that day we emit its title, body,
# linked issues, commit subjects, and diffstat (files + ±lines as a scope
# signal). A raw-commit list is appended as a backstop so anything pushed
# straight to main without a PR is still covered.
#
# Usage: scripts/changelog-gather.sh <YYYY-MM-DD> <owner/repo> <out-file>
# Requires: gh (authenticated via GH_TOKEN), jq, git.
# Exit 0:  wrote <out-file>.
# Exit 10: nothing landed that day — caller should skip.
set -euo pipefail

DATE="${1:?usage: changelog-gather.sh <YYYY-MM-DD> <owner/repo> <out-file>}"
REPO="${2:?missing owner/repo}"
OUT="${3:?missing out-file}"

SINCE="$DATE 00:00:00 +0000"
UNTIL="$DATE 23:59:59 +0000"
SKIP_OWN='^docs(changelog): add entry for'

# Bail early if nothing landed at all (no PRs, no direct commits).
prs="$(gh pr list --repo "$REPO" --search "is:merged base:main merged:$DATE" \
        --json number --jq '.[].number' --limit 100 || true)"
commits="$(git log --no-merges --since="$SINCE" --until="$UNTIL" --pretty=format:'%h')"
if [ -z "$prs" ] && [ -z "$commits" ]; then
  exit 10
fi

tmp="$(mktemp)"
{
  echo "# Changes that landed on \`main\` on $DATE"
  echo

  if [ -n "$prs" ]; then
    echo "## Pull requests merged this day (primary source)"
    echo
    echo "One logical change is usually one PR = one changelog bullet. Each PR's"
    echo "description explains what and why — prefer it over the raw commits below."
    echo
    for n in $prs; do
      gh pr view "$n" --repo "$REPO" \
        --json number,title,url,body,labels,additions,deletions,changedFiles,files,commits,closingIssuesReferences \
        --jq '
          "### PR #\(.number) — \(.title)",
          "\(.url)",
          (if (.labels|length) > 0 then "Labels: " + ([.labels[].name] | join(", ")) else empty end),
          "Scope: \(.changedFiles) files, +\(.additions)/-\(.deletions)",
          (if (.files|length) > 0 then
             "Files: " + ([.files[] | "\(.path) (+\(.additions)/-\(.deletions))"][0:15] | join("; "))
           else empty end),
          (if (.closingIssuesReferences|length) > 0 then
             "Linked issues:",
             (.closingIssuesReferences[] | "  - #\(.number) \(.title): \(((.body // "") | gsub("\\s+"; " "))[0:400])")
           else empty end),
          "Commits:",
          (.commits[] | "  - \(.messageHeadline)"),
          "Description:",
          (.body // "(no description)"),
          ""
        '
    done
  fi

  echo "## All commits this day (backstop — covers anything pushed straight to main)"
  echo
  git log --no-merges --since="$SINCE" --until="$UNTIL" \
    --invert-grep --grep="$SKIP_OWN" \
    --pretty=format:'- %h %s%n%b'
} > "$tmp"

mv "$tmp" "$OUT"
echo "Wrote $OUT — $(echo "$prs" | grep -c . || true) PR(s), $(echo "$commits" | grep -c . || true) commit(s)."
