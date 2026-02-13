# Plugin Agent Architecture

## Status: Draft / Design Discussion

## Problem

Archie is currently an engineering-only system. The PM agent's prompt, tools, and orchestration logic are tightly coupled to software engineering workflows (git, PRs, code review, worktrees). Adding new domains like marketing means either:

1. Polluting the PM prompt with unrelated workflows (confuses the model)
2. Hardcoding each new domain the way engineering is hardcoded (doesn't scale)

## Solution: Two-Track Agent Architecture

Keep engineering infrastructure (git, GitHub, worktrees) as core Archie capabilities. Make all domain knowledge — agent personas, repo configs, PM workflows — pluggable. Add a generic plugin-agent track for new domains that don't need engineering infrastructure.

```
ensureAgentSpawned(agentName)
  ├── getRepoConfig(agentName)?    → spawnRepoAgent()    [repo track - core infrastructure]
  ├── getPluginAgent(agentName)?   → spawnPluginAgent()   [plugin track - generic]
  └── agentName === "pm-agent"     → spawnPMAgent()       [PM]
```

## SDK Research: Why We Don't Use Native Plugin Loading

The Claude Agent SDK supports loading plugins via `plugins: [{ type: "local", path }]` in `query()` options. However, examining the SDK source reveals it's a thin CLI wrapper — `plugins` becomes `--plugin-dir` flags passed to the Claude Code CLI subprocess. This means:

- **All-or-nothing loading**: No way to load specific agents or skills from a plugin. Everything in the plugin directory gets loaded into the session.
- **Single session context**: Plugin agents become subagents within the parent's `query()` session. They can't have their own `query()` with custom infrastructure (worktrees, MCP servers, cwd).
- **No selective skill targeting**: If PM loads a plugin, it sees agent skills meant for specialist agents too. We need PM to see only PM orchestration skills.

**Our approach**: Plugins follow Claude's standard directory structure (`.claude-plugin/plugin.json`, `agents/`, `skills/`) for compatibility, but Archie reads from them selectively at startup rather than passing them to the SDK's `plugins` parameter. We add our own extensions (`pm/`, `repo-config.json`) on top.

## Plugin Directory Structure

Plugins follow the standard Claude Code plugin structure with Archie-specific extensions:

```
plugins/                              ← Mount point (configurable via ARCHIE_PLUGINS_DIR)
├── engineering/                      ← Repo plugin (has repo-config.json)
│   ├── .claude-plugin/
│   │   └── plugin.json               # Standard Claude manifest (required)
│   ├── repo-config.json               # Archie extension: signals repo-agent track
│   ├── pm/                            # Archie extension: PM orchestration skills
│   │   ├── engineering/
│   │   │   └── SKILL.md
│   │   └── engineering-pr/
│   │       └── SKILL.md
│   ├── agents/                        # Standard: per-agent prompt overrides
│   │   ├── backend.md
│   │   └── mobile.md
│   ├── skills/                        # Standard: agent craft skills
│   │   └── rails-patterns/
│   │       └── SKILL.md
│   ├── commands/                      # Standard: ignored for now
│   ├── hooks/                         # Standard: ignored for now
│   └── .mcp.json                      # Standard: ignored for now
│
└── marketing/                        ← Generic plugin (no repo-config.json)
    ├── .claude-plugin/
    │   └── plugin.json
    ├── pm/
    │   ├── marketing/
    │   │   └── SKILL.md
    │   └── campaign/
    │       └── SKILL.md
    ├── agents/
    │   ├── copywriter.md
    │   └── analytics.md
    ├── skills/
    │   ├── copywriting/
    │   │   └── SKILL.md
    │   └── brand-voice/
    │       └── SKILL.md
    └── .mcp.json
```

### Standard Claude plugin components

| Component | Status | Notes |
|-----------|--------|-------|
| `.claude-plugin/plugin.json` | **Required** | Standard manifest. Used for plugin discovery. |
| `agents/` | **Supported** | Agent markdown files. Read by Archie at startup. |
| `skills/` | **Supported** | Agent-level SKILL.md files. Made available to spawned agents. |
| `commands/` | Ignored (future) | No use case — agents aren't interactive CLI sessions. |
| `hooks/` | Ignored (future) | Could be useful for plugin-specific tool validation. |
| `.mcp.json` | Ignored (future) | Could provide domain-specific MCP servers. |

### Archie extensions

| Component | Purpose |
|-----------|---------|
| `repo-config.json` | Signals "use repo-agent infrastructure". Defines agents, repos, GitHub orgs. |
| `pm/` | PM orchestration skills. Separated from `skills/` so agents don't see PM workflows. |

## Core Archie vs Plugins

### What stays in core (infrastructure)

Runtime infrastructure that's complex, performance-sensitive, and reusable:

- **Agent core prompt** (`agent-core.md`) — Universal multi-agent collaboration protocol (identity, peers, communication, coordination, stopping points, thinking framework)
- **Repo agent extension** (`repo-agent.md`) — Repo-specific: dual mode system, git workflow, edit mode, conflict resolution
- **Plugin agent extension** (`plugin-agent.md`) — Plugin-specific: lightweight workspace description, read-only default mode
- **Repo agent spawner** (`repo-agent.ts`) — Worktree management, edit mode gating, git operations
- **GitHub client** (`github/client.ts`) — API wrapper, authentication
- **GitHub tools** (`tools.ts`) — PR lifecycle MCP tools (push, create PR, reviews, merge check)
- **Merge orchestrator** (`merge-orchestrator.ts`) — Auto-merge logic
- **Worktree manager** (`worktree-manager.ts`) — Git worktree lifecycle
- **Webhook routing** (`webhook-router.ts`) — GitHub event classification
- **Plugin agent spawner** (`plugin-agent.ts`) — Generic agent spawner for non-repo domains
- **Plugin loader** (`plugin-loader.ts`) — Plugin discovery and registration
- **PM core prompt** (`pm-agent-core.md`) — Domain-agnostic orchestration
- **Generic infrastructure** — Queues, tasks, sessions, Slack, triage, recovery

### What moves to plugins (domain knowledge)

Configuration and prompts that vary per deployment:

- **Which repos and agents exist** — `repo-config.json` replaces hardcoded `repo-configs.ts`
- **Agent role/expertise descriptions** — Used for PM team roster
- **PM orchestration workflows** — Engineering skill, PR skill, marketing skill, etc.
- **Agent craft skills** — Domain-specific knowledge for specialist agents

## Plugin Types

### Repo Plugin (uses core engineering infrastructure)

A plugin signals it needs the repo-agent track by including a `repo-config.json` file. Archie sees this file and uses `spawnRepoAgent` for these agents, with all the git/GitHub/worktree infrastructure.

**`repo-config.json`** — replaces hardcoded `repo-configs.ts` content. Object keyed by short name:

```json
{
  "backend": {
    "role": "Senior Ruby on Rails engineer. Expert in APIs, databases, authentication, background jobs.",
    "expertise": "APIs, databases, business logic, infrastructure, Ruby on Rails best practices",
    "githubRepo": "sweatco/sweatcoin-backend",
    "baseBranch": "master",
    "prompt": "agents/backend.md",
    "repoPath": "/repos/sweatcoin-backend"
  },
  "mobile": {
    "role": "Senior React Native engineer with Swift/Kotlin expertise.",
    "expertise": "React Native, Swift, Kotlin, mobile UI/UX, deep linking, push notifications",
    "githubRepo": "sweatco/sweatcoin-mobile",
    "baseBranch": "main"
  }
}
```

**Derivation at load time:**

| Source | Derived value |
|--------|--------------|
| Object key (`"backend"`) | Used as repo key everywhere: `metadata.repositories["backend"]`, GitHub tool `repo_key` param, worktree path |
| Key + `-agent` | `agentId` = `"backend-agent"` — used for queues, message routing, session tracking |
| `repoPath` (optional) | Path to cloned repo on disk. Defaults to `${ARCHIE_REPOS_DIR}/${key}` (e.g., `/repos/backend`) |
| `prompt` (optional) | Relative path to Layer 3 agent prompt override within the plugin |

**How it works:**

1. At startup, `plugin-loader.ts` scans `plugins/` for directories with `.claude-plugin/plugin.json`
2. If a plugin contains `repo-config.json`, the loader reads it, derives `agentId` and `repoPath` from each key, and registers those agents via `repo-configs.ts` (which becomes a registry, not a hardcoded definition)
3. The functions `getAllRepoConfigs()`, `getRepoConfig()`, `getAllRepoAgentIds()` continue to work as before — every caller is unchanged
4. Only the data source changes: hardcoded array → read from plugin's `repo-config.json`
5. The repo-agent infrastructure (worktrees, git, GitHub tools) handles these agents exactly as it does today

**Agent prompt composition:** See [Agent Prompt Architecture](#agent-prompt-architecture) below.

### Generic Plugin (uses plugin-agent spawner)

A plugin without `repo-config.json` is a generic plugin. Its agents use the lightweight `spawnPluginAgent` — no git, no worktrees, no GitHub tools.

**Agent markdown format** (`agents/copywriter.md` — filename is the key):

```markdown
---
role: Senior copywriter. Expert in ad copy, landing pages, email campaigns.
expertise: Ad copy, landing pages, email campaigns, brand voice, A/B testing
---

# Domain-Specific Instructions

When writing ad copy, always start with the value proposition...

[Domain knowledge, best practices, specific instructions]
[Does NOT need multi-agent protocol — that comes from agent-core.md]
```

Derivation: filename `copywriter.md` → key `"copywriter"` → `agentId` = `"copywriter-agent"`.

## Agent Prompt Architecture

All agents (repo and plugin) share a common collaboration protocol. The prompt is composed in layers at spawn time:

```
┌─────────────────────────────────────────────┐
│  Layer 3: Plugin agent override (optional)   │  plugins/<name>/agents/backend.md
│  Domain-specific instructions & knowledge    │
├─────────────────────────────────────────────┤
│  Layer 2: Track extension                    │  repo-agent.md OR plugin-agent.md
│  Track-specific capabilities & workflows     │
├─────────────────────────────────────────────┤
│  Layer 1: agent-core.md                      │  Universal multi-agent protocol
│  Identity, peers, communication, coordination │
└─────────────────────────────────────────────┘
```

### Layer 1: `agent-core.md` (universal, all agents)

Extracted from the current `repo-agent.md`. Contains everything that applies to any agent in the system:

- **Identity**: `{{AGENT_ID}}`, `{{AGENT_ROLE}}`, `{{EXPERTISE}}`
- **Peer awareness**: `{{PEER_LIST}}` with all agents and PM
- **Communication tools**: `send_message_to_agent`, `log_finding`
- **Dual role system**: Task Owner vs Participant (explicit assignment)
- **Coordination strategies**: Sequential vs Parallel, with stopping rules
- **Critical stopping points**: When to stop and wait
- **Thinking framework**: The `<thinking>` analysis structure (context review, role/mode determination, work analysis, coordination strategy, stopping points)
- **Workflow structure**: Receive message → Analyze → Work → Report → Stop
- **Key principles**: One completion message, always stop after reporting, etc.

### Layer 2: Track extension (one per track)

**`repo-agent.md`** — for agents spawned via `spawnRepoAgent`:
- Dual mode system (Read-Only vs Edit, determined by available tools)
- Task lifecycle context (Research → Implement → Review → Conflicts)
- Git workflow (staging, committing, conflict resolution)
- Git command reference and restrictions (no push, no fetch)
- `{{BASE_BRANCH}}`, `{{REPO_KEY}}` interpolation

**`plugin-agent.md`** — for agents spawned via `spawnPluginAgent`:
- Workspace description (task shared folder, available files)
- Default read-only mode explanation
- No git/worktree/edit-mode content
- Much shorter than repo-agent.md

### Layer 3: Plugin agent override (optional)

The plugin's `agents/<name>.md` file. Contains domain-specific instructions:
- For repo plugins: "When investigating backend issues, always check database migrations first"
- For generic plugins: The full agent persona and domain knowledge (copywriting techniques, brand guidelines, etc.)

For repo agents in v1, Layer 3 is optional — `role` and `expertise` from `repo-config.json` are interpolated into Layer 1 and are sufficient. For generic plugin agents, Layer 3 is the primary source of domain instructions.

### Prompt composition at spawn time

**Repo agent:**
```typescript
const prompt = [
  loadPrompt("agent-core", { AGENT_ID, AGENT_ROLE, EXPERTISE, PEER_LIST }),
  loadPrompt("repo-agent", { BASE_BRANCH, REPO_KEY }),
  pluginAgentOverride ?? "",  // Optional: plugins/<name>/agents/backend.md
].join("\n\n");
```

**Plugin agent:**
```typescript
const prompt = [
  loadPrompt("agent-core", { AGENT_ID, AGENT_ROLE, EXPERTISE, PEER_LIST }),
  loadPrompt("plugin-agent", {}),
  pluginAgentDef.prompt,  // Required: plugins/<name>/agents/copywriter.md body
].join("\n\n");
```

### Migration from current `repo-agent.md`

The current `repo-agent.md` gets split:

| Current content | Moves to |
|----------------|----------|
| Lines 1-16: Identity, peers | `agent-core.md` |
| Lines 19-31: Task lifecycle (research/implement/review/conflicts) | `repo-agent.md` |
| Lines 35-52: Dual role + dual mode | Role system → `agent-core.md`, Mode system → `repo-agent.md` |
| Lines 53-56: Communication tools | `agent-core.md` |
| Lines 58-93: Git workflow, edit mode | `repo-agent.md` |
| Lines 95-123: Coordination strategies, stopping points | `agent-core.md` |
| Lines 124-217: Workflow, thinking framework, key principles | `agent-core.md` |

After split, `repo-agent.md` becomes ~40 lines (task lifecycle + dual mode + git workflow). `agent-core.md` gets the remaining ~140 lines of universal protocol.

## Generic Plugin Agent Spawner

`spawnPluginAgent` is intentionally simple compared to `spawnRepoAgent`:

```typescript
async function spawnPluginAgent(
  agentDef: PluginAgentDef,
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: BaseToolCallbacks,
  onSessionId: (sessionId: string) => void,
  existingSessionId?: string
): Promise<AgentHandle> {
  const sharedPath = getSharedPath(metadata.task_id);
  const agentWorkspace = getAgentWorkspacePath(metadata.task_id, agentDef.key);
  const peerList = buildPeerList(agentDef.agentId);

  // Ensure agent workspace exists with skills symlinked
  await mkdir(agentWorkspace, { recursive: true });
  await symlinkPluginSkills(agentDef.pluginPath, agentWorkspace);

  // Layer 1: Universal multi-agent protocol
  const corePrompt = loadPrompt("agent-core", {
    AGENT_ID: agentDef.agentId,
    AGENT_ROLE: agentDef.role,
    EXPERTISE: agentDef.expertise,
    PEER_LIST: peerList,
  });

  // Layer 2: Plugin-agent track extension
  const trackPrompt = loadPrompt("plugin-agent", {});

  // Layer 3: Plugin's domain-specific agent instructions
  const domainPrompt = agentDef.prompt;

  const systemPrompt = [corePrompt, trackPrompt, domainPrompt].join("\n\n");

  const options = {
    model: agentDef.model || "claude-sonnet-4-5-20250929",
    systemPrompt,
    cwd: agentWorkspace,                 // Agent's own workspace
    additionalDirectories: [sharedPath], // Access to shared knowledge.log, metadata.json
    settingSources: ["project"],         // Discovers skills from .claude/skills/
    maxTurns: 100,
    permissionMode: "dontAsk",
    mcpServers: { "plugin-agent-tools": createRepoAgentMcpServer(callbacks) },
    allowedTools: [
      "mcp__plugin-agent-tools__send_message_to_agent",
      "mcp__plugin-agent-tools__log_finding",
      "Read", "Glob", "Grep",
      "Skill",
    ],
    resume: existingSessionId,
  };

  // Standard query() + recoverable generator + session retry
  // Same pattern as repo-agent but without worktree/edit-mode complexity
}

// Helper: symlink plugin's skills/ into agent workspace
async function symlinkPluginSkills(pluginPath: string, agentWorkspace: string): Promise<void> {
  const pluginSkills = join(pluginPath, "skills");
  if (!existsSync(pluginSkills)) return;

  const skillsTarget = join(agentWorkspace, ".claude", "skills");
  await mkdir(join(agentWorkspace, ".claude"), { recursive: true });

  // Symlink each skill subdirectory individually
  for (const entry of await readdir(pluginSkills, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const target = join(skillsTarget, entry.name);
      if (!existsSync(target)) {
        await symlink(join(pluginSkills, entry.name), target);
      }
    }
  }
}
```

**Key differences from `spawnRepoAgent`:**

| Aspect | Repo Agent | Plugin Agent |
|--------|-----------|--------------|
| Working directory | Git worktree (edit mode) or repo root (readonly) | Task shared folder |
| Edit capabilities | Write, Edit, git commands (gated by edit_allowed) | Read-only by default, extensible via plugin config |
| Workspace setup | Worktree creation, branch management, fetch | None |
| Prompt source | Core `repo-agent.md` + config interpolation | Plugin's `agents/*.md` file |
| Tools | Base + Write/Edit/git (conditional) | Base + Skill |

## Plugin Discovery & Mounting

### Where plugins live

Archie scans a single directory for plugins. The path is configurable:

```
ARCHIE_PLUGINS_DIR=./plugins   # Default
```

The `plugins/` directory can be:
- A local directory with plugins checked in (monorepo, for development)
- A symlink to another repo
- A git submodule
- A mounted volume (Docker)
- Cloned from a separate plugins repo at deploy time

Archie doesn't care how the plugins got there — it just reads from `plugins/`.

### Discovery logic

At startup, `plugin-loader.ts` scans the plugins directory:

```typescript
interface PluginManifest {
  name: string;            // From plugin.json
  path: string;            // Absolute path to plugin directory
  hasRepoConfig: boolean;  // true if repo-config.json exists
  repoConfigs?: RepoAgentConfig[];  // Parsed + derived from repo-config.json
  agents: PluginAgentDef[];         // Parsed from agents/*.md (generic plugin agents only)
  pmSkillsPath?: string;            // Path to pm/ directory if it exists
  skillsPath?: string;              // Path to skills/ directory if it exists
}

interface PluginAgentDef {
  key: string;            // From filename: copywriter.md → "copywriter"
  agentId: string;        // Derived: key + "-agent" → "copywriter-agent"
  role: string;           // From frontmatter: role
  expertise: string;      // From frontmatter: expertise
  prompt: string;         // Markdown body (domain-specific instructions)
  model?: string;         // From frontmatter: model (optional)
  pluginName: string;     // From plugin.json: name
  pluginPath: string;     // Absolute path to plugin directory
}

function discoverPlugins(): PluginManifest[] {
  // 1. Scan plugins/ for directories with .claude-plugin/plugin.json
  // 2. Check for repo-config.json → parse, derive agentId/repoPath from keys
  // 3. Scan agents/ for .md files → derive key from filename, parse frontmatter + body
  // 4. Check for pm/ directory
  // 5. Check for skills/ directory
  // 6. Return list of plugin manifests
}
```

**Registration flow:**

```typescript
const plugins = discoverPlugins();

for (const plugin of plugins) {
  // Register repo agents (if any) — these use spawnRepoAgent
  if (plugin.repoConfigs) {
    registerRepoConfigs(plugin.repoConfigs);
  }

  // Register plugin agents (if any) — these use spawnPluginAgent
  for (const agent of plugin.agents) {
    // Only register agents that aren't already covered by repo-config
    if (!getRepoConfig(agent.agentId)) {
      registerPluginAgent(agent);
    }
  }

  // Register PM skills for symlink at task creation
  if (plugin.pmSkillsPath) {
    registerPMSkills(plugin.pmSkillsPath);
  }
}
```

## Runtime Integration

### Queue Initialization (`initializeTaskRuntime`)

```typescript
// Existing: queues for PM + repo agents
queues.set("pm-agent", new MessageQueue());
for (const config of getAllRepoConfigs()) {
  queues.set(config.agentId, new MessageQueue());
}

// New: queues for plugin agents
for (const pluginAgent of getAllPluginAgents()) {
  queues.set(pluginAgent.agentId, new MessageQueue());
}
```

### PM Team Roster

```typescript
async function generatePMSystemPrompt(): Promise<string> {
  const repoConfigs = getAllRepoConfigs();
  const pluginAgents = getAllPluginAgents();

  const teamList = [
    ...repoConfigs.map(c => `- ${c.agentId}: ${c.role}`),
    ...pluginAgents.map(a => `- ${a.agentId}: ${a.role}`),
  ].join("\n");

  const expertise = [
    ...repoConfigs.map(c => `- ${c.agentId}: ${c.expertise}`),
    ...pluginAgents.map(a => `- ${a.agentId}: ${a.expertise}`),
  ].join("\n");

  return loadPrompt("pm-agent-core", {
    TEAM_LIST: teamList,
    TEAM_EXPERTISE: expertise,
  });
}
```

### Tool Registration

All agents (repo + plugin) need to be in the `send_message_to_agent` target enum:

```typescript
function createSendMessageTool(callbacks: BaseToolCallbacks) {
  const allAgents = [
    'pm-agent',
    ...getAllRepoAgentIds(),
    ...getAllPluginAgents().map(a => a.agentId),
  ] as [string, ...string[]];
  // ...
}
```

### repo-configs.ts Changes

`repo-configs.ts` becomes a registry that loads from plugins instead of a hardcoded array:

```typescript
// Before: hardcoded
export const repoConfigs: RepoAgentConfig[] = [
  { agentId: 'backend-agent', ... },
  { agentId: 'mobile-agent', ... },
];

// After: populated by plugin-loader at startup
let repoConfigs: RepoAgentConfig[] = [];

export function registerRepoConfigs(configs: RepoAgentConfig[]): void {
  repoConfigs.push(...configs);
}

// All existing functions unchanged:
export function getRepoConfig(agentId: string): RepoAgentConfig | undefined { ... }
export function getAllRepoConfigs(): RepoAgentConfig[] { ... }
export function getAllRepoAgentIds(): string[] { ... }
export function getRepoConfigByGithubRepo(githubRepo: string): RepoAgentConfig | undefined { ... }
```

Every file that imports from `repo-configs.ts` keeps working. The only change is the data source.

## Skills: PM vs Agent Separation

A plugin contains two distinct audiences for skills:

**PM orchestration skills** (`pm/` directory) — How to manage this domain's tasks:
- Decision framework (what to do when agent reports findings)
- Domain-specific lifecycle (marketing doesn't have PRs or code review)
- Domain vocabulary (how to communicate about this work to users)

**Agent craft skills** (`skills/` directory) — How to do the actual work:
- Domain expertise (copywriting techniques, brand guidelines)
- Reference materials (style guides, templates)
- Tool-specific workflows

### Why separate directories?

Claude Code auto-discovers `skills/` directories inside plugins. If PM skills lived in `skills/`, plugin agents would see them too — a copywriter agent doesn't need to know about PM orchestration workflows.

The `pm/` directory is a convention outside Claude Code's auto-discovery paths. The runtime explicitly collects `pm/` SKILL.md files from all plugins and makes them available to PM, while plugin agents never see them.

### Task directory structure

Each task creates isolated workspaces for PM and each agent:

```
sessions/task-{id}/
  shared/                              ← PM's cwd
    .claude/skills/                    ← PM skills only (symlinked from plugins/*/pm/)
      engineering/SKILL.md
      engineering-pr/SKILL.md
      marketing/SKILL.md
      campaign/SKILL.md
    knowledge.log                      ← Shared across all agents
    metadata.json                      ← Shared across all agents
  agents/
    copywriter/                        ← copywriter-agent's cwd
      .claude/skills/                  ← Agent craft skills only (symlinked from plugin)
        copywriting/SKILL.md
        brand-voice/SKILL.md
    analytics/                         ← analytics-agent's cwd
      .claude/skills/
        ...
  memory/                              ← Agent memory (existing)
  repos/                               ← Worktrees for repo agents (existing)
```

Each agent has its own workspace directory where it can create artifacts, write intermediate files, etc. Shared data (`knowledge.log`, `metadata.json`) lives in `shared/` and is accessible to all agents via absolute path or `additionalDirectories`.

### How PM discovers plugin skills

At task creation, the runtime:
1. Scans each registered plugin's `pm/` directory for SKILL.md subdirectories
2. Symlinks them into `sessions/task-{id}/shared/.claude/skills/`
3. PM discovers them naturally via `settingSources: ["project"]`

PM only sees orchestration skills from `pm/` directories — never agent craft skills.

### How plugin agents discover their skills

At agent spawn time, the spawner:
1. Creates the agent's workspace directory (`sessions/task-{id}/agents/{key}/`)
2. Symlinks the parent plugin's `skills/` entries into `agents/{key}/.claude/skills/`
3. Sets `cwd` to the agent's workspace
4. Agent discovers skills via `settingSources: ["project"]`

Each agent only sees its own plugin's craft skills — no cross-contamination with PM skills or other plugins.

### How repo agents discover skills

Repo agents use their repository (or worktree) as `cwd`. If a repo plugin has `skills/`, the spawner symlinks them into a `.claude/skills/` directory at the agent's `cwd`. Currently repo agents don't use skills, but the mechanism is ready.

## Deployment Model

This separation enables "Archie as a product":

```
archie-hq/                         ← Core repo (generic, deployable)
  src/                             ← Runtime, PM core, both agent spawners
  prompts/
    pm-agent-core.md               ← Domain-agnostic PM orchestrator
    agent-core.md                  ← Universal multi-agent protocol (all agents)
    repo-agent.md                  ← Repo track extension (git/worktree/edit mode)
    plugin-agent.md                ← Plugin track extension (lightweight)

plugins/                           ← Separate repo, mounted/symlinked/submodule
  engineering/
    .claude-plugin/plugin.json
    repo-config.json               ← Signals repo track, defines agents + repos
    pm/
      engineering/SKILL.md         ← PM: "how to orchestrate engineering tasks"
      engineering-pr/SKILL.md      ← PM: "how to manage PR lifecycle"
    agents/
      backend.md                   ← Optional: per-agent prompt overrides
      mobile.md
    skills/
      rails-patterns/SKILL.md     ← Agent: Rails-specific knowledge
  marketing/
    .claude-plugin/plugin.json
    pm/
      marketing/SKILL.md           ← PM: "how to orchestrate marketing tasks"
      campaign/SKILL.md            ← PM: "how to handle campaign flow"
    agents/
      copywriter.md                ← Agent: copywriter persona
    skills/
      copywriting/SKILL.md         ← Agent: copywriting expertise
      brand-voice/SKILL.md         ← Agent: brand guidelines
```

- **Bare Archie** (no plugins) = PM with no team, no skills. Infrastructure ready but idle.
- **Add engineering plugin** = PM gets backend/mobile agents, engineering skills. Repo-agent track activates. GitHub tools, webhooks, merge orchestrator all have configs to work with.
- **Add marketing plugin** = PM also gets copywriter/analytics agents, marketing skills. Plugin-agent track handles them.
- **Different company** = Swap engineering plugin (different repos, agents, expertise). Core Archie unchanged.

## Example: Adding a Marketing Domain

1. Create `plugins/marketing/.claude-plugin/plugin.json` with name and version
2. Write agent markdowns in `plugins/marketing/agents/` (copywriter.md, analytics.md)
3. Write PM orchestration skills in `plugins/marketing/pm/` (marketing workflow, campaign sub-flow)
4. Write agent craft skills in `plugins/marketing/skills/` (copywriting, brand voice)
5. Restart Archie — agents auto-discovered, PM sees expanded team with marketing skills available

No changes to any core Archie code.

## Example: Engineering Plugin for a Different Company

1. Create `plugins/engineering/repo-config.json` with their repos, agents, and GitHub org
2. Write PM skills for their workflow (might be similar or customized)
3. Deploy Archie with this plugin mounted
4. All engineering infrastructure activates with the new company's repos

## Migration Path from Current Architecture

The migration is incremental and non-breaking:

1. **Split `repo-agent.md` into `agent-core.md` + `repo-agent.md`** — Extract universal protocol into `agent-core.md`, keep repo-specific content in `repo-agent.md`. Create `plugin-agent.md` (thin). Update `spawnRepoAgent` to compose both layers.
2. **Move `repo-configs.ts` content to `plugins/engineering/repo-config.json`** — `repo-configs.ts` becomes a loader. All callers unchanged.
3. **Move PM skills to `plugins/engineering/pm/`** — Already partly done (`prompts/.claude/skills/engineering/`). Move to plugin location, update symlink logic.
4. **Build `plugin-loader.ts`** — Scans plugins at startup, registers repo configs and plugin agents.
5. **Build `plugin-agent.ts`** — Generic spawner using `agent-core.md` + `plugin-agent.md` + plugin's agent markdown.
6. **Update `task-runtime.ts`** — Add plugin agent spawning branch and queue initialization.
7. **Update PM prompt composition** — Include plugin agents in team roster.

Steps 1-3 can be done without building the plugin-agent track. Steps 4-7 add the generic plugin support.

## Future Considerations

### Edit Mode for Plugin Agents

If a plugin agent needs to create/modify files (e.g., a copywriter generating content), we could:
- Add Write/Edit to plugin agent's allowed tools (always-on, no gating)
- Or use the existing edit_allowed mechanism (requires user approval)
- Decision per-plugin via manifest configuration

### Plugin Hooks

Plugins could define hooks for pre/post tool validation (e.g., "never push to production branch", "validate copy against brand guidelines"). Would use the standard `hooks/` directory.

### Plugin MCP Servers

Plugins could declare MCP servers in `.mcp.json`. These could provide domain-specific actions:
- Marketing: `schedule_post`, `create_brief`, `pull_metrics`
- Design: `upload_asset`, `create_mockup`
- HR: `post_job`, `schedule_interview`

### Plugin Agent Workspace Types

For now, plugin agents work in the task's shared folder. Future workspace types could include:
- `git-repo` — For plugin agents that need repo access without full worktree management
- `cloud-storage` — For agents working with cloud files
- `api-only` — No filesystem, just MCP tools
