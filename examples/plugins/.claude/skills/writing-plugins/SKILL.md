---
name: writing-plugins
description: >
  Read this before authoring or substantially changing a plugin, agent, or skill
  for Archie. It's the conceptual playbook for building plugins that fit Archie's
  multi-agent, single-orchestrator model — what a plugin must respect, why every
  plugin usually needs an orchestrator-facing skill, and how to think about agents
  vs skills vs PM skills. Triggers on "write a plugin", "add an agent", "add a
  skill", "create a new domain", "make a new teammate". This is the "how to think
  about it" layer; the README's Plugins section and docs/architecture/plugin-system.md
  are the "how to wire it up" layer.
---

# Writing Plugins for Archie

The README's **Plugins** section and `docs/architecture/plugin-system.md` document the mechanics: directory layout, frontmatter fields, how an agent's prompt is composed, the new-plugin checklist. **Read those for the how.** This playbook is the *why* — the design principles that make a plugin actually work inside Archie, which are easy to miss if you only follow the mechanical steps.

This skill ships inside the example plugin set (`examples/plugins/`) so it travels with a copyable, runnable example — and it is itself an example of the `SKILL.md` format.

## The one thing to internalize: there is a single orchestrator

Archie is a multi-agent system with exactly **one user-facing agent: the PM** (the "Archie" persona the user talks to, over Slack or the CLI). Every other agent is **headless** — it has no user-messaging tools, never talks to the user, and never sees the conversation directly. A specialist agent receives a brief from the PM, does its work, and **hands content back to the PM**, which delivers it.

Everything you build has to respect this. The most common way a new plugin fails is by assuming its agent can talk to the user. It can't.

**Study the bundled `helper/` + `pm/` example as the reference implementation.** The `assistant-agent`:
- has no user-messaging tools — it produces a result *body* and hands it to the PM, which delivers it;
- references people and destinations by plain name and lets the PM resolve them at delivery time;
- has clear stopping points ("report back to the requesting agent, then stop").

Its PM-side counterpart (`pm/skills/example-task/SKILL.md`) owns the user conversation. That division — specialist produces, PM delivers — is the pattern to copy.

## What a well-formed plugin respects

1. **The hand-off pattern.** The agent returns content for the PM to deliver; it never assumes user access. Don't give a specialist user-messaging tools or tell it to "post to the user".
2. **An orchestrator-facing route.** The PM only knows how to use a new agent if there's a path to it. Usually that means a **PM skill** in `pm/skills/` that tells the PM when to route to your agent, what to collect first (intake), how to brief it, and how to present the result. Without this, your agent is unreachable — the PM won't invent a workflow for it.
   - **The exception: self-explanatory agents.** If the agent's `role`/`expertise` plus its self-describing MCP tools are enough for the PM to route a request and relay the answer (e.g. "ask the agent that can reach system X"), a dedicated PM skill may be unnecessary. Decide deliberately: if using the agent well requires *any* multi-step intake, sequencing, confirmation, or delivery shaping, it needs a PM skill. When in doubt, write one.
3. **Clear stopping points.** Every agent must know when to stop and hand back. Headless agents that keep working break the turn model. State the stopping points in the agent body.
4. **Discoverable integrations.** If the agent reaches an external system via MCP, give that server a clear one-line `description` in `.mcp.json`. The PM is shown these descriptions and uses them to route ("check the issue tracker" → the agent whose line lists it). A cryptic or missing description means the PM can't route to it.
5. **The right home for each piece of knowledge.** Identity and "which skills to load when" go in the **agent body**. Reusable craft, templates, reference data, and rules go in **agent skills**. Orchestration — intake, delegation, delivery — goes in **PM skills**. Don't put task detail in the agent body; don't put orchestration in an agent skill.
6. **Teach concepts, not mechanics.** Write so a non-developer could follow the skill end to end: say *what* to achieve and *what judgement to apply*, and trust the agent with its own tools and standard flows (delegating, edit mode, PRs, posting to the user). Don't name specific tools, hardcode call syntax, script those generic steps, or bake in harness internals (session ids, log files, symlinks, env vars, "auto-loaded into context") — they go stale and bury the intent. Domain procedure (what to check, which fields, what order for the work) is fair game; the tool and harness plumbing isn't. A specialist skill describes the **result to produce** (it's headless and hands content to the PM); a PM skill teaches routing and judgement. Keep concrete product facts (names, IDs, formats, character limits).

## Generic vs repo agents — pick the track

- **Generic (plugin) agent** (no `metadata.archie.repo[s]`): read-only, no git. For domains that reason over data, draft content, or query MCP systems — marketing, analytics, ops, support, research.
- **Repo agent** (`metadata.archie.repos: [...]`): gets git worktrees, branches, and PRs in edit mode. For work that changes code. An agent can mount **more than one repo** (list several under `repos`, mark one `primary`) when its work naturally spans related repositories.

The README's Plugins section has the exact frontmatter for each.

## A sane authoring order

1. **Decide the domain and the track** (generic vs repo). One plugin = one domain.
2. **Write the agent(s)** — frontmatter (`role`, `expertise`, optional `model`, repo metadata, `mcpServers`) plus a body that covers identity, which skills to load and when, coordination with peers, and stopping points. Keep it about *who the agent is*, not task detail.
3. **Write the agent skills** — the craft, templates, and reference material the agent loads on demand. Embed full reference content; the agent can't browse external docs.
4. **Write the PM orchestration skill** (`pm/skills/<name>/`) — unless the agent is genuinely self-explanatory. This is what makes the agent reachable. Give it a `description` rich with the trigger phrases the PM will match against.
5. **Wire MCP** — list servers in the agent's `mcpServers`; make sure each has a clear `description` in `.mcp.json`.
6. **Validate** — frontmatter parses; agent IDs are unique across *all* plugins (`<filename>-agent`); every referenced skill/file exists; there's a PM-facing route (or a deliberate self-explanatory decision).

## Common mistakes to avoid

- An agent that "posts to the user" or assumes it can see the conversation. (It's headless.)
- A new agent with no PM skill and no self-explanatory route — unreachable.
- Orchestration logic stuffed into the agent body, or task templates stuffed into the agent body instead of a skill.
- MCP servers with no `description` — the PM can't route to them.
- Hardcoded tool-call syntax inside skills instead of plain-language instructions.
- A duplicate agent ID (collision across plugins fails the registry at startup).

When the mechanics are unclear, go back to the README's Plugins section and `docs/architecture/plugin-system.md`. When the *design* is unclear, re-read how the `helper`/`pm` example splits work between its agent and its PM skill — that split is the heart of writing a plugin that fits Archie.
