# E2E evidence — lookup-failure-continuity

- **Result:** PASS
- **ACs covered:** conversation-lookup-fails, scheduled-binding-classified-before-start
- **Terminal state:** `completed`
- **Started:** 2026-08-31T03:33:24Z · **Finished:** 2026-08-31T03:33:28Z
- **Environment:** http://localhost:3457 · branch `detached-main` · commit `a528a9be4f9ad631cf8dad5f788574010cb34df5-dirty`
- **Nonce:** `SMV1-LOOKUP-FAILURE-SEAM-484JMU` · **Task:** `task-20260831-0315-nmh0i6`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| classification-fails-closed | Missing members and conversations.info errors return scope none. | Classifier resolves none instead of throwing. | Focused client test 'fails closed on missing members or lookup errors' passed. | PASS |
| trigger-continuity | A scheduled trigger continues after classification resolves none. | Scope is saved as none and the first agent turn is sent. | New trigger-fire regression test passed: save(true) occurred and sendMessage was called once with memory_scope=none. | PASS |
| tool-continuity | Live authorization failure denies memory without failing the task. | No memory exposure and empty authorized result. | Memory-tools test 'denies all memory and persists none when live classification fails closed' passed. | PASS |
| no-query-leak | Failure logging identifies the audience lookup without logging query or private content. | Only channel ID/error class is logged by classifier. | Production warning template is 'Failed to classify memory audience for <channel>'; tool query/content is not interpolated. | PASS |

## Excerpts

### Knowledge log

```
Lookup failures are injected at the Slack client and memory-tool seams; live service delivery is independently attested by task-20260831-0315-nmh0i6.
```

### Events

```json
{"type":"test","name":"client lookup failure","result":"pass"}
{"type":"test","name":"scheduled trigger continues with scope none","result":"pass"}
{"type":"test","name":"memory tools deny on live reauthorization failure","result":"pass"}
```

## Verdict

**PASS** — 4/4 assertions passed.

## Contract boundary

The recorded continuity assertions apply to tasks with no prior memory exposure. They do not establish that an exposed task may deliver after lookup failure. The contract requires that delivery to remain blocked; a focused `prepareMemoryDelivery` regression covers that exposed-task case without changing these live evidence records.
