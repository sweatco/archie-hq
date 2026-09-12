---
name: writing-plugins
description: >
  Read this before authoring or substantially changing a plugin, skill, or agent
  for Archie. It's the conceptual playbook for building plugins that fit Archie's
  one-agent-per-task model — what a plugin contributes, when a skill is the right
  answer (almost always), and the narrow cases where a worker earns a definition
  file. Triggers on "write a plugin", "add a skill", "add an agent", "create a new
  domain". This is the "how to think about it" layer; the README's Plugins section
  and docs/architecture/plugin-system.md are the "how to wire it up" layer.
---

# Writing Plugins for Archie

The README's **Plugins** section and `docs/architecture/plugin-system.md` document the mechanics: directory layout, frontmatter fields, the root config files, the new-plugin checklist. **Read those for the how.** This playbook is the *why* — the design principles that make a plugin work inside Archie, which are easy to miss if you only follow the mechanical steps.

This skill ships inside the example plugin set (`examples/plugins/`) so it travels with a copyable, runnable example — and it is itself an example of the `SKILL.md` format.

## The one thing to internalize: a task is one agent

A task runs exactly **one agent: the PM** — the "Archie" the user talks to in Slack or the CLI. It loads skills into its own context and does most work itself. When work is bulky, needs a fixed output envelope, or must be blind to the material that produced it, the PM spawns a **worker** and reads the report that comes back. A worker cannot reach the user, cannot see the conversation, and cannot message another worker. Its brief is everything it gets, and its final report is the only thing that reaches the PM.

A plugin contributes exactly two things: **skills** (`skills/<name>/SKILL.md`, loadable as `plugin:skill`) and **agents** (`agents/<name>.md`, spawnable as `plugin:agent`). Both are loaded natively by the Claude Agent SDK. There is no PM-only or specialist-only skill set — every skill is PM-loadable, and the PM decides whether to run the procedure inline or hand the heavy part to a worker.

One root-level file sits outside any plugin's own directory and is engine-owned rather than plugin-contributed: `pm.md` at the plugins repo root. It carries standing organisational context appended to the PM's system prompt and sets the PM's default model and effort — see the PM overlay section in `docs/architecture/plugin-system.md`.

**Study the bundled `helper/` plugin as the reference implementation.** `helper:example-task` is the workflow the PM runs: intake, the judgement call about whether the material is bulky enough to delegate, and delivery. `helper:structured-summary` is the output format, loadable by either side. `helper:assistant` is the worker, and it exists only because a generic spawn cannot preload a skill or set `effort`.

## Skill first, agent only with a reason

Most domains need **no agent file at all**. Write one only when you can name which of these applies:

- **Discipline** — a fixed procedure and output envelope matter enough to bake into a prompt (an analyst whose report must be re-runnable months later).
- **Blindness** — a reviewer must not see the material that generated what it reviews.
- **A setting only a definition can carry** — a `model`/`effort` pairing the PM cannot express per spawn (a per-spawn `Agent` call takes a model but not an effort), a `disallowedTools` list, or preloaded `skills`.

If you cannot name the reason, write a skill. A prompt plus a tool grant is not a role.

### Agent frontmatter

Only these keys: `name`, `description`, `model`, `effort`, `disallowedTools`, `skills`, `memory`. Anything else is ignored by the SDK or a leftover from the old multi-agent model — `role`, `expertise`, `mcpServers`, `allowedNetworkDomains` and the `metadata.archie` repo binding are all gone. MCP servers are declared once in the root `.mcp.json` and attach to the whole session, so a worker sees every integration the deployment has; `disallowedTools` is the only per-agent narrowing, and a typo in it silently grants access.

The `description` has to absorb what `role` and `expertise` used to carry, because it is the only thing the PM reads when choosing a worker. Write it as: what this does, when to spawn it, what to put in the brief.

Keep the body short — identity, what it must not touch, which skills to load, and the shape of the result it returns.

## What a well-formed plugin respects

1. **The brief is the whole world.** A worker cannot ask a follow-up question, see the thread, or read a file it was not pointed at. If a step needs the requester's input, it belongs in a skill the PM runs, before the spawn.
2. **The report is the only thing that survives.** Everything the worker read stays in its context — which is exactly why you delegate. Say in the skill what the report must contain.
3. **Delegation is phrased three ways, and no others.** "Do it yourself", "spawn `plugin:agent` with …", "hand it to a worker (sonnet) with this skill's name and the inputs". No task owner, no messaging another agent, no shared log, no waiting for a peer. A review loop is: spawn the reviewer, read the verdict, revise, spawn again.
4. **Discoverable integrations.** Give every MCP server a clear one-line `description` in the root `.mcp.json`, and put calls that change production state behind an `ask` tier there. The PM is shown those descriptions and uses them to route.
5. **The right home for each piece of knowledge.** Reusable craft, reference data, procedures and output formats go in **skills**. Identity and boundaries go in an **agent body**, if an agent exists at all. Nothing domain-shaped belongs in the engine.
6. **Teach concepts, not mechanics.** Write so a non-developer could follow it: say *what* to achieve and *what judgement to apply*. Don't hardcode tool-call syntax or harness internals (session ids, log files, env vars) — they go stale and bury the intent. Domain procedure is fair game; plumbing is not. Keep concrete product facts (names, IDs, formats, character limits).
7. **Two workers must never share one repository clone.** The brief is what keeps them apart — nothing enforces it.

## A sane authoring order

1. **Decide the domain.** One plugin = one domain. Create `<plugin>/.claude-plugin/plugin.json` with `name`, `version` and `description`.
2. **Write the skills** — the craft, the procedure, the reference material. Embed the reference content; the reader cannot browse external docs. Give each a `description` rich with the trigger phrases the PM will match against, and say in it when a step is heavy enough to be worth a worker.
3. **Write an agent only if you named a reason** — frontmatter from the allowed keys, plus a short body.
4. **Wire MCP in the root `.mcp.json`** — one entry per server, with a `description` and, where a call writes to production, an `archie` `ask` or `deny` tier. Per-plugin `.mcp.json` files are not connected.
5. **Validate** — frontmatter parses; skill names are unique within the plugin (across plugins they cannot collide, the SDK namespaces them); every referenced skill and file exists; the plugin directory carries its manifest.

## Common mistakes to avoid

- A skill that assumes its reader can post to Slack when a worker is the one running it — or a worker body that tries to "report to the PM and wait". Returning is the reporting.
- An agent file with no stated reason to exist. That is a skill.
- Old-model vocabulary in prose: a task owner, `send_message_to_agent`, a knowledge log, sharing artifacts between agents, "you are headless".
- A repo binding in frontmatter. There is none: the GitHub App installation is the allowlist and the PM mounts what a task needs.
- MCP servers with no `description`, or production writes with no approval tier.
- Hardcoded tool-call syntax inside skills instead of plain-language instructions.

When the mechanics are unclear, go back to the README's Plugins section and `docs/architecture/plugin-system.md`. When the *design* is unclear, re-read how `helper/` splits the same job between a skill the PM runs and a worker it can hand the bulk to.
