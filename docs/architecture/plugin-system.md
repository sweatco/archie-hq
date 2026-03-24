# Plugin System Architecture

Archie uses a plugin-based architecture to define agents and their capabilities. The plugin system supports two tracks of agents -- **repo agents** (engineering, tied to Git repositories) and **plugin agents** (generic domains, read-only) -- unified through a single plugin loader that scans at startup.

## Two-Track Agent Architecture

### Repo Agent Track (Engineering)

Repo agents are tied to a specific Git repository and have access to git infrastructure (worktrees, branches, PRs via `repo-tools` MCP server). They operate in either read-only or edit mode depending on task state.

- Identified by `metadata.archie.repo` in their markdown frontmatter (or legacy `repo-config.json`)
- Each `agents/*.md` file with repo metadata becomes an agent (e.g., `backend.md` becomes `backend-agent`)
- Infrastructure config (GitHub repo, base branch) comes from frontmatter `metadata.archie.repo`
- Agent identity and domain instructions come from the frontmatter and markdown body

**Source:** `src/agents/spawn.ts`, `src/agents/registry.ts`, `src/types/agent.ts`

### Plugin Agent Track (Generic Domains)

Plugin agents are lightweight, read-only agents for domains that do not need git/worktree/GitHub infrastructure. They are suited for roles like copywriting, design review, QA analysis, or any non-engineering specialization.

- Defined by `agents/*.md` files inside plugins that do **not** have a `repo-config.json`
- Each `.md` file becomes an agent (e.g., `agents/copywriter.md` becomes `copywriter-agent`)
- Agent identity, expertise, and optional model override come from frontmatter
- Domain-specific instructions come from the markdown body
- Tools: `Read`, `Glob`, `Grep`, `Skill`, `send_message_to_agent` (via `repo-agent-tools`), `log_finding` (via `repo-agent-tools`), `web_research` (via `research-tools`)

**Source:** `src/agents/spawn.ts`, `src/agents/registry.ts`, `src/types/agent.ts`

## Plugin Directory Structure

Each plugin is a subdirectory under the `plugins/` directory (at `$ARCHIE_WORKDIR/plugins/`, auto-cloned from `ARCHIE_PLUGINS` git URL). Every plugin **must** have a `.claude-plugin/plugin.json` manifest to be loaded. The structure follows standard Claude Code conventions with Archie-specific extensions:

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

An agent is classified as a **repo agent** if its frontmatter contains `metadata.archie.repo` with a `github` field. Otherwise it is a **plugin agent**. The `repo-config.json` file is still supported as a legacy format but frontmatter-based repo config is preferred.

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

### Startup Scanning Process

1. Read all entries in `PLUGINS_DIR` (at `$ARCHIE_WORKDIR/plugins/`)
2. For each subdirectory:
   - **Require** `.claude-plugin/plugin.json` with `name`, `version`, `description` -- skip if missing
   - Check for `repo-config.json` and parse it if present (legacy support)
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
- **`model`** (string, optional): Model override (defaults to `sonnet` if not specified)
- **`metadata.archie.repo`** (object, optional): If present with a `github` field, classifies the agent as a repo agent with `github` (repo identifier) and optional `baseBranch`
- **`mcpServers`** (string[], optional): MCP server names from the root `.mcp.json` that this agent should have access to
- **`tools`** (string[], optional): Additional tool allowlist entries
- **`disallowedTools`** (string[], optional): Tool denylist entries

The markdown body (everything after the frontmatter) becomes the Layer 3 domain-specific prompt.

## Repo Agent Configuration

Repo agents are identified by the `metadata.archie.repo` field in their frontmatter. The `github` field is required and specifies the GitHub repository identifier:

```markdown
---
role: Senior backend engineer
expertise: Ruby on Rails, PostgreSQL
metadata:
  archie:
    repo:
      github: org/backend-repo
      baseBranch: main
---
```

### Agent Derivation

Each agent `.md` file with repo metadata produces a `RepoAgentConfig`:
- Agent ID: `{key}-agent` (e.g., filename `backend.md` becomes `backend-agent`)
- Repository path: `$ARCHIE_WORKDIR/repos/{key}` by default
- GitHub repo: from `metadata.archie.repo.github`
- Base branch: from `metadata.archie.repo.baseBranch` (defaults to `"main"`)
- Identity (role, expertise): from frontmatter
- Domain prompt (Layer 3): from markdown body

### Legacy `repo-config.json`

The `repo-config.json` format is still supported for backward compatibility. It maps agent keys to infrastructure configs:

```json
{
  "backend": {
    "githubRepo": "org/backend-repo",
    "baseBranch": "main",
    "prompt": "agents/backend.md"
  }
}
```

When both frontmatter repo metadata and `repo-config.json` exist, the frontmatter takes precedence.

**Source:** `src/agents/registry.ts`

## Generic Plugin: `agents/*.md` Format

For plugins without `repo-config.json`, each `.md` file in `agents/` defines an independent agent:

- **Filename** determines the key: `copywriter.md` -> key `copywriter`, agent ID `copywriter-agent`
- **Frontmatter** provides `role`, `expertise`, and optional `model`
- **Body** provides the Layer 3 domain-specific prompt

Agent ID collision detection runs at startup. `registry.ts` checks for:
- Collisions between plugin agent IDs and repo agent IDs
- Collisions between plugin agent IDs across different plugins

If a collision is detected, the system throws an error with a message identifying both conflicting sources.

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
    repos/                               # Git worktrees (always created; detached HEAD for RO, feature branch for RW)
      backend/                           # Worktree for backend-agent
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

### What goes in `plugins/` (domain-specific)

- `.claude-plugin/plugin.json`: required manifest (name, version, description)
- `repo-config.json`: legacy repository infrastructure mapping (optional)
- `agents/*.md`: agent identity, expertise, repo config (via frontmatter), and domain-specific instructions
- `pm/agents/pm.md`: PM overlay prompt (body appended to PM system prompt)
- `skills/`: agent skill directories (Claude Code skills for agents)
- `hooks/hooks.json`: plugin-defined hooks (injected into agent settings)
- `.mcp.json` (at plugins root): MCP server connection configs

This separation means new agents can be added by creating a plugin directory with the appropriate files -- no changes to core source code are required.

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
