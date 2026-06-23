# Writing Plugins

This guide shows you how to author your own plugin for Archie — adding a whole new domain (agents, the knowledge they work from, and the workflows the PM uses to orchestrate them) without touching the engine's source code.

## Mental model

The engine is **generic**. On its own, Archie knows how to spin up a PM agent and specialist agents, route Slack/CLI messages, let agents talk to each other, manage git worktrees and PRs, and load skills on demand. It does **not** know anything about your domain.

All domain behavior comes from **plugins**. A plugin is just a directory of Markdown and JSON files that the engine discovers at startup. It teaches Archie:

- **Who the specialists are** — agent definitions (`agents/*.md`).
- **What they know** — skills the agents load on demand (`skills/*/SKILL.md`).
- **How the PM should run a kind of request** — PM orchestration skills (`pm/skills/*/SKILL.md`), plus standing context for the PM (`pm/agents/pm.md`).

Adding a domain is therefore an authoring task, not a coding task: write some files, point the engine at them, and the new capability shows up. No core changes, no rebuild.

The repo ships a working example set under [`examples/plugins/`](../../examples/plugins/):

- `helper/` — a one-agent domain plugin (an `assistant-agent` plus a `structured-summary` skill).
- `pm/` — the PM extension (a minimal overlay prompt plus an `example-task` orchestration skill).

The fastest way to start is to copy `examples/plugins/helper/` and adapt it. Everything below explains what each piece does so you can do that confidently.

## Directory structure

A plugins root holds one directory per plugin, plus a shared MCP config:

```
plugins/
├── .mcp.json                       # MCP servers shared across all agents
├── <plugin-name>/
│   ├── .claude-plugin/
│   │   └── plugin.json             # required manifest: name, version, description
│   ├── agents/
│   │   └── <agent-name>.md         # one file per agent
│   └── skills/
│       └── <skill-name>/
│           └── SKILL.md            # domain knowledge an agent loads on demand
└── pm/                             # special plugin that extends the PM
    ├── .claude-plugin/
    │   └── plugin.json
    ├── agents/
    │   └── pm.md                   # overlay appended to the PM's system prompt
    └── skills/
        └── <flow-name>/
            └── SKILL.md            # PM orchestration skill (how to run a request)
```

Naming conventions:

- **Plugin directory**: lowercase, no spaces (e.g. `marketing`, `customer-support`).
- **Agent file → agent id**: `agents/copywriter.md` becomes the agent id `copywriter-agent`. The id must be unique across **all** plugins.
- **Skill name**: the directory name. `skills/tone-of-voice/SKILL.md` is the skill `tone-of-voice`.

### `plugin.json`

Every plugin (including `pm/`) needs `.claude-plugin/plugin.json`:

```json
{
  "name": "helper",
  "version": "1.0.0",
  "description": "Example domain plugin — a generic assistant agent that summarizes text and drafts short responses."
}
```

### The `pm/` plugin

The PM is built by the engine; you don't define it from scratch. Instead the `pm/` plugin **extends** it:

- `pm/agents/pm.md` — an overlay whose contents are appended to the PM's system prompt. Put standing context here: what your team/org does, who the regular requesters are, house style for replies, and defaults that should hold across every conversation.
- `pm/skills/<flow>/SKILL.md` — orchestration skills the PM loads when it recognizes a kind of request.

### `.mcp.json` and opting in

A single root `.mcp.json` declares any [MCP](https://modelcontextprotocol.io/) servers available to agents. The shipped example is empty (`{ "mcpServers": {} }`) because the quickstart needs no external integrations. When you add servers, give each one a short `description` — the PM uses it to decide which teammate can reach which external system.

```json
{
  "mcpServers": {
    "tracker": {
      "description": "Issue tracker — read and update tickets.",
      "type": "http",
      "url": "https://example.invalid/mcp"
    }
  }
}
```

An agent opts into a server by listing it in frontmatter:

```yaml
mcpServers:
  - tracker
```

## Agent definition files

Each `agents/<name>.md` defines one agent: YAML frontmatter plus a Markdown body.

```markdown
---
role: General assistant. Summarizes text, drafts short responses, and answers general questions.
expertise: Summarization, drafting, general writing, plain-language explanation
---

# Assistant Agent

You are a general-purpose assistant...
```

Frontmatter fields:

| Field | Required | Purpose |
| --- | --- | --- |
| `role` | Yes | Short role title. The PM sees this when deciding who to delegate to. |
| `expertise` | Yes | Comma-separated areas. Shown to peers so they know what this agent can do. |
| `model` | No | Model override (otherwise the engine default applies). |
| `mcpServers` | No | List of MCP server names from the root `.mcp.json` this agent may use. |
| `metadata.archie.repo` | Repo agents only | Declares a GitHub repo — see below. |

### Plugin agents vs repo agents

- **Plugin (generic) agents** omit `metadata.archie.repo`. They are **read-only by default** — they read files, search, load skills, and talk to other agents. Use these for domains that don't need git: writing, support, research, analytics, and so on.
- **Repo agents** add `metadata.archie.repo` with `github` and `baseBranch`. The presence of this field puts the agent on the git/GitHub track: it gets write/edit tools and git commands **only after edit mode is approved**, and can open PRs.

```yaml
---
role: Senior backend engineer. Expert in APIs, databases, and authentication.
expertise: APIs, databases, business logic
metadata:
  archie:
    repo:
      github: <your-org>/<your-repo>
      baseBranch: main
---
```

### Three-layer prompt composition

When an agent is spawned, its system prompt is assembled from three layers:

1. **Universal protocol** — identity, who its peers are, how agents communicate and coordinate, when to stop. Provided by the engine.
2. **Track capabilities** — read-only mode (plugin agents) or git/edit-mode mechanics (repo agents), and the tools available. Provided by the engine based on the agent's track.
3. **Your agent body** — the Markdown you write below the frontmatter.

Because layers 1 and 2 are supplied for you, **the body should contain only domain instructions**:

- What this agent does and its scope.
- Which skills to load and when (e.g. "before producing a summary, load the `structured-summary` skill").
- How it coordinates with peer agents in the same plugin.
- Quality standards and stopping points (when to report back and wait).

Do **not** restate the multi-agent protocol, describe read-only mode, or list tools — those come from layers 1 and 2. Keep task-specific templates and rules out of the body too; those belong in skills.

Agents are **headless**: they don't talk to the end user. They produce a clean result and hand it back to the requesting agent (usually the PM).

## Skills

Skills are on-demand knowledge. An agent or the PM loads a skill when it's relevant, rather than carrying everything in its prompt.

### Agent skills (`<plugin>/skills/`)

Hold the domain knowledge, templates, and rules a specialist needs to do the work: output formats, style guides, glossaries, checklists, worked examples.

```markdown
---
description: Output format for summaries. Load before producing any summary so the result is consistent and skimmable.
---

# Structured Summary

When asked to summarize text, produce this format:

**TL;DR** — one sentence capturing the single most important point.

**Key points**
- 3–6 bullets, each a complete, standalone thought.
...
```

### PM skills (`pm/skills/`)

Teach the PM **how to orchestrate** a kind of request. A good PM skill covers:

- **Intake** — what to collect from the requester before delegating.
- **Delegate** — which agent to hand the work to, and what to tell it.
- **Deliver** — how to present the result back, and how to handle revisions.

```markdown
---
name: example-task
description: Summarize or draft workflow. Use when someone asks to summarize a piece of text, condense a document, draft a short reply, or "TL;DR this".
---

You are handling a summarize-or-draft request.

### Intake
Before delegating, make sure you have the source text and what they want done with it.

### Delegate
Hand the work to **assistant-agent**...

### Deliver
When the assistant returns its result, present it cleanly to the requester...
```

### Skill design principles

- **Self-contained.** Embed the reference material directly. The agent can't browse your wiki or open links it doesn't have access to, so don't link to docs it can't reach.
- **Plain language, not tool calls.** Describe *what to achieve* and *what judgement to apply*. The agent already knows how to delegate, request edit mode, open PRs, or post to Slack — don't hardcode tool syntax or script those generic steps. Concrete product facts (formats, character limits, named values) are fine and encouraged.
- **One concern per skill.** Keep reusable reference knowledge (e.g. a style guide) separate from task-specific templates, so multiple agents and workflows can compose them.
- **The `description` is the trigger.** It's what the PM (for PM skills) or the agent (for agent skills) sees when deciding whether to load the skill. Make it specific and include the words a requester would actually use.

## A minimal worked example

This mirrors the shipped `examples/plugins/helper/` + `pm/` set. Create the following under your plugins root:

```
plugins/
├── .mcp.json
├── helper/
│   ├── .claude-plugin/plugin.json
│   ├── agents/assistant.md
│   └── skills/structured-summary/SKILL.md
└── pm/
    ├── .claude-plugin/plugin.json
    ├── agents/pm.md
    └── skills/example-task/SKILL.md
```

**`plugins/.mcp.json`**

```json
{ "mcpServers": {} }
```

**`plugins/helper/.claude-plugin/plugin.json`**

```json
{
  "name": "helper",
  "version": "1.0.0",
  "description": "A generic assistant agent that summarizes text and drafts short responses."
}
```

**`plugins/helper/agents/assistant.md`** (becomes `assistant-agent`)

```markdown
---
role: General assistant. Summarizes text, drafts short responses, and answers general questions.
expertise: Summarization, drafting, general writing, plain-language explanation
---

# Assistant Agent

You handle small, self-contained requests: summarizing text, drafting a short reply,
or explaining something plainly.

## How You Work
1. **Load your skill first** — before producing a summary, load the `structured-summary`
   skill. It defines the output format to follow.
2. **Do the work** — read whatever the requester gave you, then produce the result.
3. **Report back** — hand a clean, ready-to-send result to the requesting agent. You are
   headless and don't talk to the end user directly.

## Stopping Points
Stop and wait after:
1. Reporting your result to the requesting agent.
2. When the request is ambiguous — ask one clarifying question, then stop.
```

**`plugins/helper/skills/structured-summary/SKILL.md`**

```markdown
---
description: Output format for summaries. Load before producing any summary so the result is consistent and skimmable.
---

# Structured Summary

**TL;DR** — one sentence capturing the single most important point.

**Key points**
- 3–6 bullets, each a complete, standalone thought, ordered by importance.
- Faithful to the source — never add facts that aren't present.

**Open questions / caveats** (only if any).

## Rules
- Keep the whole summary shorter than the input.
- Plain language; expand acronyms on first use.
- Never fabricate.
```

**`plugins/pm/.claude-plugin/plugin.json`**

```json
{
  "name": "pm",
  "version": "1.0.0",
  "description": "PM extension — orchestration skill and overlay context."
}
```

**`plugins/pm/agents/pm.md`** (overlay context — keep it short)

```markdown
# Business Context

You are the front door to a small team whose specialist is the **assistant-agent**
(summaries and short drafts). Keep replies friendly and concise.
```

**`plugins/pm/skills/example-task/SKILL.md`**

```markdown
---
name: example-task
description: Summarize or draft workflow. Use when someone asks to summarize text, condense a document, draft a short reply, or "TL;DR this".
---

You are handling a summarize-or-draft request.

### Intake
Make sure you have the source text and what they want done with it. If the text is
missing, ask for it before going further.

### Delegate
Hand the work to **assistant-agent**. Give it the full source text and state plainly
what you want back. It owns producing the result; you own the conversation.

### Deliver
When the assistant returns, present the result cleanly. If they ask for changes, relay
the specifics and return the revised version.
```

### Run it

You have two ways to point the engine at your plugins:

- **Use the bundled examples** — `npm run example:setup` symlinks `examples/plugins/` into `workdir/plugins/`. Edit them in place to experiment.
- **Use your own** — set `ARCHIE_PLUGINS` to your plugins git URL (the engine clones it on startup), or place/symlink your plugins under `workdir/plugins/` directly.

Then, with `ANTHROPIC_API_KEY` set in `.env` (copied from `.env.example`):

```bash
npm install
npm run example:setup     # or point ARCHIE_PLUGINS / workdir/plugins at your own plugins
npm run dev               # start the engine
```

In a second terminal, open the interactive terminal UI and talk to the PM:

```bash
npm run cli
```

Ask it to "summarize this: …" and watch the PM load `example-task`, delegate to `assistant-agent`, and return a structured summary. Slack and GitHub are optional integrations — you don't need either to run locally.

## Checklist

Before considering your plugin done:

- [ ] `.claude-plugin/plugin.json` exists with `name`, `version`, `description`.
- [ ] Each agent has valid frontmatter (`role`, `expertise`; `metadata.archie.repo` for repo agents).
- [ ] Each agent id (derived from filename) is unique across all plugins.
- [ ] Every skill an agent references actually exists and its `description` makes it discoverable.
- [ ] A PM-facing skill exists in `pm/skills/` so the PM can recognize the request and route to your agent.
- [ ] Skills are self-contained — no links to docs the agent can't reach.
- [ ] Agent bodies hold only domain instructions, which skills to load, coordination, and stopping points (no protocol/tool boilerplate).
- [ ] Any MCP servers an agent uses are declared in the root `.mcp.json` and listed in the agent's `mcpServers`.
