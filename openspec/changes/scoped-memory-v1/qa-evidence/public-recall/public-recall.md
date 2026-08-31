# E2E evidence — public-recall

- **Result:** PASS
- **ACs covered:** search-returns-deterministic-scoped-hits, public-task-writes-rich-summary
- **Terminal state:** `completed`
- **Started:** 2026-08-31T03:18:04Z · **Finished:** 2026-08-31T03:21:42Z
- **Environment:** http://localhost:3457 · branch `detached-main` · commit `a528a9be4f9ad631cf8dad5f788574010cb34df5-dirty`
- **Nonce:** `SMV1-PUBLIC-RECALL-484JMU` · **Task:** `task-20260831-0321-1xnvuy`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| hookdeck-ingress | Nonce-tagged Slack roots traverse the configured Hookdeck source into this instance. | Hookdeck accepts both events and Archie creates public-scoped tasks. | Seed request req_IOQxiv30jDxYC6kAZR4b and recall request req_0X5n5lOUw15mtpE3gFqn were accepted; tasks 0320-2hbz97 and 0321-1xnvuy were public-scoped. | PASS |
| public-extraction | The seed fact is persisted only in the public corpus. | Public summary contains the amber fact and no C0BL50N2600 private file exists. | public/tasks/task-20260831-0320-2hbz97.md contains SMV1-PUBLIC-FACT-484JMU and amber; no channel-private file existed. | PASS |
| tool-recall | A second public task retrieves the fact through memory tools. | search_memory and read_task_summary return the stored fact; Slack reply says amber. | Container log records search_memory then read_task_summary(task-20260831-0320-2hbz97); reply was Amber and metadata exposure scope was internal. | PASS |
| structured-author-limit | Synthetic E2E ingress does not falsely claim a structured human author. | Author assertion is delegated to host-resolved integration tests because the real Slack root is bot-authored. | memory_authors remained empty for the synthetic event; append-render-ordering tests cover host-resolved internal authors and forged-marker rejection. | PASS |

## Excerpts

### Knowledge log

```
[2026-08-31T03:20:12.319Z] Store this harmless durable test fact: SMV1-PUBLIC-FACT-484JMU has color amber.
[2026-08-31T03:21:37.127Z] **Amber** — that's the stored color for launch codename SMV1-PUBLIC-FACT-484JMU.
Memory evidence was used: task-20260831-0320-2hbz97.
```

### Events

```json
{"type":"flags","memory":true,"injection":false,"tools":true}
{"type":"memory_tool","tool":"search_memory","query":"SMV1-PUBLIC-FACT-484JMU launch codename color"}
{"type":"memory_tool","tool":"read_task_summary","task_id":"task-20260831-0320-2hbz97"}
{"type":"scoped_store","files":["public/tasks/task-20260831-0320-2hbz97.md","public/tasks/task-20260831-0321-1xnvuy.md","public/recent-activity.md"]}
```

## Verdict

**PASS** — 4/4 assertions passed.
