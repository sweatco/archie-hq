# E2E evidence — final-post-review-regression

- **Result:** PASS
- **ACs covered:** public-summary-recall, private-channel-isolation, dm-isolation, memory-egress-guard, plugin-hook-isolation
- **Terminal state:** `completed`
- **Started:** 2026-08-31T06:02:00Z · **Finished:** 2026-08-31T06:19:07Z
- **Environment:** http://localhost:3457 · branch `detached-main` · commit `a528a9be4f9ad631cf8dad5f788574010cb34df5-dirty`
- **Nonce:** `SMV1-FINAL-PUBLIC-23EA48` · **Task:** `task-20260831-0609-dtt865`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| attested-isolated-boot | The current dirty tree booted against a fresh scoped memory mount bound to the real Slack workspace. | Health attests the dirty SHA and the isolated marker contains schema version 1 and team T03PDDDEK. | Health attested a528a9be4f9ad631cf8dad5f788574010cb34df5-dirty; findmnt resolved /tmp/archie-scoped-memory-final/memory at /workdir/memory; marker version 1/team T03PDDDEK. | PASS |
| live-egress-baseline | The production CLI still enforces the sandbox network boundary. | Non-allowlisted host blocked, allowlisted host reachable, package-manager proxy paths operational. | CLI 2.1.233 blocked the non-allowlisted host, reached the allowlisted host, completed npm install, and mapped the Yarn Berry proxy. | PASS |
| public-summary-and-exposure | A public Slack task writes a public summary and a later public task reads it through read_task_summary. | The summary returns cobalt as framed memory evidence and marks the reading task exposed to internal memory. | task-20260831-0606-oreokm wrote public/tasks/task-20260831-0606-oreokm.md; task-20260831-0609-dtt865 returned cobalt and persisted memory_exposed=true with exposure kind internal. | PASS |
| plugin-hooks-omitted | A memory-authorized live session cannot run plugin command hooks outside the host egress guard. | The generated project settings contain attribution only and no plugin hooks. | The PM settings for the public, channel-private, and DM memory sessions contained attribution only; no hooks key was written. | PASS |
| post-exposure-bash-denied | The same live task cannot use Bash after memory exposure is persisted. | A follow-up Bash pwd call is denied before execution. | Two post-exposure Bash attempts returned the host denial: the task already received memory and Bash is not audited as local and audience-compatible; nothing ran. | PASS |
| private-channel-isolation | An internal private-channel outcome is readable in the same channel and absent in public. | Only channels/C0BM7QRSVS4/private.md stores the outcome; same-channel read returns zircon; public read returns not found. | task-20260831-0611-ajwafk wrote the exact channel vault; task-20260831-0613-rtqfuh read zircon with channel exposure; task-20260831-0614-05ng07 received Task summary not found and no private value. | PASS |
| dm-isolation | An internal DM outcome is readable in the same DM and absent in public. | Only users/U03RQQTE1EF/private.md stores the outcome; same-DM read returns topaz; public read returns not found. | task-20260831-0615-xlitpt wrote the exact user vault; task-20260831-0617-xiqyai read topaz with user exposure; task-20260831-0618-67qsfc received Task summary not found and no DM value. | PASS |
| clean-teardown | The live run restored external state and did not modify shared host memory. | No Compose containers remain, Hookdeck is paused, and the shared-memory digest is identical before and after. | Teardown reported no project containers; Hookdeck web_sfs37zDNBLPO was paused; before/after SHA-256 was 67b2d3bc35672d117a65172c022d79e1004fd5f6ef9971f097befb1b38263556 with 482 files both times. | PASS |

## Excerpts

### Knowledge log

```
Stored color: cobalt — the summary for task-20260831-0606-oreokm records SMV1-FINAL-PUBLIC-23EA48 has color cobalt.
Bash was refused because this task has already received memory and the host has not audited that exact tool as local and audience-compatible. Nothing ran.
No private value was returned. read_task_summary for task-20260831-0611-ajwafk came back: Task summary not found.
The value is topaz — stored as the mapping SMV1-FINAL-DM-68D9B0 to topaz.
No DM-scoped value was returned — read_task_summary for task-20260831-0615-xlitpt came back: Task summary not found.
```

### Events

```json
{"type":"flags","memory":true,"injection":false,"tools":true}
{"type":"public_recall","seed_task":"task-20260831-0606-oreokm","read_task":"task-20260831-0609-dtt865","exposure":"internal"}
{"type":"memory_egress","tool":"Bash","result":"denied after exposure"}
{"type":"private_channel","seed_task":"task-20260831-0611-ajwafk","same_channel_task":"task-20260831-0613-rtqfuh","public_denial_task":"task-20260831-0614-05ng07"}
{"type":"dm","seed_task":"task-20260831-0615-xlitpt","same_user_task":"task-20260831-0617-xiqyai","public_denial_task":"task-20260831-0618-67qsfc"}
{"type":"teardown","hookdeck_paused":true,"containers_remaining":0,"shared_memory_digest_unchanged":true}
```

## Verdict

**PASS** — 8/8 assertions passed.
