# Plugin System Architecture

Archie uses a plugin-based architecture to define agents and their capabilities. The plugin system supports two tracks of agents -- **repo agents** (engineering, tied to Git repositories) and **plugin agents** (generic domains, read-only) -- unified through a single plugin loader that scans at startup.

## Two-Track Agent Architecture

### Repo Agent Track (Engineering)

Repo agents are tied to a specific Git repository and have access to git infrastructure (worktrees, branches, PRs). They operate in either read-only or edit mode depending on task state.

- Defined by a `repo-config.json` in the plugin directory
- Each key in `repo-config.json` becomes an agent (e.g., `"backend"` becomes `backend-agent`)
- Infrastructure config (GitHub repo, base branch, repo path) comes from `repo-config.json`
- Agent identity and domain instructions come from the `agents/*.md` file referenced by the `prompt` field

**Source:** `src/agents/repo-agent.ts`, `src/agents/repo-configs.ts`, `src/types/repo-agent.ts`

### Plugin Agent Track (Generic Domains)

Plugin agents are lightweight, read-only agents for domains that do not need git/worktree/GitHub infrastructure. They are suited for roles like copywriting, design review, QA analysis, or any non-engineering specialization.

- Defined by `agents/*.md` files inside plugins that do **not** have a `repo-config.json`
- Each `.md` file becomes an agent (e.g., `agents/copywriter.md` becomes `copywriter-agent`)
- Agent identity, expertise, and optional model override come from frontmatter
- Domain-specific instructions come from the markdown body
- Tools: `Read`, `Glob`, `Grep`, `Skill`, `send_message_to_agent`, `log_finding`, `web_research`

**Source:** `src/agents/plugin-agent.ts`, `src/agents/plugin-configs.ts`, `src/types/plugin-agent.ts`

## Plugin Directory Structure

Each plugin is a subdirectory under the `plugins/` directory (configurable via `ARCHIE_PLUGINS_DIR` env var). The structure follows standard Claude Code conventions with Archie-specific extensions:

```
plugins/
  engineering/                    # Repo plugin (has repo-config.json)
    repo-config.json              # Infrastructure configs for repo agents
    agents/
      backend.md                  # Agent prompt (frontmatter + body)
      mobile.md
    pm-skills/                    # PM skill directories
      workflow/
        SKILL.md                  # Claude Code skill definition
    skills/                       # Agent craft skills (symlinked into agent workspaces)
      debugging/
        SKILL.md

  marketing/                      # Generic plugin (no repo-config.json)
    agents/
      copywriter.md               # Becomes copywriter-agent
      brand-strategist.md         # Becomes brand-strategist-agent
    pm-skills/
      campaign-review/
        SKILL.md
    skills/
      tone-analysis/
        SKILL.md
```

A plugin is classified as a **repo plugin** if it contains `repo-config.json`, or a **generic plugin** if it does not. This distinction is mutually exclusive: plugins with `repo-config.json` do not have their `agents/*.md` files loaded as plugin agents (those agents are handled by `repo-configs.ts` instead).

## Plugin Loader

The plugin loader (`src/system/plugin-loader.ts`) runs once at startup using synchronous filesystem reads. It scans every subdirectory of `PLUGINS_DIR` and produces a `LoadedPlugin[]` array consumed by downstream modules.

### Startup Scanning Process

1. Read all entries in `PLUGINS_DIR` (default: `./plugins/`)
2. For each subdirectory:
   - Check for `repo-config.json` and parse it if present
   - Scan `pm-skills/` for subdirectories, building namespaced skill entries (`{pluginName}-{skillDirName}`)
   - If **no** `repo-config.json`: scan `agents/*.md` for generic agent definitions, parsing frontmatter with `gray-matter`
   - Check for `skills/` directory and record its absolute path
3. Return the array of `LoadedPlugin` objects

```typescript
// From src/system/plugin-loader.ts
export interface LoadedPlugin {
  name: string;                                          // Directory name
  dir: string;                                           // Absolute path
  repoConfigs: Record<string, PluginRepoConfig> | null;  // null for generic plugins
  pmSkills: PmSkillEntry[];                              // Namespaced PM skills
  agents: PluginAgentDef[];                              // Generic agents (empty for repo plugins)
  skillsPath: string | null;                             // Absolute path to skills/ if exists
}
```

### Agent Markdown Parsing (gray-matter)

Agent definition files use YAML frontmatter parsed by the `gray-matter` library:

```markdown
---
role: Senior copywriter
expertise: Ad copy, landing pages, email campaigns
model: haiku
---

## Domain Instructions

You specialize in crafting compelling copy...
```

Fields:
- **`role`** (string): Short role description, used in peer agent lists
- **`expertise`** (string): Detailed expertise description, used in the agent's own prompt
- **`model`** (string, optional): Model override (defaults to `sonnet` if not specified)

The markdown body (everything after the frontmatter) becomes the Layer 3 domain-specific prompt.

## Repo Plugin: `repo-config.json` Format

The `repo-config.json` file maps agent keys to their infrastructure configuration:

```json
{
  "backend": {
    "githubRepo": "org/backend-repo",
    "baseBranch": "main",
    "repoPath": "/repos/backend",
    "prompt": "agents/backend.md"
  },
  "mobile": {
    "githubRepo": "org/mobile-app",
    "baseBranch": "develop",
    "prompt": "agents/mobile.md"
  }
}
```

Fields per agent key:
- **`githubRepo`** (string, required): GitHub repository identifier (e.g., `"org/repo"`)
- **`baseBranch`** (string, optional): Base branch for PRs and merges (defaults to `"main"`)
- **`repoPath`** (string, optional): Absolute path to the repository on disk (defaults to `$ARCHIE_REPOS_DIR/{key}`)
- **`prompt`** (string, required): Relative path to the agent's markdown prompt file

### Agent Derivation

Each key in `repo-config.json` produces a `RepoAgentConfig`:
- Agent ID: `{key}-agent` (e.g., `"backend"` becomes `"backend-agent"`)
- Repository path: `repoPath` from config, or `$ARCHIE_REPOS_DIR/{key}` (default `/repos/{key}`)
- Identity (role, expertise): parsed from the referenced `agents/{key}.md` frontmatter
- Domain prompt (Layer 3): parsed from the referenced `agents/{key}.md` body

**Source:** `src/agents/repo-configs.ts`

## Generic Plugin: `agents/*.md` Format

For plugins without `repo-config.json`, each `.md` file in `agents/` defines an independent agent:

- **Filename** determines the key: `copywriter.md` -> key `copywriter`, agent ID `copywriter-agent`
- **Frontmatter** provides `role`, `expertise`, and optional `model`
- **Body** provides the Layer 3 domain-specific prompt

Agent ID collision detection runs at startup. `plugin-configs.ts` checks for:
- Collisions between plugin agent IDs and repo agent IDs
- Collisions between plugin agent IDs across different plugins

If a collision is detected, the system throws an error with a message identifying both conflicting sources.

**Source:** `src/agents/plugin-configs.ts`

## PM Skills vs Agent Skills

The plugin system distinguishes between two kinds of skills:

### PM Skills (`pm-skills/`)

Skills intended for the PM agent. Each subdirectory under `pm-skills/` is a Claude Code skill directory (containing `SKILL.md`). The plugin loader namespaces these as `{pluginName}-{skillDirName}` to avoid collisions across plugins.

At task creation time, all PM skills from all loaded plugins are symlinked into the PM agent's workspace:

```
sessions/{task-id}/shared/.claude/skills/{pluginName}-{skillDirName} -> plugins/{pluginName}/pm-skills/{skillDirName}
```

**Source:** `src/system/task-runtime.ts` (task creation), `src/system/plugin-loader.ts` (scanning)

### Agent Skills (`skills/`)

Skills intended for plugin agents. Each subdirectory under `skills/` is a Claude Code skill directory. At agent spawn time, these are symlinked into the agent's workspace:

```
sessions/{task-id}/agents/{agentKey}/.claude/skills/{skillName} -> plugins/{pluginName}/skills/{skillName}
```

**Source:** `src/agents/plugin-agent.ts` (`setupAgentWorkspace`)

## Task Directory Structure

Each task gets an isolated directory under `sessions/`. The PM agent and each specialist agent get their own workspace:

```
sessions/
  task-20260222-1400-a3f9k2/
    shared/                              # PM agent's working directory
      knowledge.log                      # Shared conversation log (all agents)
      metadata.json                      # Task metadata (status, threads, sessions)
      memory/                            # PM memory storage
      attachments/                       # Downloaded Slack files
      researches/                        # Research results (JSON files)
      .claude/
        skills/
          engineering-workflow/  -> ...   # Symlinked PM skills
    agents/
      copywriter/                        # Plugin agent workspace
        .claude/
          skills/
            tone-analysis/  -> ...       # Symlinked agent skills
    repos/                               # Git worktrees (edit mode only)
      backend/                           # Worktree for backend-agent
    researches/                          # Per-research isolated storage
      {uuid}/
        request.json                     # Research manifest
        notes/                           # Researcher output files
        report.json                      # Final synthesized report
```

**Source:** `src/system/task-manager.ts` (path helpers), `src/system/task-runtime.ts` (task creation)

## Core vs Plugin Separation

### What stays in `src/` (core system)

- Agent spawners: `src/agents/repo-agent.ts`, `src/agents/plugin-agent.ts`, `src/agents/pm.ts`
- Config builders: `src/agents/repo-configs.ts`, `src/agents/plugin-configs.ts`
- Plugin loader: `src/system/plugin-loader.ts`
- MCP tools: `src/mcp/tools.ts`, `src/mcp/research-tools.ts`
- Task management: `src/system/task-manager.ts`, `src/system/task-runtime.ts`
- Type definitions: `src/types/repo-agent.ts`, `src/types/plugin-agent.ts`, `src/types/task.ts`
- Prompt templates: `prompts/agent-core.md`, `prompts/repo-agent.md`, `prompts/plugin-agent.md`

### What goes in `plugins/` (domain-specific)

- `repo-config.json`: repository infrastructure mapping
- `agents/*.md`: agent identity, expertise, and domain-specific instructions
- `pm-skills/`: PM skill directories (Claude Code skills for the PM agent)
- `skills/`: agent skill directories (Claude Code skills for plugin agents)

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

- **Repo agents** use `prompts/repo-agent.md`: repository responsibility, dual mode system (read-only vs edit), git workflow, task lifecycle context
- **Plugin agents** use `prompts/plugin-agent.md`: read-only mode, available tools (Read, Glob, Grep, Skill), workspace description

### Layer 3: Plugin Override (Domain-Specific)

The markdown body from `agents/{key}.md` is appended as the final layer. This contains domain-specific instructions, coding standards, technology preferences, or any other specialization the agent needs.

```typescript
// From src/agents/plugin-agent.ts — generatePluginAgentPrompt()
const corePrompt = await loadPrompt("agent-core", { ... });    // Layer 1
const pluginPrompt = await loadPrompt("plugin-agent", {});       // Layer 2
const layers = [corePrompt, pluginPrompt];
if (config.prompt) {
  layers.push(config.prompt);                                     // Layer 3
}
return layers.join("\n\n");
```

The same pattern applies to repo agents in `src/agents/repo-agent.ts`, using `prompts/repo-agent.md` for Layer 2 and `config.agentPrompt` for Layer 3.

## Related Documentation

- [Web Research Architecture](./web-research.md) -- research tool available to all agents
- [Security Architecture](./security.md) -- defense layers including plugin agent isolation
