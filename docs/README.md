# Archie documentation

Start with the [system module map](architecture/overview.md) to find the responsibility you need, then open its architecture document. Current maps describe implementation; guides explain procedures. Plans, proposals and older specifications retain their own status and evidence limits.

When changing documentation, follow the [filing guide](guides/documentation.md) and [shared module template](architecture/_template.md).

## Architecture

| Map | Owns |
| --- | --- |
| [System overview](architecture/overview.md) | Module boundaries, startup, shutdown and cross-module flow |
| [Agents](architecture/agents.md) | PM definition, SDK session, native workers, tool and artifact attachment |
| [Orchestration](architecture/orchestration.md) | Task lifecycle, activation, parking, completion and recovery |
| [Persistence](architecture/persistence.md) | Task files, metadata, events, knowledge log and usage accounting |
| [Slack](architecture/slack-integration.md) | Ingress, conversation routing, rendering and delivery |
| [GitHub](architecture/github-integration.md) | App integration, webhook routing, PR lifecycle and merge coordination |
| [API and CLI](architecture/api-cli.md) | Operator REST/SSE interface, response contracts and terminal views |
| [Edit mode](architecture/edit-mode.md) | Task repository mounts, clones and approved write access |
| [Plugins](architecture/plugin-system.md) | Capability discovery, root deployment configuration and native SDK loading |
| [Tool approvals](architecture/tool-approvals.md) | Per-call policy, previews, exact-call grants and consumption |
| [Max mode](architecture/max-mode.md) | Approved PM model/effort upgrade and conversation retention |
| [Triggers](architecture/triggers.md) | Approved persistent conditions, bindings, firing and per-trigger data |
| [Web research](architecture/web-research.md) | Controlled research pipeline, reports, guardrails and budget integration |
| [Secrets and OAuth](architecture/secrets.md) | Vault records, connect callback, refresh and spawn-time MCP binding |
| [Memory](architecture/memory.md) | Workspace-bound knowledge, scoped extraction and authorized recall |
| [Proactivity](architecture/proactivity.md) | Public observations, matters, bounded help and recipient-approved handoffs |
| [Security](architecture/security.md) | Trust boundaries, containment, enforcement limits and live tripwires |

## Guides

| Guide | Use it for |
| --- | --- |
| [Local development](guides/local-development.md) | Setup, runtime modes, debugging and local completion hooks |
| [Coding guidelines](guides/coding-guidelines.md) | Readable code, review rubric and automated checks |
| [Documentation filing](guides/documentation.md) | Placement, module template, lifecycle labels and maintenance |
| [Deployment](guides/deployment.md) | Container deployment, storage, monitoring and recovery |
| [Docker setup](../DOCKER.md) | Local containers, required capabilities and troubleshooting |
| [GitHub App setup](guides/github-setup.md) | App configuration, permissions, webhooks and verification |
| [OAuth MCP authentication](guides/oauth-mcp-authentication.md) | Connect, inspect, refresh and revoke local OAuth credentials |
| [SDK patterns](guides/sdk-patterns.md) | Archie-specific SDK integration patterns and source examples |
| [Cloud sandbox E2E](guides/e2e-in-cloud-sandbox.md) | Prepare the existing harness in a proxy-backed cloud environment |
| [Flat PM migration](guides/migrating-to-flat-pm.md) | Upgrade older plugins and task state across the 0.2.0 boundary |
| [Bedrock guardrail setup](guides/bedrock-guardrails-setup.md) | Configure optional research scanning; verify current provider settings |
| [Initiative operations](guides/initiative-operations.md) | Modes, employee feedback, storage diagnostics and handoff recovery |
| [Initiative verification](guides/initiative-verification.md) | Local/live checks, recorded evidence and limits on usefulness claims |

## Decisions and history

- [Plans and outcome records](plans/README.md) — complete inventory of implementation intent, outcomes and experiments; historical designs remain at their original paths.
- [Proposals and retained research](proposals/README.md) — unresolved choices separated from adopted, replaced and externally handed-off work.
- [OpenSpec records](../openspec/README.md) — specification snapshots and archived verification evidence, with current owners identified.
- [Documentation reorganization record](plans/20261111-documentation-filing.md) — audit findings, retained material and verification of this structure.

## Contributor entry points

[Repository instructions](../AGENTS.md), [contributing](../CONTRIBUTING.md), [security reporting](../SECURITY.md) and the generated [changelog](../CHANGELOG.md) retain their distinct roles. Prompts and skills are executable behavior/instructions and are not a documentation archive.
