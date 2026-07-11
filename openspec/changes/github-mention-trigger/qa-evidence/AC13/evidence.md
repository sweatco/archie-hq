# AC13 — deploy-only (post-merge operator step; unverifiable pre-merge by nature)

**Method**: deploy-only · **Recorded**: 2026-07-11 (stamp refreshed at cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a` · **QA**: black-box

No pre-merge verification is possible for this AC — it is a GitHub App settings console change. The named post-merge step is recorded here verbatim from the two governing documents (unchanged across cycles).

## Post-merge step — verbatim from the brief (AC13)

> The production GitHub App subscribes to `issues` (and keeps `issue_comment`). Post-merge step: update webhook subscriptions in the GitHub App settings, then verify one real mention creates a task.

## Post-merge step — verbatim from the verification plan (AC13 row)

> Named post-merge step (operator: Igor, sign-off owner). In the production GitHub App settings: subscribe the `issues` webhook event (keep `issue_comment`) and confirm Issues: read & write permission (reactions and plain-issue comments require Issues: write per the dossier H2/H3). Then post one real mention as a write-permission user in a plugin-covered repo and confirm: a task is created, the 👀 + acknowledgment comment appear on the thread, and a PM reply lands as a comment. Unverifiable pre-merge by nature (App settings console change).

## Evidence location once executed (verbatim from the verification plan)

> Post-merge checklist comment on the PR (task id, issue link, screenshot/permalink of the ack); AC marked verified in `forge.yaml` afterwards

Note: AC12 is BLOCKED in this environment (see `../AC12/evidence.md`); per the brief's QA limitations, this post-merge verification is the named fallback if the user waives AC12.
