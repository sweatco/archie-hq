# Plans and outcome records

Plans record what was intended, decided and observed. Current behavior belongs in the linked module map or guide. The historical collection remains at its existing paths so earlier links continue to work; its original implementation labels have not all been requalified. A historical classification does not cancel a feature or close an external PR.

New plans use `YYYYMMDD-<topic>.md`; retain legacy filenames. Follow the [filing guide](../guides/documentation.md). Small fixes need no plan.

## Current reorganization

- [Documentation filing](20261111-documentation-filing.md) — audit, adopted structure and local verification.

## Historical designs and outcomes

| Record | Disposition | Current home and retained value |
| --- | --- | --- |
| [20260626-response-formatting.md](20260626-response-formatting.md) | Historical design/outcome | [Slack](../architecture/slack-integration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [20260627-channel-canvas-project-context.md](20260627-channel-canvas-project-context.md) | Historical design/outcome | [Slack](../architecture/slack-integration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [20260627-completion-quiescence.md](20260627-completion-quiescence.md) | Historical; correct status | [Task runtime](../architecture/orchestration.md). Header still claims unimplemented, but task completion intent is implemented; retain race rationale. |
| [20260627-pm-permissions-task-creation.md](20260627-pm-permissions-task-creation.md) | Historical; retained correction | [Task runtime](../architecture/orchestration.md). Preserve bot-token search descoping; old task/messaging policy is not a present contract. |
| [20260701-max-mode.md](20260701-max-mode.md) | Historical; superseded mechanics | [Max mode](../architecture/max-mode.md). Per-agent upgrade design predates flat PM; current max-mode architecture owns behavior. |
| [20260717-slack-group-dm-support.md](20260717-slack-group-dm-support.md) | Historical design/outcome | [Slack](../architecture/slack-integration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [20260721-task-usage-tool.md](20260721-task-usage-tool.md) | Historical design/outcome | [Persistence](../architecture/persistence.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [20260809-channel-pinned-messages-context.md](20260809-channel-pinned-messages-context.md) | Historical design/outcome | [Slack](../architecture/slack-integration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [20260817-persistent-trigger-directory.md](20260817-persistent-trigger-directory.md) | Historical design/outcome | [Triggers](../architecture/triggers.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [20260817-unify-core-skill-mounting.md](20260817-unify-core-skill-mounting.md) | Historical; superseded mechanics | [Plugins](../architecture/plugin-system.md). Native SDK plugin loading supersedes custom mounting design. |
| [20260818-slack-single-message-path.md](20260818-slack-single-message-path.md) | Historical design/outcome | [Slack](../architecture/slack-integration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [20260819-trigger-task-owns-conversation.md](20260819-trigger-task-owns-conversation.md) | Historical design/outcome | [Triggers](../architecture/triggers.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [20260827-dm-triggers.md](20260827-dm-triggers.md) | Historical; verification gap | [Triggers](../architecture/triggers.md). Retain explicit unverified AC12 live DM run; do not silently mark fully verified. |
| [20260910-flat-pm-rework.md](20260910-flat-pm-rework.md) | Historical rationale | [System map](../architecture/overview.md). Keep accepted boundary decisions; deletion predictions differ from retained message queue/knowledge log. |
| [20260910-plugins-flat-migration.md](20260910-plugins-flat-migration.md) | Historical migration record | [Plugins](../architecture/plugin-system.md). Keep cross-repo mapping/lessons; current plugin contract belongs in module map; external state unverified. |
| [20260926-prompt-only-concise-pilot.md](20260926-prompt-only-concise-pilot.md) | Evidence; failed gate | [Agents](../architecture/agents.md). Keep factuality failures, scope and SDK mismatch. Active draft status needs owning PR check. |
| [20260930-historic-reply-scope.md](20260930-historic-reply-scope.md) | Evidence; incomplete gate | [Agents](../architecture/agents.md). Keep matched results and shared delivery failure. Do not treat shorter prompt as rollout-ready. |
| [20261109-coding-guidelines-and-checks.md](20261109-coding-guidelines-and-checks.md) | Historical outcome; close status | [Coding guidelines](../guides/coding-guidelines.md). Code is present on main, while opening still says prepared for draft PR. Keep zero-debt result, link guide; readability evaluation remains pending. |
| [20261110-coding-guidelines-review.md](20261110-coding-guidelines-review.md) | Historical review evidence | [Coding guidelines](../guides/coding-guidelines.md). Preserve specific behavior repair findings and checks, linked from adoption record; no current behavior duplication. |
| [20261111-agent-completion-hooks.md](20261111-agent-completion-hooks.md) | Historical outcome evidence | [Coding guidelines](../guides/coding-guidelines.md). Canonical behavior already in coding/local-dev guides; preserve native client discovery/trust limits. |
| [v1-core-system.md](v1-core-system.md) | Historical design/outcome | [System map](../architecture/overview.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v10-agent-recovery-impl.md](v10-agent-recovery-impl.md) | Historical design/outcome | [Agents](../architecture/agents.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v11-workdir-consolidation.md](v11-workdir-consolidation.md) | Historical design/outcome | [System map](../architecture/overview.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v12-task-agent-refactor.md](v12-task-agent-refactor.md) | Historical design/outcome | [Agents](../architecture/agents.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v13-connectors-restructure.md](v13-connectors-restructure.md) | Historical design/outcome | [System map](../architecture/overview.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v14-cli-tui-channels.md](v14-cli-tui-channels.md) | Historical design/outcome | [API and CLI](../architecture/api-cli.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v15-events-jsonl.md](v15-events-jsonl.md) | Historical design/outcome | [Persistence](../architecture/persistence.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v16-pr-tools-to-repo-agent.md](v16-pr-tools-to-repo-agent.md) | Historical; superseded ownership | [GitHub](../architecture/github-integration.md). Current tools belong to PM task session, not separate repo-agent processes. |
| [v17-git-workflow.md](v17-git-workflow.md) | Historical design/outcome | [GitHub](../architecture/github-integration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v18-shared-clones.md](v18-shared-clones.md) | Historical design/outcome | [Repository workspace](../architecture/edit-mode.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v19-sandbox-lockdown.md](v19-sandbox-lockdown.md) | Historical design/outcome | [Security](../architecture/security.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v2-edit-mode.md](v2-edit-mode.md) | Historical design/outcome | [Repository workspace](../architecture/edit-mode.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v20-slack-user-lookup-targeted-messaging.md](v20-slack-user-lookup-targeted-messaging.md) | Historical; superseded policy | [Slack](../architecture/slack-integration.md). Later PM-permissions plan changed outbound task creation/messaging assumptions. |
| [v21-agent-reminders.md](v21-agent-reminders.md) | Historical design/outcome | [Triggers](../architecture/triggers.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v22-github-triage-removal.md](v22-github-triage-removal.md) | Historical design/outcome | [GitHub](../architecture/github-integration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v23-launch-task.md](v23-launch-task.md) | Historical; superseded policy | [Task runtime](../architecture/orchestration.md). Old autonomous task tooling is not the current creation/approval contract. |
| [v24-shared-channel-guardrails.md](v24-shared-channel-guardrails.md) | Historical design/outcome | [Slack](../architecture/slack-integration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v25-task-titles.md](v25-task-titles.md) | Historical design/outcome | [Task runtime](../architecture/orchestration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v26-artifact-sharing.md](v26-artifact-sharing.md) | Historical; superseded mechanics | [Agents](../architecture/agents.md). Cross-process sharing design predates task-wide worker filesystem. |
| [v27-oauth-mcp-secrets.md](v27-oauth-mcp-secrets.md) | Historical design/outcome | [Secrets and OAuth](../architecture/secrets.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v28-pr-ci-checks.md](v28-pr-ci-checks.md) | Historical design/outcome | [GitHub](../architecture/github-integration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v29-agent-visibility-scoping.md](v29-agent-visibility-scoping.md) | Historical; superseded mechanics | [Agents](../architecture/agents.md). Per-agent visibility system predates flat PM. |
| [v3-git-and-prs.md](v3-git-and-prs.md) | Historical design/outcome | [GitHub](../architecture/github-integration.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v30-multi-repo-agents.md](v30-multi-repo-agents.md) | Historical; superseded mechanics | [Agents](../architecture/agents.md). Repos mount per task via mount_repo, not repo-agent declarations. |
| [v31-pm-spawn-repo-agents.md](v31-pm-spawn-repo-agents.md) | Historical; superseded mechanics | [Agents](../architecture/agents.md). PM now uses SDK Agent delegation and task repo mounts. |
| [v31-triggers.md](v31-triggers.md) | Historical design/outcome | [Triggers](../architecture/triggers.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v4-queue-architecture.md](v4-queue-architecture.md) | Deferred historical design | [Task runtime](../architecture/orchestration.md). One canonical future-work summary in distributed-queues; old triage/agent design cannot be implemented verbatim. |
| [v5-agent-recovery-design.md](v5-agent-recovery-design.md) | Historical; superseded design | [Agents](../architecture/agents.md). Already points to v10; current recovery behavior belongs to orchestration map. |
| [v6-plugin-architecture.md](v6-plugin-architecture.md) | Historical; superseded mechanics | [Plugins](../architecture/plugin-system.md). Custom agent/config discovery predates native SDK plugins. |
| [v7-plugin-agents.md](v7-plugin-agents.md) | Historical; superseded mechanics | [Plugins](../architecture/plugin-system.md). Custom plugin-agent tracks/prompt layers replaced by flat PM. |
| [v8-web-research.md](v8-web-research.md) | Historical design/outcome | [Web research](../architecture/web-research.md). Preserve intent and unique rationale; link current owning architecture. Original implementation status not requalified. |
| [v9-prompt-injection-defense.md](v9-prompt-injection-defense.md) | Historical; correct status caveat | [Security](../architecture/security.md). LLM Guard header is stale; current code conditionally uses Bedrock scanning. |

## How to read the collection

Older plans describe peer agents, custom plugin tracks, triage and per-agent repositories that the flat PM later replaced. Keep their rationale and acceptance history; use current maps for an implementation. The September reply pilots retain negative/incomplete evidence. The November coding and completion-hook records retain actual checks and their deployment/native-client limitations.
