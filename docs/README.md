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
| [Edit Mode](architecture/edit-mode.md) | Read/write modes, worktrees, approval flow |
| [Plugin System](architecture/plugin-system.md) | Plugin architecture, agent tracks, skill discovery |
| [Web Research](architecture/web-research.md) | Research pipeline, multi-agent research tool |
| [Security](architecture/security.md) | Threat model, defense layers, prompt injection defense |

## Guides

How to work with the system. Setup, deployment, and development patterns.

| Document | Description |
|----------|-------------|
| [Local Development](guides/local-development.md) | Prerequisites, setup, running, debugging |
| [Deployment](guides/deployment.md) | GCP deployment, CI/CD, monitoring, operations |
| [SDK Patterns](guides/sdk-patterns.md) | Agent SDK hooks, turn detection, streaming input |

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

See [plans/README.md](plans/README.md) for the full evolution arc.

## Proposals

Future work and unimplemented features. These are ideas that have been designed but not yet built.

| Document | Description |
|----------|-------------|
| [GitHub @mention Workflow](proposals/github-mention-workflow.md) | @mention Archie in GitHub PRs |
| [Distributed Queues](proposals/distributed-queues.md) | Redis/GroupMQ for multi-pod scaling |
| [LLM Guard Integration](proposals/llm-guard-integration.md) | Full DLP scanning service |

## Quick Reference

**Message flow:** Slack/GitHub → Triage Agent (Haiku) → System → PM Agent → Specialist Agents

**Agent types:**
- **Triage** (Haiku) — classifies incoming events
- **PM** (Sonnet) — manages tasks, assigns owners, communicates with users
- **Repo Agents** (Sonnet) — investigate and modify code in specific repositories
- **Plugin Agents** (Sonnet) — domain-specific agents without git infrastructure

**Key files:**
- Entry point: `src/index.ts`
- Agent spawners: `src/agents/`
- System orchestration: `src/system/`
- MCP tools: `src/mcp/`
- Agent prompts: `prompts/`
- Domain plugins: `plugins/`
