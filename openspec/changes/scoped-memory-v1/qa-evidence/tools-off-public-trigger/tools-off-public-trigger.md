# E2E evidence — tools-off-public-trigger

- **Result:** PASS
- **ACs covered:** scheduled-binding-classified-before-start, tools-default-off
- **Terminal state:** `completed`
- **Started:** 2026-08-31T03:11:56Z · **Finished:** 2026-08-31T03:15:59Z
- **Environment:** http://localhost:3457 · branch `detached-main` · commit `a528a9be4f9ad631cf8dad5f788574010cb34df5-dirty`
- **Nonce:** `SMV1-TRIG-TOOLS-OFF-484JMU` · **Task:** `task-20260831-0315-nmh0i6`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| trigger-delivered | An approved channel-bound one-off trigger starts and delivers normally. | Trigger fires once and posts the nonce in #archie-test-channel. | trg-20260831-0312-4r02dc fired at 03:15:32Z; task completed and posted the nonce in Slack thread 1788146149.405469. | PASS |
| scope-before-agent | The trigger task persists the live channel audience before work starts. | memory_scope is public for C0BL50N2600. | metadata.memory_scope={kind:public,channel_id:C0BL50N2600}; home_channel names archie-test-channel. | PASS |
| public-only-write | Completion writes public summary/activity and no channel-private outcome. | Public task summary and activity exist; channels/C0BL50N2600/private.md is absent. | public/tasks/task-20260831-0315-nmh0i6.md and public/recent-activity.md exist; no channel-private file was present. | PASS |
| tools-off | The memory MCP is not registered when ARCHIE_MEMORY_TOOLS=false. | No memory-tools connection in the spawned PM log. | Flags were memory=true, injection=false, tools=false; PM connected agent/research/comms/orchestration/scheduling only. | PASS |

## Excerpts

### Knowledge log

```
[2026-08-31T03:15:49.468Z] [pm-agent in slack:#<C0BL50N2600:archie-test-channel>:1788146149.405469] Scoped memory trigger delivered SMV1-TRIG-TOOLS-OFF-484JMU
```

### Events

```json
{"type":"flags","memory":true,"injection":false,"tools":false}
{"type":"trigger","id":"trg-20260831-0312-4r02dc","status":"paused","last_fired_at":"2026-08-31T03:15:32.210Z"}
{"type":"scoped_store","files":[".scoped-v1.json","public/tasks/task-20260831-0315-nmh0i6.md","public/recent-activity.md","runtime/pending-extractions.md"]}
```

## Verdict

**PASS** — 4/4 assertions passed.
