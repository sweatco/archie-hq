---
name: github
description: "Use before reading anything on GitHub: pull requests, diffs, reviews and review threads, CI checks, workflow runs and job logs, code scanning alerts. Covers the `gh` commands that work in this sandbox and what must go through repo tools instead. Triggers on a PR, check, run or alert link or number, \"why is CI red\", \"what did the reviewer say\", \"is it mergeable\", and a \"checks updated\" event."
---

# GitHub

Read GitHub with the `gh` CLI in Bash. It is already authenticated, read-only, for every repository this installation covers; no mount is needed. Always name the repository: `-R owner/repo`, or `repos/owner/repo/...` with `gh api`.

## Reading

| Need | Command |
|---|---|
| List PRs | `gh pr list -R o/r --state open --limit 20` |
| PR details | `gh pr view N -R o/r --json title,body,state,isDraft,headRefName,baseRefName,url` |
| Mergeability | `gh pr view N -R o/r --json mergeable,mergeStateStatus,reviewDecision` |
| Diff | `gh pr diff N -R o/r`; add `--name-only` for the file list |
| Reviews and conversation | `gh pr view N -R o/r --json reviews,comments` |
| Checks | `gh pr checks N -R o/r`; add `--json name,state,bucket,link` to parse |
| Failed job logs | `gh run view RUN_ID -R o/r --log-failed` |
| One job's log | `gh run view -R o/r --job JOB_ID --log` |
| A check from another CI | `gh api repos/o/r/check-runs/ID --jq .output`, then `.../check-runs/ID/annotations` |
| Code scanning alerts | `gh api 'repos/o/r/code-scanning/alerts?state=open'`; one alert: `.../alerts/N` |

In an Actions link `.../actions/runs/RUN_ID/job/JOB_ID`, the two numbers are the ids above.

`gh pr checks` exits non-zero while a check is failing or pending; that is the answer, not an error.

Logs run to megabytes. Narrow them before reading: `... --log-failed | tail -n 200`, or `grep` for the failure.

Code scanning returns 403 when the GitHub App lacks that permission and 404 when the repository has no code scanning or no such alert. Report either; do not retry.

## Review threads

`resolve_review_thread` and `reply_to_review_comment` need ids that only this query returns:

```bash
gh api graphql -F owner=OWNER -F repo=REPO -F pr=N -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line
          comments(first: 50) { nodes { databaseId author { login } createdAt body } }
        }
      }
    }
  }
}'
```

A thread's `id` is the `thread_id`. Any comment's `databaseId` is a `comment_id` for that thread.

## What does not work

- **Writes.** GitHub answers HTTP 403, "Resource not accessible by integration". Do not retry or look for another route. Pushing, opening, updating, commenting on, merging and closing a PR go through the repo tools, in edit mode.
- **`github.com` itself.** `git fetch`, `git push`, `gh repo clone`, `gh pr checkout` and release downloads fail at the network. Use `mount_repo`, `fetch`, `switch_branch` and `create_branch`.
- **The token.** `$GH_TOKEN` holds a placeholder; the real token is added outside the sandbox. Do not run `gh auth login`.

All tasks share one rate limit. Ask for the fields you need in one `--json` call, and do not poll CI: a "checks updated" event arrives when checks change.
