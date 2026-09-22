# Archie HQ

**A**utonomous **R**esponsive and **C**ollaborative **H**yper **I**ntelligent **E**mployee

[![CI](https://github.com/sweatco/archie-hq/actions/workflows/ci.yml/badge.svg)](https://github.com/sweatco/archie-hq/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Built with Claude Agent SDK](https://img.shields.io/badge/built%20with-Claude%20Agent%20SDK-d97757.svg)](https://docs.anthropic.com/en/docs/claude-code/sdk)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Archie is an AI employee** — you delegate real work to it in Slack, the same way you would to a colleague, and it gets the job done across any domain: engineering, marketing, analytics, ops, or anything you plug in.

Under the hood a task is one long-lived agent — the PM — that loads the skill for the domain, hands bulky or specialised work to workers it spawns, and reports back as a single voice. It's built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) with a plugin architecture — add a new skill or department by dropping in a plugin directory, no core code changes.

> **Breaking change in 0.2.0.** A task used to run several agent processes coordinating through message queues and a shared log; it now runs one. Plugin agent frontmatter, the per-agent MCP scoping and the sandbox network allowlist all changed, so the engine and your plugins repo must be upgraded together — and existing task metadata is rewritten, so back it up first. If you run Archie with your own plugins, read [Migrating to the flat PM](docs/guides/migrating-to-flat-pm.md) before you deploy.

## Contents

- [Why one agent that delegates](#why-one-agent-that-delegates)
- [Runs your whole team on one server](#runs-your-whole-team-on-one-server)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start-no-slack-no-github--just-an-api-key)
- [Plugins](#plugins)
- [Architecture](#architecture)
- [Security](#security)
- [Documentation](#documentation)
- [Technology Stack](#technology-stack)
- [Contributing](CONTRIBUTING.md)
- [License](#license)

## Why one agent that delegates

Archie used to run several long-lived agent processes per task, coordinating through message queues, a shared log and owner handoffs. It now runs exactly one — the PM — and spawns workers through the SDK's own delegation tool. Three reasons:

- **Context stays focused, and that is what delegation is for.** Only a worker's final report comes back; everything it read stays with it. So anything bulky — a code investigation, an analytics run, a log trawl — goes out to a worker regardless of domain, and the PM's own context stays small and sharp.
- **A role is knowledge plus access, not a process.** Once the PM can load any skill and spawn any worker, most "agents" turn out to be a prompt and a tool grant that a skill expresses better. A worker earns a definition file only when it needs a fixed procedure and output envelope, or must be deliberately blind to how the material it reviews was made.
- **Coordination in prose beats coordination in machinery.** The PM briefs a worker and reads its report. There is no owner to assign, no handoff protocol, and nothing to keep in sync between processes.

Archie still reads as an **employee**, not a tool: it has a workplace (Slack), a memory that outlives a task, and a human approval gate before anything ships. You onboard new abilities as plugins, not forks.

## Runs your whole team on one server

Archie is a production system, not a demo — and it's deliberately cheap to operate:

- **Massively parallel, single box.** Every task is its own lightweight, isolated runtime, so many run concurrently on one server. In production, a single instance serves an entire ~100-person company running tasks in parallel, with no resource strain.
- **Near-zero infrastructure.** No database, no message broker, no external state store — just files on disk and git. All runtime state lives under one working directory, which makes deploying, backing up, and recovering trivial. Crash recovery is built in: tasks check-point to disk and resume after a restart.

## How It Works

```
Slack / CLI / GitHub → Task → PM agent ──┬─ skills (plugin:skill)
                                         └─ workers (plugin:agent | general-purpose)
                          ↕
              MCP tools / Git clones / APIs
```

1. A user sends a message in Slack (or via the CLI), or a GitHub webhook arrives
2. The message becomes a task, and its **PM agent** loads the relevant domain skill
3. Small conversational and operational steps the PM does itself; anything bulky it hands to a **worker** it spawns, with a brief and a model
4. Workers run in the background and report back; the PM synthesizes and replies to the user — workers cannot talk to anyone themselves
5. For code changes the user approves **edit mode** — clones then move onto a task branch, and Archie commits and opens PRs

The task is sandboxed: filesystem access is restricted to the task's own folder and clones, network egress from Bash is an explicit allowlist, and code changes require human approval.

## Quick Start (no Slack, no GitHub — just an API key)

Archie ships with a small **example plugin set** — a summarize-or-draft skill the PM runs and a writing worker it can hand bulky material to — so a fresh clone does something useful immediately. This path needs only an Anthropic API key — no Slack app, no GitHub App, no SSH keys.

```bash
# 1. Clone and install
git clone https://github.com/sweatco/archie-hq.git && cd archie-hq
npm install

# 2. Configure — the only required value is your Anthropic API key
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...

# 3. Use the bundled example plugins (symlinks examples/plugins -> workdir/plugins)
npm run example:setup

# 4. Start the server in CLI-only mode (no Slack/GitHub required)
npm run dev          # or: npm run docker:dev  (runs inside the OS sandbox)

# 5. In a second terminal, chat with Archie via the interactive CLI
npm run cli
```

Ask it something like *"summarize this: <paste a few paragraphs>"* — the PM loads the example skill and returns a structured summary, handing the work to the example worker when the material is bulky.

**Going further:**
- **Your own plugins** — point `ARCHIE_PLUGINS` at a git URL, or replace `workdir/plugins` with your own checkout. Read the bundled **`writing-plugins`** skill at [`examples/plugins/.claude/skills/writing-plugins/SKILL.md`](examples/plugins/.claude/skills/writing-plugins/SKILL.md) and the [Plugin System](docs/architecture/plugin-system.md) doc.
- **Slack** — add `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` for HTTP webhook mode, or `SLACK_APP_TOKEN` (`xapp-...`) for Socket Mode (no public URL needed). See [Local Development](docs/guides/local-development.md).
- **GitHub** — needed only for code work that opens PRs. See the [GitHub App Setup guide](docs/guides/github-setup.md) for the App, permissions, events, and env vars. The App installation is the repo allowlist; repos are cloned on demand (or warmed at startup via `archie.json`).

## Plugins

Archie is configured entirely through **plugins** — directories that follow the [Claude Code plugin structure](https://docs.anthropic.com/en/docs/claude-code/plugins) with Archie-specific extensions. A plugin defines:

- **Skills** (`skills/`) — domain workflows the PM loads on demand, namespaced as `plugin:skill`
- **Agents** (`agents/*.md`) — worker types the PM can spawn, addressable as `plugin:agent`
- **Hooks** (`hooks/`) — Claude Code hooks for cost guards, validation, etc.

Skills, agents and hooks are loaded natively by the Claude Agent SDK. Three files at the repo root stay engine-owned:

- **MCP servers** (`.mcp.json`) — external tool integrations (Jira, Firebase, BigQuery, …), plus the per-tool approval tiers that decide which calls need a human
- **Engine config** (`archie.json`) — the sandbox network allowlist, which repos to warm-clone at startup, and which may be merged without asking
- **PM overlay** (`pm.md`) — standing organisational context, tone and rules appended to the PM's system prompt, and its default model and effort, with no engine changes needed; see [Plugin System](docs/architecture/plugin-system.md#pm-overlay-pmmd)

Example plugin structure:

```
plugins/
├── engineering/
│   ├── .claude-plugin/plugin.json
│   ├── skills/
│   │   └── pr-workflow/SKILL.md  # loadable as engineering:pr-workflow
│   ├── agents/
│   │   └── qa-reviewer.md        # spawnable as engineering:qa-reviewer
│   └── hooks/hooks.json
├── marketing/
│   ├── .claude-plugin/plugin.json
│   ├── skills/
│   │   └── tone-analysis/SKILL.md
│   └── agents/
│       └── tov-reviewer.md
├── .mcp.json                     # MCP servers + per-tool approval tiers
└── archie.json                   # network allowlist, warm repos, auto-merge
```

An agent file needs a `name`, a `description` (that is what the PM reads when choosing a worker) and usually a `model` and `effort`. There is no repo binding: the GitHub App installation is the allowlist, and the PM mounts what a task needs.

Write an agent file only when a worker earns one — a fixed procedure and output envelope, a reviewer that must be blind to how the material was made, or a model/effort pairing the PM cannot express per spawn. Everything else is a skill the PM loads plus the general-purpose worker.

To add a new domain: create a plugin directory, drop in skills, and push. No core code changes and no redeploy — the next task picks it up.

## Architecture

A task is one agent and one SDK session:

| | What it is | What it does |
| --- | --- | --- |
| **PM agent** | One per task, Opus by default | Talks to users, loads domain skills, mounts repos, spawns and briefs workers |
| **Plugin agents** | Worker types a plugin defines | A fixed procedure, or a reviewer blind to how the material was made |
| **General-purpose worker** | Built into the SDK | Everything else, with a model the PM names per spawn |

Workers run inside the PM's own session and report back to it; only their final report reaches its context, and none of them can reach a user directly.

**Key capabilities:**

- Delegation through the SDK's own `Agent` tool, with background workers that wake the PM when they finish
- Skills and worker types loaded natively from plugin directories, namespaced per plugin
- Git shared clones mounted on demand, one per repo per task
- Human approval gates: edit mode for code changes, per-call approval for critical MCP tools, per-PR approval for merges
- Automated PR creation and merge orchestration
- OS-level sandbox (bubblewrap) for filesystem and network isolation
- Web research pipeline with structured output and injection defense
- Cross-task memory, persistent triggers, and per-task budgets (research requests, wall-clock timeout)

## Security

A task runs in a sandboxed environment with defense-in-depth. **The task, not an agent, is the isolation boundary:** workers run inside the PM's session and share its credentials, network allowlist and filesystem grants, so per-call approval tiers — not per-agent credential scoping — are what gate critical writes.

- **Filesystem isolation** — a task can only read/write its own session folder and clones, via bubblewrap (Bash) and PreToolUse hooks (Read/Write/Edit); base clones are read-only
- **Network deny-all** — Bash cannot reach the internet beyond an explicit allowlist (one union for the whole session, from `archie.json`); web access only through the controlled research pipeline
- **Tool denylists** — WebSearch/WebFetch always blocked; repo writes, pushes and PRs withheld until edit mode is approved
- **Human gates** — edit mode requires Slack approval; critical MCP calls pause for per-call approval; PRs require review before merge
- **Git safety** — branch protection server-side; no force push; git push blocked from Bash (no network)

See [Security Architecture](docs/architecture/security.md) for the full threat model, enforcement layers, and deployment requirements.

## Documentation

**Architecture:**

- [Overview](docs/architecture/overview.md) — system design and concepts
- [Agents](docs/architecture/agents.md) — the PM, its workers, models and effort
- [Orchestration](docs/architecture/orchestration.md) — task lifecycle, activation and recovery
- [Tool Approvals](docs/architecture/tool-approvals.md) — per-call human approval for critical MCP tools
- [Security](docs/architecture/security.md) — sandbox, threat model, defense layers, deployment
- [Plugin System](docs/architecture/plugin-system.md) — plugin structure and agent registration
- [Edit Mode](docs/architecture/edit-mode.md) — approval flow, shared clones, git workflow
- [Persistence](docs/architecture/persistence.md) — session storage and recovery
- [Slack Integration](docs/architecture/slack-integration.md) — UX layer
- [GitHub Integration](docs/architecture/github-integration.md) — PR workflow
- [Web Research](docs/architecture/web-research.md) — the controlled `web_research` pipeline

**Guides:**

- [Migrating to the flat PM](docs/guides/migrating-to-flat-pm.md) — the 0.2.0 breaking change: what to convert in your plugins repo, and what happens to existing tasks
- [Local Development](docs/guides/local-development.md) — full setup with Slack, GitHub App, ngrok
- [GitHub App Setup](docs/guides/github-setup.md) — create the App, required permissions & webhook events, env vars
- [Plugin System](docs/architecture/plugin-system.md) — how plugins are structured and loaded (plus the bundled `writing-plugins` skill under `examples/plugins/.claude/skills/`)
- [Docker Setup](DOCKER.md) — container configuration and troubleshooting
- [Deployment](docs/guides/deployment.md) — production deployment and operations

**Project:**

- [Contributing](CONTRIBUTING.md) — how to set up, the dev loop, and PR expectations
- [Security Policy](SECURITY.md) — how to report a vulnerability
- [Code of Conduct](CODE_OF_CONDUCT.md) — community standards
- [Changelog](CHANGELOG.md) — notable changes by version

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