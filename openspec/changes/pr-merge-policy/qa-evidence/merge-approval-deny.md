# E2E evidence — merge-approval-deny

- **Result:** PASS
- **ACs covered:** AC3
- **Terminal state:** `completed`
- **Started:** 2026-07-07T21:11:21Z · **Finished:** 2026-07-07T21:16:32Z
- **Environment:** http://localhost:3000 · branch `forge/pr-merge-policy` · commit `b541c9a`
- **Nonce:** `E2E-9c4bd221` · **Task:** `task-20260707-2111-xuh66c`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| A1 | Non-auto repo: merge_pull_request pauses instead of merging | After the user requests merge, the task reaches STATE=approval_requested with APPROVAL_TYPE=merge; nothing is merged and nothing is armed at request time | wait_for_task returned STATE=approval_requested APPROVAL_TYPE=merge; event approval:requested carried approvalType=merge, github=sweatco/archie-hq, pr_number=192; PR #192 still OPEN, mergedAt=null at this point | PASS |
| A2 | Merge-approval request records identity in the knowledge log | Knowledge log line: Merge approval requested for sweatco/archie-hq#192 | [system] [decision] Merge approval requested for sweatco/archie-hq#192 present in the knowledge log | PASS |
| A3 | Deny via API path with github+pr_number succeeds (no 400) | approve(type=merge, approve=false, github=sweatco/archie-hq, pr_number=192) returns success | MCP approve tool returned Denied merge for task-20260707-2111-xuh66c, exit=0; event approval:resolved {type:merge, approve:false} recorded | PASS |
| A4 | Denial results in no merge and no arming | Knowledge log: Merge denied by user — PR not merged; no merged-on-approval or armed line; gh pr view mergedAt=null, state OPEN | [system] [decision] Merge denied by user — PR not merged present; grep for merged on user approval / armed for auto-merge returned none; gh pr view #192 -> state OPEN, mergedAt null, mergeStateStatus BLOCKED | PASS |
| A5 | Task settles cleanly after denial | STATE=completed with PM relaying the merge was denied and PR stays open | STATE=completed; PM_REPLY: the merge was denied, so PR #192 stays open and unmerged | PASS |

## Excerpts

### Knowledge log

```
[2026-07-07T21:13:49.438Z] [archie-agent] [decision] Created PR #192 on sweatco/archie-hq: https://github.com/sweatco/archie-hq/pull/192
[2026-07-07T21:14:51.508Z] [system] [decision] Merge approval requested for sweatco/archie-hq#192
[2026-07-07T21:15:11.508Z] [system] [decision] Merge denied by user — PR not merged
[2026-07-07T21:15:22.275Z] [pm-agent in cli] Got it — the merge was denied, so PR #192 in sweatco/archie-hq stays open and unmerged.
```

### Events

```json
{"ts":"2026-07-07T21:12:39.375Z","type":"approval:requested","data":{"text":"Edit mode request: Create throwaway file e2e-touch-E2E-9c4bd221.md in sweatco/archie-hq, commit on a new branch, and open a PR (no merge) for the E2E test.","approvalType":"edit_mode"}}
{"ts":"2026-07-07T21:12:53.051Z","type":"approval:resolved","data":{"type":"edit_mode","approve":true}}
{"ts":"2026-07-07T21:14:51.613Z","type":"agent:log","data":{"finding":"Merge approval requested for sweatco/archie-hq#192","type":"decision"}}
{"ts":"2026-07-07T21:14:51.613Z","type":"approval:requested","data":{"text":"Approve auto-merge for PR #192 (sweatco/archie-hq)? It will merge automatically once all checks and required reviews pass.","approvalType":"merge","github":"sweatco/archie-hq","pr_number":192}}
{"ts":"2026-07-07T21:15:11.539Z","type":"approval:resolved","data":{"type":"merge","approve":false}}
{"ts":"2026-07-07T21:15:22.275Z","type":"message","data":{"from":"pm-agent","to":"user","message":"Got it — the merge was denied, so PR #192 in sweatco/archie-hq stays open and unmerged."}}
```

## Verdict

**PASS** — 5/5 assertions passed.
