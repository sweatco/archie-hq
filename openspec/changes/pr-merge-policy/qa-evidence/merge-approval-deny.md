# E2E evidence — merge-approval-deny

- **Result:** PASS
- **ACs covered:** AC3
- **Terminal state:** `completed`
- **Started:** 2026-07-06T12:56:26Z · **Finished:** 2026-07-06T13:04:30Z
- **Environment:** http://localhost:3000 · branch `forge/pr-merge-policy` · commit `1cf34ce`
- **Nonce:** `E2E-f032d83d` · **Task:** `task-20260706-1256-psqkhz`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| boot-attestation | Boot attested the instance was composed from the checkout under test (branch forge/pr-merge-policy) | boot.ts prints 'Attested: instance composed from <HEAD sha>' and /health reports the same git_sha | Attested: instance composed from 1cf34ce92e47d0d73b7994fb00b7da7d23c778ad; /health body: {"status":"ok","activeTasks":0,"git_sha":"1cf34ce92e47d0d73b7994fb00b7da7d23c778ad"} — matches git rev-parse HEAD (1cf34ce, clean tree) | PASS |
| pr-opened | Task made a small real change in a configured non-auto repo and opened a PR (edit-mode gate approved along the way) | STATE=approval_requested APPROVAL_TYPE=edit_mode, approved via approve(type: edit_mode), then STATE=completed with a PM reply announcing the PR | Edit-mode gate surfaced (APPROVAL_TYPE=edit_mode), approved via API; task settled completed with PM reply announcing PR #81 on sweatco/archie-plugins (https://github.com/sweatco/archie-plugins/pull/81); knowledge log: 'Created PR #81 on sweatco/archie-plugins' | PASS |
| merge-gate-surfaced | After send_message asking the PM to merge, merge_pull_request in the non-auto repo does not merge — the task pauses with an approval_requested event of type merge, observed live via wait_for_task | wait_for_task returns STATE=approval_requested with APPROVAL_TYPE=merge; events show approval:requested with data.approvalType 'merge'; knowledge log carries 'Merge approval requested for sweatco/archie-plugins#81' | wait_for_task returned STATE=approval_requested APPROVAL_TYPE=merge; events: 2026-07-06T12:59:37.074Z approval:requested {"text":"Merge approval requested for PR #81 (sweatco/archie-plugins)","approvalType":"merge"} followed by task:stopped; knowledge log: '[system] [decision] Merge approval requested for sweatco/archie-plugins#81' | PASS |
| deny-resolves-via-api | Denying via the identity-carrying API call resolves the merge approval and the task settles | approve(type: merge, approve: false, github: sweatco/archie-plugins, pr_number: 81) succeeds; events show approval:resolved {type: merge, approve: false}; task reaches STATE=completed | API returned 'Denied merge for task-20260706-1256-psqkhz'; events: 2026-07-06T13:00:03.905Z approval:resolved {"type":"merge","approve":false}; wait_for_task then returned STATE=completed with PM reply 'the merge was denied, so PR #81 remains open and unmerged' | PASS |
| no-merge-occurred | Denial results in no merge: denial finding recorded, no merged-completion finding/event, and GitHub confirms the PR was never merged | Knowledge log contains 'Merge denied by user — PR not merged'; no 'PR … merged on user approval' finding or merge event between approval:requested and approval:resolved or after; gh pr view reports mergedAt null | Knowledge log: '[system] [decision] Merge denied by user — PR not merged'; no merge finding/event anywhere in the task's events or log; gh pr view 81 --repo sweatco/archie-plugins → {"mergedAt":null,"state":"OPEN"} at verification time. Test PR then closed by QA (gh pr close 81, branch archie/task-20260706-1256-psqkhz-2 deleted) — final state CLOSED with mergedAt still null | PASS |

## Excerpts

### Knowledge log

```
[2026-07-06T12:56:38.582Z] [cli] [E2E-f032d83d] In sweatco/archie-plugins, add a comment line "<!-- archie-e2e touch E2E-f032d83d -->" to the top of README.md and open a PR. Do not merge it.
[2026-07-06T12:57:31.338Z] [system] [decision] Edit mode requested: Add a comment line to the top of README.md in sweatco/archie-plugins and open a PR (will not merge).
[2026-07-06T12:57:47.528Z] [system] [decision] Edit mode approved by user
[2026-07-06T12:58:42.923Z] [archie-agent] [decision] Created PR #81 on sweatco/archie-plugins: https://github.com/sweatco/archie-plugins/pull/81
[2026-07-06T12:59:22.087Z] [cli] [E2E-f032d83d] Please merge that PR.
[2026-07-06T12:59:29.959Z] [pm-agent] → archie-agent: The user has asked to merge PR #81 (https://github.com/sweatco/archie-plugins/pull/81). Please merge it using your merge_pull_request tool. Report back once it's merged.
[2026-07-06T12:59:37.073Z] [system] [decision] Merge approval requested for sweatco/archie-plugins#81
[2026-07-06T12:59:41.591Z] [archie-agent] → pm-agent: I initiated the merge of PR #81 (sweatco/archie-plugins). This repo isn't auto-merge, so the merge tool posted a merge-approval request and paused the task pending user approval. Once the user approves, the merge will complete. I'll confirm once it's merged.
[2026-07-06T13:00:03.860Z] [system] [decision] Merge denied by user — PR not merged
[2026-07-06T13:00:16.471Z] [pm-agent in cli] Understood — the merge was denied, so PR #81 remains open and unmerged: https://github.com/sweatco/archie-plugins/pull/81
```

### Events

```json
{"timestamp":"2026-07-06T12:57:31.339Z","type":"approval:requested","data":{"text":"Edit mode request: Add a comment line to the top of README.md in sweatco/archie-plugins and open a PR (will not merge).","approvalType":"edit_mode"}}
{"timestamp":"2026-07-06T12:57:47.562Z","type":"approval:resolved","data":{"type":"edit_mode","approve":true}}
{"timestamp":"2026-07-06T12:58:59.165Z","type":"pr_card","data":{"action":"post","cardId":"sweatco/archie-plugins#81","repo":"sweatco/archie-plugins","prNumber":81,"url":"https://github.com/sweatco/archie-plugins/pull/81","headRef":"archie/task-20260706-1256-psqkhz-2","state":"open","head_sha":"3a836ce4b22e26c02e4b30388b8a91f51d104cba","ci":"none","ciPassed":0,"ciTotal":0}}
{"timestamp":"2026-07-06T12:59:37.074Z","type":"approval:requested","data":{"text":"Merge approval requested for PR #81 (sweatco/archie-plugins)","approvalType":"merge"}}
{"timestamp":"2026-07-06T12:59:47.158Z","type":"task:stopped","data":{}}
{"timestamp":"2026-07-06T13:00:03.905Z","type":"approval:resolved","data":{"type":"merge","approve":false}}
{"timestamp":"2026-07-06T13:00:27.548Z","type":"task:completed","data":{}}
```

## Verdict

**PASS** — 5/5 assertions passed.
