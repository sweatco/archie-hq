# E2E evidence — private-channel-isolation

- **Result:** PASS
- **ACs covered:** private-channel-task-completes, task-summary-prefers-authorized-locality
- **Terminal state:** `completed`
- **Started:** 2026-08-31T03:22:19Z · **Finished:** 2026-08-31T03:24:46Z
- **Environment:** http://localhost:3457 · branch `detached-main` · commit `a528a9be4f9ad631cf8dad5f788574010cb34df5-dirty`
- **Nonce:** `SMV1-PRIVATE-MPIM-484JMU` · **Task:** `task-20260831-0324-zmekhd`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| exact-private-write | The internal private MPIM seed writes only its exact channel vault. | channels/C0BM7QRSVS4/private.md contains the outcome; public corpus does not. | Only channels/C0BM7QRSVS4/private.md contains the nonce and otter; no public task/profile/entity/activity contained either value before the public denial query. | PASS |
| same-channel-recall | A second task in the same MPIM can read the private outcome. | Authorized local read returns otter. | task-20260831-0323-j9hm2e used search_memory and read_task_summary, replied Otter, and persisted exposure scope channel/C0BM7QRSVS4. | PASS |
| public-denial | A public task cannot search or read the private outcome. | No authorized result and no memory exposure. | task-20260831-0324-zmekhd called search_memory/read_entity for the reconstructed identifier and replied No authorized memory result; memory_exposed remained unset. | PASS |
| no-public-leak | The exact private nonce and value remain absent from public memory. | Recursive public-corpus search has no private nonce or otter hit. | rg over memory/public returned no SMV1-PRIVATE-MPIM-484JMU or otter match after public extraction; the public query deliberately used split fragments. | PASS |

## Excerpts

### Knowledge log

```
[2026-08-31T03:23:36.709Z] **Otter** — vault phrase maps to otter. Private-channel memory was used.
[2026-08-31T03:24:40.241Z] No authorized memory result.
```

### Events

```json
{"type":"hookdeck","seed_request":"req_7y9ce8lvvGZ3FvOy4ZkJ","recall_request":"req_u6jUIq6nN2OeyRiiIGAV","public_denial_request":"req_gCmln9jF63UDk7uiTvXJ"}
{"type":"scoped_store","files":["channels/C0BM7QRSVS4/private.md"],"prohibited_public_hits":[]}
{"type":"memory_exposure","same_channel":"channel/C0BM7QRSVS4","public":"none"}
```

## Verdict

**PASS** — 4/4 assertions passed.
