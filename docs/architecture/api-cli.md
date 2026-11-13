# API and CLI

## Purpose and boundary

The operator interface exposes task and trigger operations over REST and streams events to the terminal UI. The API translates requests into existing task/trigger operations; it does not own a second task state machine. The CLI validates responses and renders task state, approvals and events.

## Module map

| Code or interface | Owns | Boundary |
| --- | --- | --- |
| [`src/connectors/api/routes.ts`](../../src/connectors/api/routes.ts) | `/api` REST and SSE routes | Operator requests → task/trigger methods; process events → connected clients |
| [`src/cli/api.ts`](../../src/cli/api.ts) | HTTP/SSE client | Base URL and UI requests → parsed responses, events or errors |
| [`src/cli/api-contract.ts`](../../src/cli/api-contract.ts) | CLI response validation | Untrusted JSON → schemas and inferred UI types |
| [`src/system/event-bus.ts`](../../src/system/event-bus.ts) | Shared event schema and subscriptions | Task/service events → in-process listeners |
| [`src/cli/App.tsx`](../../src/cli/App.tsx) and [`components/`](../../src/cli/components/) | Terminal views and interaction | Validated state/events → task list, detail, approvals and triggers |
| [`src/cli/initiative.ts`](../../src/cli/initiative.ts) | Observation diagnostics | Operator arguments → read-only database inspection; see the separate initiative runbook |
| [`tools/debug-mcp/`](../../tools/debug-mcp/) | Debug client and task waiting | Tool request → operator API observation and control |

## Flow and lifecycle

1. The CLI resolves `ARCHIE_URL`, or localhost with `PORT`, and requests task/trigger state.
2. The API invokes the existing lifecycle and approval handlers. Merge approvals carry the repository and PR identity; tool/trigger approvals use the corresponding reference.
3. The CLI parses response JSON with the owning schemas before rendering it.
4. `/api/events/stream` subscribes to the in-process event bus, optionally filters by task ID, sends a connected event and keeps the stream alive. Closing the connection removes the listener and its timer.
5. Stored task events can be fetched through the task-events route. The live stream itself is not a durable queue.

## Contracts and failure behavior

- The `/api` router is unauthenticated and assumes trusted operator access. Deployment ingress must restrict it; it is not the public Slack/GitHub webhook trust boundary. See [security](security.md) and [tool approvals](tool-approvals.md#who-may-approve).
- Approval routes converge on task handlers. Rendering a button or receiving an approval-shaped event does not itself authorize an operation.
- REST failures and response-schema failures are surfaced to the caller. The SSE client skips malformed events and reconnects after disconnects; a skipped event is not a successful state update.
- Live SSE subscribers see process events; task files own persisted history. Recovery and completion semantics belong to [orchestration](orchestration.md), not the terminal component.
- Initiative diagnostics and OAuth administration have their own source/storage interfaces; they are not additional `/api` task lifecycles.

## Change and verification

Change a wire response in its route and CLI schema together; update the consuming view and focused behavioral tests. Check event changes against `systemEventSchema` and persisted event readers. Suggested checks with dependencies installed:

```bash
npx vitest run src/connectors/api/__tests__/ src/cli/ tools/debug-mcp/wait-for-task.test.ts
```

These commands are verification guidance, not an executed result. For an authorized running check, follow [local development](../guides/local-development.md) and verify task creation, an approval, event delivery and reconnect behavior. [Initiative operations](../guides/initiative-operations.md) and [OAuth administration](../guides/oauth-mcp-authentication.md) own those procedures. The [historical debug-waiting specification](../../openspec/specs/debug-mcp-task-waiting/spec.md) retains its original acceptance scenarios.
