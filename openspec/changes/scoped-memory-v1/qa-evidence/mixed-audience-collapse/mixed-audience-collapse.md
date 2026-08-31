# E2E evidence — mixed-audience-collapse

- **Result:** PASS
- **ACs covered:** private-and-distinct-public-audiences-collapse-scope
- **Terminal state:** `completed`
- **Started:** 2026-08-31T03:31:15Z · **Finished:** 2026-08-31T03:32:05Z
- **Environment:** http://localhost:3457 · branch `detached-main` · commit `a528a9be4f9ad631cf8dad5f788574010cb34df5-dirty`
- **Nonce:** `SMV1-MIXED-PUBLIC-484JMU` · **Task:** `task-20260831-0322-dxiq55`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| supported-link-path | Task.append links a distinct live public Slack root to the private task. | Both private and public Slack channel keys are persisted. | Task.append returned linkedNewThread=true; metadata contains C0BM7QRSVS4/1788146539.290019 and C0BL50N2600/1788147075.863839. | PASS |
| collapse-before-delivery | Private plus distinct public audiences collapse before public delivery. | memory_scope=none before the public reply. | The append flushed memory_scope={kind:none}; postToUser then delivered SMV1-MIXED-DELIVERY-484JMU in the public thread. | PASS |
| no-post-collapse-write | No memory read or write occurs after collapse. | No mixed nonce appears anywhere in the scoped store. | Recursive memory search returned no SMV1-MIXED hit; scoped-store mtimes did not advance during append/delivery. | PASS |

## Excerpts

### Knowledge log

```
[2026-08-31T03:32:03.657Z] Mixed-audience routing fixture SMV1-MIXED-PUBLIC-484JMU.
[2026-08-31T03:32:04.712Z] Mixed-route delivery remained operational; memory scope collapsed before this public delivery. SMV1-MIXED-DELIVERY-484JMU
```

### Events

```json
{"type":"task_append","linkedNewThread":true,"resulting_scope":"none"}
{"type":"scoped_store_search","query":"SMV1-MIXED","hits":[]}
```

## Verdict

**PASS** — 3/3 assertions passed.
