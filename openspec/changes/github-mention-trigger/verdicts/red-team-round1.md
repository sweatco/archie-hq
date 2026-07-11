# Red team — round 1

Verdict: **OBJECTIONS — 1 blocking, 8 non-blocking.**

## Blocking

- **B1 — follow-up path has no author gate; plan misstates the injection surface; readonly does not bound read-exfiltration.** Design's Known-trade-offs line "prompt-injection surface widens to anyone with repo write" is false: the permission gate runs only at summon; follow-ups route ungated (spec §follow-ups; brief AC7 as originally signed). Today untrusted GitHub comments never reach the PM (router discard `webhooks.ts:470`); this feature opens that ingress. Readonly (`spawn.ts:381`) blocks writes only — a readonly dynamic repo agent can read any installation-accessible repo (dossier D4/J6) and the PM relays via `postToUser`→`addPRComment`. On a covered public issue, any GitHub account could steer the PM to paste private-repo content onto the public thread. Slack precedent (F2) redacts external participants; the GitHub follow-up path replicated none of it. **Fix required:** permission-gate follow-up authors (silently drop read/none; no mention requirement — AC7 UX preserved), correct the risk statement, bound the exfil path. → Resolution: planner round 2 + AC7 amended in brief/forge.yaml.

## Non-blocking

- N1 — `issues.opened` redelivery duplicates task+ack; Decision 1's noop claim contradicts `issue_comment`-only mapping wiring. Fix: consult mapping for `issues` events too.
- N2 — reshape safety hole: `lifecycle.ts:379` reads `pr_number` through a cast — silently `undefined` after reshape, no typecheck error, no test on `buildLinksBlock` github branch. Fix: drop cast + add assertion.
- N3 — `github_origin` metadata redundant with the GitHubChannel entry in v1 (equivalent predicate; author sub-field write-only; adds scan noise). Simpler: `task.isGitHubBorn()` over channels.
- N4 — slug-unset-after-creation is an unbounded self-comment loop (self-filter off, follow-up routing slug-independent); boot warn informs, doesn't prevent. Fix: gate github-born follow-up delivery on slug set, or persist bot login and filter on it.
- N5 — `postToUser` github branch: no error handling for locked/closed/transferred/renamed issue — throw propagates into PM tool call. Fix: try/catch warn-and-continue + test.
- N6 — no rate cap: decline comments uncapped (no dedup store before task creation); N-issue mention storm → N tasks. Precedent `DAILY_FIRE_CAP` (`trigger-scheduler.ts:27`). Fix: short-window decline dedup; broader cap optional.
- N7 — AC11 "byte-for-byte" rests on refactored `handleExistingTaskDirect` (today gated `prNumber && commentId`, `events.ts:273`); companion test must pin no-github-channel PR-task behavior exactly.
- N8 — unauthenticated approve API can grant `max_mode` (unrequested) on a github-born task (`task.ts:1400-1407` idempotency-only). Confirmed not a write door (spawn reads only `edit_allowed`). Recorded; scoping defensible.

## Probes cleared

GitHubChannel zero constructions confirmed; `handleEditModeApproval` return widening safe (both callers ignore return; Slack approve path for normal tasks unbroken; engine guard is load-bearing, correct layering); merge-approval API untouched; decline-as-probe closed by authz-before-coverage ordering; no sender-vs-author spoof gap (`context.user` = `payload.sender.login` = author for both eligible events); discard-point interception regression-free for quietly-discarded events.
