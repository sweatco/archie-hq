# AC12 — BLOCKED (live-e2e prerequisites missing; not attempted, nothing faked)

**Method**: live-e2e · **Checked**: 2026-07-11 (re-checked at cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a` · **QA**: black-box

## Prerequisites missing in this environment

- No dev GitHub App credentials in `.env` — all five required keys are absent: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET` (re-verified 2026-07-11 at `05fcf1a`: `grep -cE "^[A-Z_]*GITHUB[A-Z_]*=" .env` returns 0; the `.env` file itself exists).
- No plugin-covered test repo designated for the run.

Docker/compose, the archie-debug MCP, and the archie-e2e harness are available — the blocker is solely the credentials and the test repo.

## What the recipe would have done

Per the verification plan (archie-e2e recipe `github-mention`): boot the dockerized instance from this branch with dev GitHub App credentials and a plugin-covered test repo, create a real issue, POST a correctly signed (HMAC-SHA256) synthetic `issue_comment.created` payload mentioning the dev slug from a write-permission author, wait for the task via the archie-debug MCP, assert the seeded knowledge log via `get_log`, then assert the 👀 reaction and the task-naming acknowledgment comment on the real issue via the GitHub API.

## Rule applied

Verification plan AC12, prerequisite-missing rule (verbatim): "report BLOCKED and stop — per the brief's QA limitation, degrade to `manual` or an explicit waiver naming AC13 as fallback **only with the user's say-so**." No live boot was attempted; no evidence was fabricated.

## Remedy options (per the brief's QA-limitations section — user's decision required)

1. Provide dev GitHub App credentials (`GITHUB_APP_ID/SLUG/PRIVATE_KEY_PATH/INSTALLATION_ID/WEBHOOK_SECRET`) plus a plugin-covered test repo reachable from the E2E harness, then run the archie-e2e `github-mention` recipe; evidence lands at `qa-evidence/github-mention.json` (+ rendered `.md`).
2. Degrade to `manual`: the operator boots the instance locally with dev credentials and posts a real mention comment by hand, capturing the task id, seeded log, and the on-thread acknowledgment.
3. Explicit waiver, naming AC13's post-merge verification (one real mention as a write-permission user in a plugin-covered repo after the App settings change) as the fallback proof of real-thread behavior.

Note: the brief flags that AC5/AC6 integration tests mock the GitHub API, so real-thread behavior remains proven only by AC12/AC13 — until one of the remedies above runs, that proof is outstanding.

## Cycle history

- Cycle 1 (@ `d2976f9`): BLOCKED as above.
- Cycle 2 addendum (@ `05fcf1a`): prerequisites re-checked — still absent; verdict unchanged.
