# AC2 runner notes — basic-nonce scenario via archie-debug MCP

**Runner:** black-box QA (Forge Stage 4), 2026-07-04. Branch `forge/archie-e2e-harness` @ `1cb2497`. Instance booted by AC1's healthy boot (same session, serial, per plan).

## How the MCP was driven

The archie-debug MCP was not attached to the QA agent's toolset, so a minimal stdio client (scratchpad `mcp-client.mjs`, `@modelcontextprotocol/sdk` Client + StdioClientTransport spawning `npx tsx tools/debug-mcp/server.ts` in the repo) exposed `node mcp-client.mjs <tool> '<json>'`. Test tooling only; nothing added to the repo. `__list` confirmed the documented tools: create_task, list_tasks, task_status, send_message, get_log, get_events, approve, wait_for_task.

## Recipe execution (SKILL.md `basic-nonce`, followed verbatim)

1. `NONCE=E2E-$(openssl rand -hex 4)` → `E2E-7e989c30`.
2. `create_task` with the recipe's message → `task-20260704-1857-9nigbb`.
3. `wait_for_task(nonce: E2E-7e989c30)` → first call correlated the nonce and, because the PM answered within the ~45s server-side window, returned terminal state directly:

```
TASK=task-20260704-1857-9nigbb
STATE=completed
PM_REPLY: Here are the agents configured in this instance: … (10 agents)
CURSOR=10
```

No cursor-resume loop was needed (single-call completion); the cursor mechanism was exercised in AC3 instead.

4. `get_log(task_id, tail: 40)` → 15 lines; line 1 contains the nonce.
5. `get_events(task_id)` → 10 events, `task:created` (18:57:40.755Z) … `task:completed` (18:58:12.647Z), including the `message` event with `data.from === 'pm-agent'`.

Scenario wall time: **~32s** (create 18:57:40 → completed 18:58:12).

## Assertions

All five recorded in the harness-written evidence (`basic-nonce.{json,md}`, written via `npx tsx tools/e2e/evidence.ts --out-dir .../AC2/`): nonce correlation, terminal state completed, PM reply observed, nonce in knowledge log, full lifecycle events. 5/5 PASS.

## Verdict: PASS
