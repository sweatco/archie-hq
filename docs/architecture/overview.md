# System module map

## Purpose and boundary

Archie turns Slack, GitHub and operator input into tasks. Each task owns one PM session, which delegates through the SDK's native workers. Domain knowledge lives in plugins. The maps below describe current responsibilities; historical plans and proposals describe intent and decisions, not the running contract.

## Module map

| Responsibility | Owning map | Code entry points and boundary |
| --- | --- | --- |
| Bootstrap and shutdown | This overview | [`src/index.ts`](../../src/index.ts), [`bootstrap-workdir.ts`](../../src/system/bootstrap-workdir.ts), [`workdir.ts`](../../src/system/workdir.ts), [`shutdown.ts`](../../src/system/shutdown.ts): configuration → services, paths and lifecycle |
| Task runtime | [Orchestration](orchestration.md) | [`src/tasks/task.ts`](../../src/tasks/task.ts): input, approvals and activity → task transitions and PM activation |
| PM and workers | [Agents](agents.md) | [`src/agents/spawn.ts`](../../src/agents/spawn.ts): task context/configuration → SDK query, tools and workers |
| Task storage | [Persistence](persistence.md) | [`src/tasks/persistence.ts`](../../src/tasks/persistence.ts): task state → metadata, events and transcript |
| Slack | [Slack integration](slack-integration.md) | [`src/connectors/slack/events.ts`](../../src/connectors/slack/events.ts): events and actions → task/subsystem operations; client → delivery |
| GitHub | [GitHub integration](github-integration.md) | [`src/connectors/github/events.ts`](../../src/connectors/github/events.ts): webhooks → task routing, PR cards and merge checks |
| Operator interface | [API and CLI](api-cli.md) | [`src/connectors/api/routes.ts`](../../src/connectors/api/routes.ts), [`src/cli/api.ts`](../../src/cli/api.ts): REST/SSE → task and trigger operations |
| Repository workspace | [Edit mode](edit-mode.md) | [`repo-clone.ts`](../../src/connectors/github/repo-clone.ts): base cache → task-owned clone; approval → write access |
| Capability/configuration loading | [Plugins](plugin-system.md) | [`plugin-loader.ts`](../../src/system/plugin-loader.ts), [`registry.ts`](../../src/agents/registry.ts): plugin repository → capabilities and PM configuration |
| Per-call permissions | [Tool approvals](tool-approvals.md) | [`tool-approval-gate.ts`](../../src/agents/tool-approval-gate.ts): tool policy and exact call → authorization |
| Model upgrade | [Max mode](max-mode.md) | [`model-label.ts`](../../src/agents/model-label.ts), task approval handlers: approved task flag → PM model/effort |
| Explicit scheduled/event work | [Triggers](triggers.md) | [`trigger-scheduler.ts`](../../src/system/trigger-scheduler.ts): approved persistent condition → new task; reminders separately resume an existing task |
| Controlled web research | [Web research](web-research.md) | [`research-tools.ts`](../../src/mcp/research-tools.ts): topic/context → bounded research and report |
| Credentials | [Secrets and OAuth](secrets.md) | [`src/system/oauth/`](../../src/system/oauth/), [`secrets-vault.ts`](../../src/system/secrets-vault.ts): authorization/refresh → encrypted credentials and spawn-time headers |
| Knowledge | [Memory](memory.md) | [`src/memory/`](../../src/memory/): authorized task evidence → scoped knowledge and recall |
| Proactive assistance | [Proactivity](proactivity.md) | [`src/proactivity/`](../../src/proactivity/): eligible public activity → matters, bounded help and recipient-approved task handoffs |
| Trust boundaries | [Security](security.md) | Cross-cutting: session sandbox, authenticated ingress, exact audience and operation-level approvals |

A map follows responsibility rather than directory layout. `src/system/` contains several distinct services; OAuth and proactive handoff each span multiple directories. Small support components belong in their owning map until they need an independent contract.

## Flow and lifecycle

```text
Slack / GitHub / CLI
        │ authenticated connector or trusted operator API
        ▼
      Task ────────────────► task files and event history
        │ activation / resume
        ▼
    PM SDK session ────────► native workers and plugin skills
        │ engine tools, configured MCP servers, mounted clones
        ▼
 task/connector operations ─► external effect and confirmed delivery

Approved trigger ──────────► fresh task
Task reminder ─────────────► existing task
Public Slack observation ──► proactivity ──► help or recipient-approved task
Completed task evidence ───► authorized knowledge extraction
```

At startup, `src/index.ts` loads configuration, calls the workdir bootstrap, initializes integrations and optional subsystems, mounts routes, restores eligible tasks and starts schedulers. `bootstrap-workdir.ts` performs filesystem/clone setup; `workdir.ts` defines shared paths. The signal handlers in `src/index.ts` coordinate shutdown; `shutdown.ts` exposes the process-wide flag used by task code.

An ordinary task gets its PM lazily. Incoming content is appended to the task record and delivered inline to the PM; the running PM does not use the knowledge log as a mailbox. It can park for approval and resume its saved SDK session. Proactive handoffs additionally have a durable, inert `preparing` stage before activation. See the task and proactivity maps for recovery constraints.

## Contracts and failure behavior

- **Task ownership:** one PM runtime and one clone per mounted repository per task. Native workers share the task's credentials, sandbox and grants. Worker definitions do not establish process isolation.
- **Durable state has separate owners:** task metadata/history are files; knowledge memory is a scoped file store; proactivity uses its own workspace-bound SQLite database. Their enablement and reset behavior are independent.
- **Permissions compose:** edit mode controls repository writes, tool approvals bind individual external calls, merge policy controls PR delivery, and memory/observation reads check live source audiences. One approval does not imply the others.
- **Context is not authority:** source text and model output cannot grant scope or permission. Host-derived identity, stored approval and current access checks govern effects.
- **Code and deployment differ:** configuration permits a behavior; it does not prove that a particular installation enabled it or that delivery was useful. Historical verification receipts apply to their recorded revision.

## Change and verification

Find the responsibility in the table, then inspect its linked source and focused checks. Update that map when a contract or lifecycle changes and the owning guide when an operating procedure changes. Use the [shared template](_template.md) for new maps and the [filing rules](../guides/documentation.md) for status and placement.

For code changes, follow [coding guidelines](../guides/coding-guidelines.md) and the repository's `npm run check` workflow. For running setup and authorized live verification, use [local development](../guides/local-development.md), [deployment](../guides/deployment.md) and the [E2E skill](../../.claude/skills/archie-e2e/SKILL.md). The [plan index](../plans/README.md), [proposal index](../proposals/README.md) and [OpenSpec index](../../openspec/README.md) retain decisions and evidence.
