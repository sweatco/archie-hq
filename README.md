# Archie HQ

**A**utonomous **R**esponsive and **C**ollaborative **H**yper **I**ntelligent **E**mployee

A multi-agent AI system that handles work across any domain — engineering, marketing, analytics, ops, or anything you plug in. Agents collaborate on tasks via Slack, using whatever tools each domain needs. Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) with a plugin architecture: add a new domain by dropping in a plugin directory, no core code changes.

## How It Works

```
Slack / CLI → PM Agent → Domain Agents
                 ↕              ↕
           Shared knowledge log / MCP tools / Git / APIs
```

1. A user sends a message in Slack (or via the CLI)
2. The **PM agent** reads the request, loads the relevant domain skill, and delegates to the right agents
3. **Domain agents** do the actual work — investigate code, query databases, draft copy, analyze data, call external APIs — whatever their domain requires
4. The PM synthesizes results and responds to the user
5. For engineering tasks that need code changes, the user approves **edit mode** — agents then create branches, write code, and open PRs

Each agent is sandboxed: filesystem access is restricted to its workspace, network is blocked from Bash, and code changes require human approval.

## Quick Start

```bash
# 1. Clone and install
git clone git@github.com:<org>/archie-hq.git && cd archie-hq
cp .env.example .env
# Set ANTHROPIC_API_KEY in .env (minimum requirement)

# 2. Set up plugins (defines which domains, agents, and repos exist)
git clone git@github.com:<org>/archie-plugins.git ../archie-plugins
mkdir -p workdir
ln -s ../archie-plugins workdir/plugins

# 3. Ensure SSH key is loaded (used for git inside Docker)
ssh-add

# 4. Start server
npm run docker:dev

# 5. Interact via CLI (separate terminal)
npm run cli
```

Repos defined in plugins are auto-cloned on startup — no manual setup needed.

The **CLI** (`npm run cli`) provides an interactive terminal UI for creating tasks and chatting with Archie without Slack. For Slack integration, add `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` to `.env` for HTTP webhook mode, or set `SLACK_APP_TOKEN` (`xapp-...`) for Socket Mode (no public URL needed — skip ngrok). See [Local Development Guide](docs/guides/local-development.md) for full setup including Slack bot creation and GitHub App.

## Plugins

Archie is configured entirely through **plugins** — directories that follow the [Claude Code plugin structure](https://docs.anthropic.com/en/docs/claude-code/plugins) with Archie-specific extensions. A plugin defines:

- **Agents** (`agents/*.md`) — domain agents with roles, expertise, repo bindings, and tool configuration
- **PM extension** (`agents/pm.md`) — extends the PM agent with domain-specific context and MCP tools
- **MCP servers** (`.mcp.json`) — external tool integrations (Jira, Firebase, BigQuery, etc.)
- **Skills** (`skills/`) — domain-specific workflows the PM agent can load on demand
- **Hooks** (`hooks/`) — Claude Code hooks for cost guards, validation, etc.

Example plugin structure:

```
plugins/
├── pm/                           # PM extension
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── agents/
│   │   └── pm.md                # Extends PM with domain context and MCP tools
│   └── skills/
│       └── engineering/SKILL.md # Workflows the PM loads on demand
├── engineering/                  # Engineering domain (repo agents)
│   ├── .claude-plugin/
│   │   └── plugin.json
│   └── agents/
│       └── mobile.md            # Repo agent — has metadata.archie.repo binding
├── marketing/                   # Marketing domain (plugin agent)
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── agents/
│   │   └── copywriter.md        # Plugin agent — workspace + tools, no repo
│   ├── skills/
│   │   └── marketing/SKILL.md   # Domain workflow for PM
│   └── hooks/
│       └── hooks.json           # Claude Code hooks (cost guards, validation, etc.)
└── .mcp.json                    # Shared MCP server configs (firebase, jira, etc.)
```

**Repo agents** require a `metadata.archie.repo` block in their frontmatter to bind to a GitHub repository:

```yaml
---
role: Senior React Native engineer
metadata:
  archie:
    repo:
      github: org/mobile-app
      baseBranch: main
mcpServers:
  - firebase
  - bugsnag
---
```

**Plugin agents** just need `role` and optionally `mcpServers` — no repo binding, they get a workspace and tools.

To add a new domain: create a plugin directory, define agents in markdown frontmatter, and restart. No core code changes needed.

## Architecture

Archie has three agent types, all configured through plugins:


| Agent             | Examples                 | What it does                                                      |
| ----------------- | ------------------------ | ----------------------------------------------------------------- |
| **PM Agent**      | One per task             | Coordinates agents, talks to users, loads domain skills on demand |
| **Repo Agents**   | Backend, Mobile          | Full codebase access, git, PRs, CI tools — one per repository     |
| **Plugin Agents** | Copywriter, Analyst, Ops | Any domain — gets a workspace, MCP tools, and read/write access   |


Repo agents are for engineering work (code + git + GitHub). Plugin agents are for everything else — they get a workspace, any MCP tools you wire up, and read/write access to their domain. The PM agent is extended by a special `pm` plugin that adds domain context, MCP tools, and skills.

**Key capabilities:**

- Agent-to-agent communication via message queues
- Shared knowledge log for findings and audit trail
- Git shared clones for isolated, parallel task execution (repo agents)
- MCP tool integration for any external service (plugin agents)
- Human approval gate for code changes (read-only → edit mode)
- Automated PR creation and merge orchestration
- OS-level sandbox (bubblewrap) for filesystem and network isolation
- Web research pipeline with structured output and injection defense
- Per-task resource budgets (research requests, wall-clock timeout)

## Security

Agents run in a sandboxed environment with defense-in-depth:

- **Filesystem isolation** — each agent can only read/write its own workspace via bubblewrap (Bash) and PreToolUse hooks (Read/Write/Edit)
- **Network deny-all** — Bash cannot reach the internet; web access only through the controlled research pipeline
- **Tool denylists** — WebSearch/WebFetch blocked on all agents; Write/Edit blocked in read-only mode
- **Human gates** — edit mode requires Slack approval; PRs require review before merge
- **Git safety** — branch protection server-side; no force push; git push blocked from Bash (no network)

See [Security Architecture](docs/architecture/security.md) for the full threat model, enforcement layers, and deployment requirements.

## Documentation

**Architecture:**

- [Overview](docs/architecture/overview.md) — system design and concepts
- [Agents](docs/architecture/agents.md) — agent types, prompts, communication
- [Orchestration](docs/architecture/orchestration.md) — task lifecycle, message routing
- [Security](docs/architecture/security.md) — sandbox, threat model, defense layers, deployment
- [Plugin System](docs/architecture/plugin-system.md) — plugin structure and agent registration
- [Edit Mode](docs/architecture/edit-mode.md) — approval flow, shared clones, git workflow
- [Persistence](docs/architecture/persistence.md) — session storage and recovery
- [Slack Integration](docs/architecture/slack-integration.md) — UX layer
- [GitHub Integration](docs/architecture/github-integration.md) — PR workflow
- [Web Research](docs/architecture/web-research.md) — multi-agent research pipeline

**Guides:**

- [Local Development](docs/guides/local-development.md) — full setup with Slack, GitHub App, ngrok
- [Docker Setup](DOCKER.md) — container configuration and troubleshooting
- [Deployment](docs/guides/deployment.md) — production deployment and operations

## Technology Stack

- **Runtime:** Node.js with TypeScript
- **AI:** [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk)
- **Integrations:** Slack API (Bolt), GitHub App (Octokit), MCP servers
- **Sandbox:** Bubblewrap (Linux), sandbox-exec (macOS)
- **Storage:** File-based sessions under `ARCHIE_WORKDIR`

## License

Licensed under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later). See [LICENSE](LICENSE).

In plain terms: you are free to use, study, modify, and self-host Archie, including inside your own organization, without restriction. The AGPL's network-copyleft condition means that if you run a **modified** version as a service made available to others (e.g. a hosted offering), you must make the corresponding source of your modifications available under the same license. This keeps improvements flowing back to the community.

This software is provided "as is", without warranty of any kind, express or implied. See the LICENSE for the full terms.

> The final license terms are subject to an external legal review.