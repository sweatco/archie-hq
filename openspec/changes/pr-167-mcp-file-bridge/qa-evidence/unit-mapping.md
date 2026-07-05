# Unit/integration evidence mapping — pr-167-mcp-file-bridge

Run: `npx vitest run src/agents/__tests__/mcp-file-bridge.test.ts --reporter=verbose` on branch `archie/task-20260605-1434-l7is2a` (commit `4434425`), 2026-07-05. Full output: [`unit-run.txt`](./unit-run.txt). Result: **18/18 passed**.

All test names below are in `src/agents/__tests__/mcp-file-bridge.test.ts`.

| AC | Covering test case(s) | Notes |
|----|----------------------|-------|
| AC1 | `shouldAttachFileBridge > attaches for a plain plugin agent`; `shouldAttachFileBridge > does not attach for the PM agent`; `shouldAttachFileBridge > does not attach for a repo agent` | The verification plan allowed extracting the wiring decision into a testable seam; that seam is `shouldAttachFileBridge`, exercised with the real `isPmAgent`/`isRepoAgent` predicates per the test's own comment. The single line in `spawnAgent` that calls the seam is not unit-asserted; AC7's live run (a plugin agent actually holding and using `send_file_to_mcp_tool` on a booted instance) closes that residual gap. |
| AC2 | `rejects a server the agent is not connected to`; plus `resolves servers from the live map, not the agent def — a dropped server is unreachable` | Asserts the error names the unknown server and `callTool`/`connect` are never invoked. Note: the error text names the missing server (`not connected to an MCP server named "nope"`) but the test does not assert it *lists the connected servers* — see deviation note below. |
| AC3 | `rejects a stdio server`; `rejects a legacy SSE server` | Both cases the plan required after the SSE fix; each asserts no connect attempt. |
| AC4 | `surfaces an unreadable-path error, reads nothing, and does not call out` | Multi-file shape per the plan: `[readable, unreadable]` → error surfaced, `readFile` never called (so no bytes of the readable file forwarded), no connect. |
| AC5 | `rejects a single file over the ceiling before reading it`; `rejects when the combined size is over the ceiling, before reading anything` | Sum case: 6 MB + 5 MB, rejected with no `readFile`/`callTool`. Bonus hardening case beyond the plan: `rejects when files grow past the ceiling between stat and read (TOCTOU)`. |
| AC6 | `injects base64 bytes, reuses the server url + headers, and returns the result`; `injects multiple files under their own arguments, file bytes winning collisions`; `surfaces a tool-reported error (isError) as an error result` | Asserts base64 injection under named arguments, merge with `arguments` with file bytes winning collisions, transport constructed with the server's url + CF-Access headers, verbatim result text, `isError` surfaced as an error, and client `close()` called. |

Additional guardrail tests present beyond the AC list (not required, recorded for completeness): `rejects a tool the agent has in disallowedTools`; `rejects a whole-server disallow rule (mcp__<server> form)`; `enforces a tools allowlist when the def has one`; `rejects two files targeting the same argument`.

## Deviations from the verification plan (observed by black-box QA)

- **AC1**: the plan's suggested `src/agents/__tests__/spawn-file-bridge-wiring.test.ts` does not exist; coverage lives in the `shouldAttachFileBridge` describe block of the bridge test file. This matches the plan's sanctioned alternative ("extract the tool-assembly decision into a testable seam").
- **AC2**: brief says "error lists connected servers"; the test asserts only that the error names the unknown server (`/not connected to an MCP server named "nope"/`). Whether the message also enumerates the connected servers is not pinned by any assertion. Minor — the core guarantee (reject + no outbound call) is fully asserted.
