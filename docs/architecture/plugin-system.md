# Plugin System Architecture

Archie uses a plugin-based architecture to define agents and their capabilities. The plugin system supports two tracks of agents -- **repo agents** (engineering, tied to Git repositories) and **plugin agents** (generic domains, read-only) -- unified through a single plugin loader that scans at startup.

Plugins are not bundled with the source tree. At startup, `bootstrapWorkdir()` clones the git repository pointed to by `ARCHIE_PLUGINS` (optionally pinned by `ARCHIE_PLUGINS_BRANCH`) into `$ARCHIE_WORKDIR/plugins/`. The repo is then kept current on demand rather than on a timer: every task start/load runs `syncPlugins()` (`src/system/plugin-sync.ts`), which calls `refreshPlugins()` (`src/system/workdir.ts`) to do a lightweight `git ls-remote` HEAD check against the configured branch. If the remote tip hasn't moved nothing happens; if it has, Archie fetches, hard-resets onto it, re-scans plugin definitions, and rebuilds the agent registry — so a push to the plugins repo is picked up on the very next request. For local development, `$ARCHIE_WORKDIR/plugins/` may be a symlink to a checkout, in which case Archie skips git management and just re-scans from disk. An in-flight task is never disturbed — it keeps the team it was created with. A task that was stopped/completed picks up the change when it is pinged again (it reloads from disk through `Task.get()`, which syncs and scans a fresh team), as does any task after a process restart.

The PM agent's context includes a "Plugins repo last updated" line — the committer date, short SHA, and subject of the current plugins HEAD (`getPluginsHeadInfo()` in `src/system/workdir.ts`) — so users in Slack can ask when the plugins/agents were last updated and cross-check against the repo.

**Source:** `src/system/workdir.ts`, `src/system/plugin-loader.ts`

## Two-Track Agent Architecture

### Repo Agent Track (Engineering)

Repo agents are tied to a specific Git repository and have access to git infrastructure (shared clones, branches, PRs via `repo-tools` MCP server). They operate in either read-only or edit mode depending on task state.

- Identified by `metadata.archie.repo` in their markdown frontmatter (or legacy `repo-config.json`)
- Each `agents/*.md` file with repo metadata becomes an agent (e.g., `backend.md` becomes `backend-agent`)
- Infrastructure config (GitHub repo, base branch) comes from frontmatter `metadata.archie.repo`
- Agent identity and domain instructions come from the frontmatter and markdown body

**Source:** `src/agents/spawn.ts`, `src/agents/registry.ts`, `src/types/agent.ts`

### Plugin Agent Track (Generic Domains)

Plugin agents are lightweight, read-only agents for domains that do not need git or GitHub infrastructure. They are suited for roles like copywriting, design review, QA analysis, or any non-engineering specialization.

- Defined by `agents/*.md` files whose frontmatter does **not** contain `metadata.archie.repo.github`
- Each `.md` file becomes an agent (e.g., `agents/copywriter.md` becomes `copywriter-agent`)
- Agent identity, expertise, and optional model override come from frontmatter
- Domain-specific instructions come from the markdown body
- Built-in tools: `Read`, `Glob`, `Grep`, `Skill`, `send_message_to_agent` (via `repo-agent-tools`), `log_finding` (via `repo-agent-tools`), `web_research` (via `research-tools`)
- Read-only enforcement comes from the spawn-time sandbox (the agent workspace is the only writable path) — plugin agents are NOT issued the `repo-tools` MCP server or any git/GitHub plumbing
- Plugin agents may still opt into MCP servers via frontmatter `mcpServers` (resolved against the root `.mcp.json`), so they are not strictly limited to the built-in tool set

**Source:** `src/agents/spawn.ts`, `src/agents/registry.ts`, `src/types/agent.ts`

## Plugin Directory Structure

Each plugin is a subdirectory inside the runtime plugins directory at `$ARCHIE_WORKDIR/plugins/` (cloned from `ARCHIE_PLUGINS` at startup; there is no top-level `plugins/` folder in this repository). Every plugin **must** have a `.claude-plugin/plugin.json` manifest to be loaded. The structure follows standard Claude Code conventions with Archie-specific extensions:

```
plugins/
  engineering/                    # Repo plugin (agents with repo frontmatter)
    .claude-plugin/
      plugin.json                 # Required: { name, version, description }
    repo-config.json              # Legacy infrastructure configs (optional)
    agents/
      backend.md                  # Agent prompt (frontmatter with repo metadata + body)
      mobile.md
    skills/                       # Agent craft skills (symlinked into agent workspaces)
      debugging/
        SKILL.md
    hooks/
      hooks.json                  # Plugin-defined hooks (injected into agent settings)

  marketing/                      # Generic plugin (no repo metadata in frontmatter)
    .claude-plugin/
      plugin.json                 # Required manifest
    agents/
      copywriter.md               # Becomes copywriter-agent
      brand-strategist.md         # Becomes brand-strategist-agent
    skills/
      tone-analysis/
        SKILL.md

  pm/                             # Special PM overlay plugin
    .claude-plugin/
      plugin.json
    agents/
      pm.md                       # Body appended to PM prompt; frontmatter configures MCP/tools
```

An agent is classified as a **repo agent** if its frontmatter contains `metadata.archie.repos` (or the legacy singular `metadata.archie.repo`). Otherwise it is a **plugin agent**. (The legacy `repo-config.json` file is still parsed and exposed on `LoadedPlugin.repoConfigs` for backward compatibility, but the live registry in `src/agents/registry.ts` derives every repo agent from frontmatter — `repo-config.json` is no longer the source of truth for cloning or agent registration.)

### Plugin Manifest (`plugin.json`)

Every plugin directory must contain `.claude-plugin/plugin.json` with at least:

```json
{
  "name": "engineering",
  "version": "1.0.0",
  "description": "Engineering agents for backend and mobile repositories"
}
```

Directories without a valid manifest are silently skipped during scanning.

### Plugin Hooks (`hooks/hooks.json`)

Plugins can define hooks that are injected into agent workspace settings. The `hooks.json` file follows the Claude Code settings hooks format. The `${CLAUDE_PLUGIN_ROOT}` placeholder is substituted with the actual plugin directory path at load time.

### PM Overlay Plugin

A plugin named `pm` is treated specially. Its `agents/pm.md` file provides:
- **Body**: Appended to the PM agent's system prompt (for business context, team-specific instructions)
- **Frontmatter `mcpServers`**: Additional MCP server names the PM should have access to
- **Frontmatter `tools`/`disallowedTools`**: Additional tool permissions for the PM

### Root MCP Config

A single `.mcp.json` file at the plugins directory root (`$ARCHIE_WORKDIR/plugins/.mcp.json`) provides MCP server connection configs. Individual agents reference server names from this file via their frontmatter `mcpServers: [...]` field. Environment variables matching `${MCP_*}` are substituted at load time.

## Plugin Loader

The plugin loader (`src/system/plugin-loader.ts`) runs once at startup using synchronous filesystem reads. It scans every subdirectory of `PLUGINS_DIR` and produces a `LoadedPlugin[]` array consumed by downstream modules.

### Bootstrap Order (`src/index.ts`)

1. `bootstrapWorkdir()` — clones/pulls the plugins repo from `ARCHIE_PLUGINS` into `$ARCHIE_WORKDIR/plugins/`
2. `initPlugins()` — scans `PLUGINS_DIR` and populates the in-memory `LoadedPlugin[]`
3. `initRegistry()` — flattens loaded plugins into `AgentDef[]` (PM + repo + plugin agents) with collision detection
4. `cloneRepos()` — clones each repo declared by a registered repo agent's frontmatter (`metadata.archie.repo.github`) into `$ARCHIE_WORKDIR/repos/{key}`

### Startup Scanning Process

1. Read all entries in `PLUGINS_DIR` (at `$ARCHIE_WORKDIR/plugins/`); dotfile entries are skipped
2. For each subdirectory:
   - **Require** `.claude-plugin/plugin.json` with `name`, `version`, `description` -- skip if missing or invalid
   - Check for `repo-config.json` and parse it if present (legacy support; not used to register agents)
   - Scan `agents/*.md` for all agent definitions, parsing frontmatter with `gray-matter`
   - If frontmatter contains `metadata.archie.repo.github`, the agent is classified as a repo agent
   - Check for `skills/` directory and record its absolute path
   - Check for `hooks/hooks.json` and parse if present (with `${CLAUDE_PLUGIN_ROOT}` substitution)
3. Return the array of `LoadedPlugin` objects

```typescript
// From src/system/plugin-loader.ts
export interface LoadedPlugin {
  name: string;                                          // Plugin name (from manifest)
  dir: string;                                           // Absolute path
  manifest: PluginManifest;                              // Parsed plugin.json
  repoConfigs: Record<string, PluginRepoConfig> | null;  // Legacy repo-config.json
  agents: PluginAgentDef[];                              // All agents (repo + plugin track)
  skillsPath: string | null;                             // Absolute path to skills/ if exists
  hooks: Record<string, any> | null;                     // Parsed hooks/hooks.json
}
```

### Agent Markdown Parsing (gray-matter)

Agent definition files use YAML frontmatter parsed by the `gray-matter` library:

```markdown
---
role: Senior backend engineer
expertise: Ruby on Rails, PostgreSQL, API design
model: sonnet
metadata:
  archie:
    repo:
      github: org/backend-repo
      baseBranch: main
mcpServers:
  - teamcity
  - bugsnag
tools:
  - "mcp__teamcity__*"
disallowedTools:
  - WebSearch
---

## Domain Instructions

You specialize in the backend service...
```

Fields:
- **`role`** (string): Short role description, used in peer agent lists
- **`expertise`** (string): Detailed expertise description, used in the agent's own prompt
- **`model`** (string, optional): Model override. Defaults applied at spawn time in `src/agents/spawn.ts`: `opus` for the PM track, `sonnet` for repo and plugin tracks
- **`effort`** (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`, optional): Reasoning effort level passed to the SDK
- **`maxTurns`** (number, optional): Cap on agentic turns per query (defaults to 100)
- **`metadata.archie.repo`** (object, optional): If present with a `github` field, classifies the agent as a repo agent with `github` (repo identifier) and optional `baseBranch`
- **`mcpServers`** (string[], optional): MCP server names from the root `.mcp.json` that this agent should have access to
- **`tools`** (string[], optional): Tool allowlist. When omitted, the SDK runs with `bypassPermissions` and all built-in/MCP tools are available; when set, it restricts the agent to exactly the listed entries (so MCP wildcards must be added explicitly)
- **`disallowedTools`** (string[], optional): Tool denylist (always applied on top of the allowlist)

The markdown body (everything after the frontmatter) becomes the Layer 3 domain-specific prompt.

## Repo Agent Configuration

Repo agents declare one or more GitHub repositories in their frontmatter. The preferred shape is the plural `metadata.archie.repos: [...]` plus an optional `primary` selector:

```markdown
---
role: Senior backend engineer
expertise: Ruby on Rails, PostgreSQL
metadata:
  archie:
    repos:
      - github: org/backend-repo
        baseBranch: main
      - github: org/shared-libs
        baseBranch: main
    primary: org/backend-repo   # optional; defaults to repos[0].github
---
```

- Every entry in `repos` is mounted at spawn (eager — there is no runtime attach).
- `primary` is the default target for `repo-tools` when their `github` arg is omitted. If omitted, the first entry is used. If set, must match exactly one entry's `github`.
- The legacy singular shape (`metadata.archie.repo: { github, baseBranch }`) is still accepted — the plugin loader auto-migrates it to the plural form: `repos: [{github, baseBranch}], primary: github`.
- Both shapes in the same frontmatter is an error.

### Agent Derivation

Each agent `.md` file with repo metadata produces an `AgentDef` carrying repo access (`def.repo` set):
- Agent ID: `{key}-agent` (e.g., filename `backend.md` becomes `backend-agent`)
- Base cache paths: `$ARCHIE_WORKDIR/repos/{github}/` per declared repo (nested `org/repo` directories). All declared repos are pre-warmed by `cloneRepos()` at startup, deduplicated across all repo agents; a repo whose base cache is missing (e.g. added to frontmatter after startup) is lazy-cloned on first spawn.
- Per-task clone paths: `sessions/<taskId>/repos/<agentId>/<github>/` (created by `setupSharedClone` at spawn). These are siblings of the agent's cwd (`sessions/<taskId>/agents/<agentId>/`), not nested inside it.
- GitHub repos: from `metadata.archie.repos[*].github`
- Base branches: from `metadata.archie.repos[*].baseBranch` (defaults to `"main"`)
- Identity (role, expertise): from frontmatter
- Domain prompt (Layer 3): from markdown body

### Legacy `repo-config.json`

The `repo-config.json` format is parsed and exposed on `LoadedPlugin.repoConfigs` for backward compatibility, but it is no longer consulted by the agent registry or by `cloneRepos()` — those derive everything from agent frontmatter. The format originally looked like:

```json
{
  "backend": {
    "githubRepo": "org/backend-repo",
    "baseBranch": "main",
    "prompt": "agents/backend.md"
  }
}
```

New plugins should use frontmatter `metadata.archie.repo` exclusively.

**Source:** `src/agents/registry.ts`

## Generic Plugin: `agents/*.md` Format

For agents whose frontmatter omits `metadata.archie.repo.github`, each `.md` file in `agents/` defines an independent plugin-track agent:

- **Filename** determines the key: `copywriter.md` -> key `copywriter`, agent ID `copywriter-agent`
- **Frontmatter** provides `role`, `expertise`, and optional `model`
- **Body** provides the Layer 3 domain-specific prompt

Agent ID collision detection runs at startup. `registry.ts` keeps a single `seenIds` map across both tracks and throws on any duplicate `{key}-agent` ID, regardless of whether the conflict is between two plugin agents, two repo agents, or one of each. The error names both source plugins.

**Source:** `src/agents/registry.ts`

## Agent Skills

### Skills (`skills/`)

Skills intended for agents. Each subdirectory under `skills/` is a Claude Code skill directory (containing `SKILL.md`). At agent spawn time, these are symlinked into the agent's workspace:

```
sessions/{task-id}/agents/{agentKey}/.claude/skills/{skillName} -> plugins/{pluginName}/skills/{skillName}
```

The PM agent also gets its own workspace with skills symlinked from its plugin at spawn time.

**Source:** `src/agents/spawn.ts` (`setupAgentWorkspace`)

## Task Directory Structure

Each task gets an isolated directory under `sessions/`. The PM agent and each specialist agent get their own workspace:

```
sessions/
  task-20260222-1400-a3f9k2/
    shared/                              # Shared task state
      knowledge.log                      # Shared conversation log (all agents)
      metadata.json                      # Task metadata (status, threads, sessions)
      memory/                            # Agent memory storage
      attachments/                       # Downloaded Slack files
      researches/                        # Research results (JSON files)
    agents/
      pm/                                # PM agent workspace
        .claude/
          skills/
            workflow/  -> ...            # Symlinked PM skills
      copywriter/                        # Plugin agent workspace
        .claude/
          skills/
            tone-analysis/  -> ...       # Symlinked agent skills
    repos/                               # Git shared clones (always created; checked out on base for RO, feature branch for RW)
      backend/                           # Shared clone for backend-agent
    researches/                          # Per-research isolated storage
      {uuid}/
        request.json                     # Research manifest
        notes/                           # Researcher output files
        report.json                      # Final synthesized report
```

**Source:** `src/tasks/persistence.ts` (path helpers), `src/tasks/task.ts` (task creation)

## Core vs Plugin Separation

### What stays in `src/` (core system)

- Agent spawning: `src/agents/agent.ts`, `src/agents/spawn.ts`
- Agent registry: `src/agents/registry.ts`
- Agent tools: `src/agents/tools.ts`, `src/mcp/research-tools.ts`
- Plugin loader: `src/system/plugin-loader.ts`
- Task management: `src/tasks/task.ts`, `src/tasks/persistence.ts`
- Type definitions: `src/types/agent.ts`, `src/types/task.ts`
- Prompt templates: `prompts/agent-core.md`, `prompts/repo-agent.md`, `prompts/plugin-agent.md`

### What lives in the plugins repo (domain-specific)

The contents of the `ARCHIE_PLUGINS` git repository, materialized at runtime under `$ARCHIE_WORKDIR/plugins/`:

- `.claude-plugin/plugin.json`: required manifest (name, version, description)
- `repo-config.json`: legacy repository infrastructure mapping (optional, no longer consulted by the registry)
- `agents/*.md`: agent identity, expertise, repo config (via frontmatter), and domain-specific instructions
- `pm/agents/pm.md`: PM overlay prompt (body appended to PM system prompt)
- `skills/`: agent skill directories (Claude Code skills for agents)
- `hooks/hooks.json`: plugin-defined hooks (injected into agent settings)
- `.mcp.json` (at the plugins-repo root, i.e. `$ARCHIE_WORKDIR/plugins/.mcp.json`): MCP server connection configs

This separation means new agents can be added by editing the plugins repo -- no changes to core source code are required, and a redeploy is not necessary. The next task to start or load runs `syncPlugins()`, whose HEAD check sees the new commit and live-loads the content (the base repo for a newly-added repo agent is cloned on demand at spawn time).

## Three-Layer Prompt Composition

All agents (both tracks) use a three-layer prompt composition model:

### Layer 1: Universal Multi-Agent Protocol (`prompts/agent-core.md`)

Shared by all agents. Defines:
- Agent identity (via template variables: `AGENT_ID`, `AGENT_ROLE`, `EXPERTISE`, `PEER_LIST`)
- Dual role system (Task Owner vs Participant)
- Communication tools (`send_message_to_agent`, `log_finding`)
- Coordination strategies (sequential vs parallel)
- Stopping points and workflow structure
- Research content handling guidance

### Layer 2: Track Extension

Track-specific behavior added on top of Layer 1:

- **Repo agents** use `prompts/repo-agent.md`: repository responsibility, dual mode system (read-only vs edit), git workflow (branch management, PR lifecycle), task lifecycle context, honesty guidelines
- **Plugin agents** use `prompts/plugin-agent.md`: read-only mode, available tools (Read, Glob, Grep, Skill), workspace description

### Layer 3: Plugin Override (Domain-Specific)

The markdown body from `agents/{key}.md` is appended as the final layer. This contains domain-specific instructions, coding standards, technology preferences, or any other specialization the agent needs.

```typescript
// From src/agents/agent.ts — prompt composition
const corePrompt = await loadPrompt("agent-core", { ... });    // Layer 1
const trackPrompt = await loadPrompt(trackTemplate, {});         // Layer 2
const layers = [corePrompt, trackPrompt];
if (agentDef.prompt) {
  layers.push(agentDef.prompt);                                   // Layer 3
}
return layers.join("\n\n");
```

The same pattern applies to both repo and plugin agents in `src/agents/agent.ts`, using the appropriate track template (`prompts/repo-agent.md` or `prompts/plugin-agent.md`) for Layer 2.

## Related Documentation

- [Web Research Architecture](./web-research.md) -- research tool available to all agents
- [Security Architecture](./security.md) -- defense layers including plugin agent isolation
