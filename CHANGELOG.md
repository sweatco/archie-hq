# Changelog

All notable changes to Archie HQ are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Archie ships **continuously** — every merge to `main` builds a fresh Docker
image, and `SECURITY.md` asks operators to track `main`. We therefore keep a
**date-based** changelog rather than cutting formal versioned releases: notable
changes are grouped under the date they landed. (If we later tag versions, a
dated heading like `## 2026-06-29` simply becomes `## [0.1.0] - 2026-06-29`.)

## [Unreleased]

_Changes on `main` that haven't been summarized into a dated entry yet._

## 2026-06-29 — Initial public baseline

The capabilities Archie HQ ships with as of going public. Subsequent entries
record what changes from here.

### Added

- **An AI employee you work with in Slack.** Delegate a task in a Slack thread
  (or the local CLI) and Archie gets it done, then reports back. To users it
  presents as a single assistant that writes as "I" — the multi-agent machinery
  underneath is never exposed. It is **non-proactive** (only acts in response to
  a Slack message or GitHub webhook, never on its own) and **interruptible**
  (tasks can be stopped, resumed, and recovered).

- **A team of agents, not one chatbot.** A **PM agent** (Opus) reads the
  request, loads the relevant skill, and delegates to specialist agents
  (Sonnet). A designated **task owner** coordinates the work — sequentially or
  in parallel — and synthesizes the result. Agents talk to each other
  peer-to-peer and write discoveries, decisions, and blockers to a shared
  **knowledge log** that every agent reads for context.

- **Plugin architecture — add a department, not a fork.** New domains and
  abilities are added by dropping a plugin directory into the plugins repo; the
  engine discovers and loads them at startup with no core code changes. A plugin
  can contribute repo agents, plugin agents, a PM overlay, agent skills, hooks,
  and MCP server bindings.

- **Repo agents for engineering work.** Agents bound to a GitHub repository work
  in isolated shared git clones. They are **read-only by default**; once a human
  approves **edit mode**, the agent gets a feature branch, commits (authored as
  the person who approved), and opens and manages its own pull requests.

- **Plugin agents for every other domain.** Marketing, analytics, ops, support,
  research, and more — lightweight agents that get a workspace, skills, and any
  MCP tools you wire up, with no git infrastructure.

- **GitHub integration with a merge orchestrator.** A webhook-driven PR workflow
  routes reviews, comments, CI results, and pushes to the right task, and merges
  pull requests automatically once they're ready. Force pushes are disallowed
  and pushing is blocked from agent Bash.

- **Human approval gate for any change.** Agents cannot modify code until a
  human approves edit mode via Slack buttons — the read-only-to-edit transition
  is an explicit, auditable step.

- **OS-level sandbox with defense-in-depth.** Each agent runs under per-agent
  filesystem isolation (bubblewrap on Linux, sandbox-exec on macOS), a
  network deny-all from agent Bash, and tool denylists — so a misbehaving or
  prompt-injected agent stays contained.

- **Web research pipeline.** Multi-agent web research with structured output and
  prompt-injection defenses, bounded by per-task budgets.

- **Per-task isolation and recovery.** Every task is its own runtime with
  isolated message queues, task-scoped budgets (research requests, inter-agent
  messages, wall-clock timeout), and metadata plus the knowledge log persisted
  to disk. Tasks recover automatically after a restart.

- **Persistent memory (optional, behind `ARCHIE_MEMORY`).** A cross-task memory
  layer so agents "arrive informed" instead of starting cold each time — user
  preferences, a rolling activity index, per-task summaries, and a graph of
  entity pages for the systems and concepts the work keeps touching. Plain
  Markdown, no database, removable as a single unit.

- **Encrypted secrets and OAuth.** External integrations connect via an OAuth
  flow, with tokens stored in an encrypted vault validated by a master key at
  startup.

- **Runs without Slack or GitHub.** A bundled example plugin set and an
  interactive CLI make a fresh clone runnable with only an Anthropic API key;
  Slack and GitHub are optional integrations.

- **Deployment and CI.** Docker Compose for dev and prod, an image published to
  GitHub Container Registry on every `main` build, and CI that runs typecheck,
  build, tests, a gitleaks secret scan, and CodeQL analysis.

[Unreleased]: https://github.com/sweatco/archie-hq/commits/main
