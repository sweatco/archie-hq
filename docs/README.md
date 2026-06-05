# Archie Documentation

**Archie** (Autonomous Responsive and Collaborative Hyper Intelligent Employee) is a multi-agent AI software engineering system built on the Claude Agent SDK. Specialized agents collaborate on tasks across multiple repositories via Slack integration.

## Architecture

How the system works today. Each doc describes the actual implementation, verified against source code.

| Document | Description |
|----------|-------------|
| [Overview](architecture/overview.md) | High-level architecture, principles, tech stack, source structure |
| [Agents](architecture/agents.md) | Agent types, roles, communication, prompt composition |
| [Orchestration](architecture/orchestration.md) | Task lifecycle, message routing, MCP tools, recovery |
| [Persistence](architecture/persistence.md) | File-based sessions, metadata, shared knowledge log |
| [Slack Integration](architecture/slack-integration.md) | Webhooks, message flow, UX patterns |
| [GitHub Integration](architecture/github-integration.md) | PR management, webhooks, merge orchestration |
| [Edit Mode](architecture/edit-mode.md) | Read/write modes, shared clones, approval flow |
| [Plugin System](architecture/plugin-system.md) | Plugin architecture, agent tracks, skill discovery |
| [Web Research](architecture/web-research.md) | Research pipeline, multi-agent research tool |
| [Security](architecture/security.md) | Threat model, defense layers, prompt injection defense |
| [Secrets](architecture/secrets.md) | OAuth vault, encryption, secret handling |

## Guides

How to work with the system. Setup, deployment, and development patterns.

| Document | Description |
|----------|-------------|
| [Local Development](guides/local-development.md) | Prerequisites, setup, running, debugging |
| [Deployment](guides/deployment.md) | GCP deployment, CI/CD, monitoring, operations |
| [SDK Patterns](guides/sdk-patterns.md) | Agent SDK hooks, turn detection, streaming input |
| [Bedrock Guardrails Setup](guides/bedrock-guardrails-setup.md) | Configuring AWS Bedrock guardrails for prompt injection defense |

## Plans

Historical record of development milestones. Each plan has a status header indicating implementation state.

| Plan | Feature | Status |
|------|---------|--------|
| [v1](plans/v1-core-system.md) | Core multi-agent system | Implemented |
| [v2](plans/v2-edit-mode.md) | Edit mode & git worktrees | Implemented |
| [v3](plans/v3-git-and-prs.md) | Git commits & pull requests | Implemented |
| [v4](plans/v4-queue-architecture.md) | Queue-based architecture | Not implemented |
| [v5](plans/v5-agent-recovery-design.md) | Agent recovery design | Partially implemented |
| [v6](plans/v6-plugin-architecture.md) | Plugin architecture | Partially implemented |
| [v7](plans/v7-plugin-agents.md) | Plugin agent track | Implemented |
| [v8](plans/v8-web-research.md) | Web research pipeline | Implemented |
| [v9](plans/v9-prompt-injection-defense.md) | Prompt injection defense | Implemented |
| [v10](plans/v10-agent-recovery-impl.md) | Agent recovery implementation | Partially implemented |
| [v11](plans/v11-workdir-consolidation.md) | Workdir consolidation | Implemented |
| [v12](plans/v12-task-agent-refactor.md) | Task/agent refactor | Implemented |
| [v13](plans/v13-connectors-restructure.md) | Connectors restructure | Implemented |
| [v14](plans/v14-cli-tui-channels.md) | CLI/TUI channels | Implemented |
| [v15](plans/v15-events-jsonl.md) | Events JSONL persistence | Implemented |
| [v16](plans/v16-pr-tools-to-repo-agent.md) | Move PR tools to repo agent | Implemented |
| [v17](plans/v17-git-workflow.md) | Git workflow refinements | Implemented |
| [v18](plans/v18-shared-clones.md) | Shared repo clones | Implemented |
| [v19](plans/v19-sandbox-lockdown.md) | Sandbox lockdown | Implemented |
| [v20](plans/v20-slack-user-lookup-targeted-messaging.md) | Slack user lookup & targeted messaging | Implemented |
| [v21](plans/v21-agent-reminders.md) | Agent reminders | Implemented |
| [v22](plans/v22-github-triage-removal.md) | GitHub triage removal | Implemented |
| [v23](plans/v23-launch-task.md) | Launch task tooling | Implemented |
| [v24](plans/v24-shared-channel-guardrails.md) | Shared channel guardrails | Implemented |
| [v25](plans/v25-task-titles.md) | Task titles | Implemented |
| [v26](plans/v26-artifact-sharing.md) | Artifact sharing | Implemented |
| [v27](plans/v27-oauth-mcp-secrets.md) | OAuth-managed MCP secrets | Implemented |

See [plans/README.md](plans/README.md) for the full evolution arc.

## Proposals

Future work and unimplemented features. These are ideas that have been designed but not yet built.

| Document | Description |
|----------|-------------|
| [GitHub @mention Workflow](proposals/github-mention-workflow.md) | @mention Archie in GitHub PRs |
| [Distributed Queues](proposals/distributed-queues.md) | Redis/GroupMQ for multi-pod scaling |
| [LLM Guard Integration](proposals/llm-guard-integration.md) | Full DLP scanning service |
| [Analytics Plugin Gaps](proposals/analytics-plugin-gaps.md) | Roadmap for analytics plugin (MVP shipped) |
| [Architecture Simplification](proposals/architecture-simplification.md) | Ideas to reduce complexity in core flows |

## Quick Reference

**Message flow:** Slack/GitHub → PM Agent → Specialist Agents. The triage agent (`src/system/triage.ts`) exists but is currently disabled — Slack messages route directly to the PM.

**Agent types:**
- **PM** (Opus by default) — manages tasks, assigns owners, communicates with users
- **Repo Agents** — investigate and modify code in specific repositories (model configured per agent in plugin frontmatter)
- **Plugin Agents** — domain-specific agents without git infrastructure (model configured per agent in plugin frontmatter)

**Key files:**
- Entry point: `src/index.ts`
- Agent spawners and registry: `src/agents/`
- System orchestration: `src/system/`
- Web research (optional MCP tool + host hook): `src/extensions/web-research/` (wired in `src/agents/spawn.ts`)
- Connectors (Slack, GitHub, OAuth, API): `src/connectors/`
- Agent prompts: `prompts/`
- Plugins are git-cloned into the runtime workdir (`ARCHIE_WORKDIR`, default `./workdir`); see `src/system/workdir.ts` and `src/system/plugin-loader.ts`
