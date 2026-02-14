# MVP v7: Plugin Agent Track (Steps 4-7)

## Context

MVP v6 successfully moved all domain knowledge into `plugins/engineering/` — repo configs load from JSON, prompts use three layers, PM skills are symlinked from plugins, and all hardcoded agent names are gone. The system works identically but is now structurally ready for multi-domain plugins.

This phase adds **the generic plugin-agent track** — a lightweight agent spawner for domains that don't need git/worktree/GitHub infrastructure (e.g., marketing, analytics, design). A plugin without `repo-config.json` is a "generic plugin" and its agents use `spawnPluginAgent` instead of `spawnRepoAgent`.

## End State

```
archie-hq/
  prompts/
    agent-core.md              ← EXISTS (Layer 1, shared by all agents)
    repo-agent.md              ← EXISTS (Layer 2, repo track)
    plugin-agent.md            ← NEW (Layer 2, plugin track)
    pm-agent.md                ← EXISTS

  plugins/                     ← gitignored
    engineering/               ← EXISTS (repo plugin — has repo-config.json)
    marketing/                 ← NEW (example generic plugin — no repo-config.json)
      .claude-plugin/
        plugin.json
      pm/
        marketing/SKILL.md     ← PM orchestration skill for marketing
      agents/
        copywriter.md          ← Agent definition (frontmatter + body)
      skills/
        copywriting/SKILL.md   ← Agent craft skill

  src/
    agents/
      plugin-agent.ts          ← NEW: generic plugin agent spawner
      plugin-configs.ts        ← NEW: plugin agent config registry
      index.ts                 ← MODIFIED: export new modules
    system/
      plugin-loader.ts         ← MODIFIED: discover generic plugin agents
      task-runtime.ts          ← MODIFIED: route to spawnPluginAgent, init queues
      task-manager.ts          ← MODIFIED: namespace PM skill symlinks
    types/
      plugin-agent.ts          ← NEW: PluginAgentConfig type
      index.ts                 ← MODIFIED: re-export new type
    mcp/
      tools.ts                 ← MODIFIED: include plugin agents in send_message enum
```

## Collision Handling

### Agent name collisions (fail-fast)

If two plugins both define `agents/copywriter.md`, both would try to register `copywriter-agent`. We **fail-fast at startup** with a clear error:

```
Error: Duplicate agent ID "copywriter-agent" found in plugins "marketing" and "content".
Rename one of the agent files to avoid collision.
```

This is enforced in `plugin-configs.ts` during `buildPluginAgentConfigs()`. Also cross-checked against repo agent IDs from `getAllRepoAgentIds()` to prevent a generic plugin agent from shadowing a repo agent.

### PM skill name collisions (namespace with plugin prefix)

PM skills are symlinked as `{pluginName}-{skillName}` into the shared folder:

```
shared/.claude/skills/
  engineering-engineering/SKILL.md    ← from plugins/engineering/pm/engineering/
  engineering-engineering-pr/SKILL.md ← from plugins/engineering/pm/engineering-pr/
  marketing-marketing/SKILL.md       ← from plugins/marketing/pm/marketing/
```

This guarantees uniqueness across plugins. The SKILL.md `description` field (which PM sees for auto-loading) is unaffected — only the directory name changes.

**Impact on existing code**: `task-manager.ts` symlink logic changes from:
```typescript
// Before: symlink as skill name only
await symlink(join(plugin.pmSkillsDir!, entry.name), join(skillsTarget, entry.name));
// After: symlink as {pluginName}-{skillName}
await symlink(join(plugin.pmSkillsDir!, entry.name), join(skillsTarget, `${plugin.name}-${entry.name}`));
```

---

## Step-by-Step Implementation

### Step 1: Create `src/types/plugin-agent.ts`

New type for plugin agent configs (mirrors `RepoAgentConfig` pattern):

```typescript
export interface PluginAgentConfig {
  agentId: string;        // e.g., "copywriter-agent"
  key: string;            // e.g., "copywriter" (from filename)
  role: string;           // From frontmatter
  expertise: string;      // From frontmatter
  prompt: string;         // Markdown body (domain-specific instructions)
  model?: string;         // Optional model override from frontmatter
  pluginName: string;     // e.g., "marketing" (from plugin.json or dir name)
  pluginPath: string;     // Absolute path to plugin directory
  skillsPath?: string;    // Absolute path to plugin's skills/ dir (if exists)
}
```

Update `src/types/index.ts` to re-export.

---

### Step 2: Extend `src/system/plugin-loader.ts`

Currently only reads `repo-config.json` and `pm/` skills. Add:

- Scan `agents/*.md` files in plugins **that have no repo-config.json** (generic plugins)
- Parse frontmatter (role, expertise, model) and body (prompt) using `gray-matter`
- Check for `skills/` directory
- Store in `LoadedPlugin` (add `agents` and `skillsPath` fields)

**Changes to `LoadedPlugin` interface:**
```typescript
export interface LoadedPlugin {
  // ... existing fields ...
  /** Generic plugin agent definitions (only for plugins WITHOUT repo-config.json) */
  agents: PluginAgentDef[];
  /** Absolute path to skills/ directory (for agent craft skills) */
  skillsPath: string | null;
}

interface PluginAgentDef {
  key: string;       // filename without .md
  role: string;      // from frontmatter
  expertise: string; // from frontmatter
  model?: string;    // from frontmatter (optional)
  prompt: string;    // markdown body
}
```

**Defaults for existing plugins**: All `LoadedPlugin` objects get `agents: []` and `skillsPath: null` by default. Repo plugins (with `repo-config.json`) keep these defaults — their agents are handled by `repo-configs.ts`.

**Logic**: If `repo-config.json` exists → repo plugin (agents are handled by repo-configs.ts). If not → generic plugin → scan agents/*.md.

---

### Step 3: Create `src/agents/plugin-configs.ts`

Registry for generic plugin agents (mirrors `repo-configs.ts` pattern):

```typescript
import { getPlugins } from '../system/plugin-loader.js';
import type { PluginAgentConfig } from '../types/plugin-agent.js';

function buildPluginAgentConfigs(): PluginAgentConfig[] { ... }

const pluginAgentConfigs = buildPluginAgentConfigs();
// No fail-fast here — empty is valid (no generic plugins loaded)

export function getPluginAgentConfig(agentId: string): PluginAgentConfig | undefined { ... }
export function getAllPluginAgentConfigs(): PluginAgentConfig[] { ... }
export function getAllPluginAgentIds(): string[] { ... }
```

**Module init order**: `buildPluginAgentConfigs()` calls `getAllRepoAgentIds()` for cross-checking collisions. This means `repo-configs.ts` must be initialized first. Since both modules use top-level `const configs = build...()`, the import order matters. The collision cross-check import in `plugin-configs.ts` ensures `repo-configs.ts` initializes first (ES module evaluation order).

---

### Step 4: Create `prompts/plugin-agent.md` (Layer 2 track extension)

Lightweight counterpart to `repo-agent.md`. Content:

- Workspace description (agent works in a task workspace folder)
- Read-only mode explanation (Read, Glob, Grep, Skill tools)
- No git/worktree/edit-mode content
- Access to shared knowledge.log and metadata.json via additionalDirectories

Estimated size: ~20 lines.

---

### Step 5: Add `buildPeerList()` utility and update `src/agents/repo-agent.ts`

Currently `generateRepoAgentPrompt()` builds a peer list from `getAllRepoConfigs()` only — plugin agents are invisible to repo agents, and vice versa. Extract a shared utility:

```typescript
// In a new src/agents/peer-list.ts (or inline in both spawners):
import { getAllRepoConfigs } from './repo-configs.js';
import { getAllPluginAgentConfigs } from './plugin-configs.js';

export function buildPeerList(excludeAgentId: string): string {
  const repoPeers = getAllRepoConfigs()
    .filter(c => c.agentId !== excludeAgentId)
    .map(c => `- ${c.agentId}: ${c.role} (${c.repoKey} repository)`);

  const pluginPeers = getAllPluginAgentConfigs()
    .filter(c => c.agentId !== excludeAgentId)
    .map(c => `- ${c.agentId}: ${c.role} [${c.pluginName}]`);

  return [...repoPeers, ...pluginPeers].join('\n');
}
```

**Update `repo-agent.ts`**: Replace the inline peer list construction in `generateRepoAgentPrompt()` (lines 40-44) with `buildPeerList(config.agentId)`.

**Use in `plugin-agent.ts`**: Same `buildPeerList(config.agentId)` call when composing Layer 1 prompt.

---

### Step 6: Create `src/agents/plugin-agent.ts`

Generic agent spawner. Follows `spawnRepoAgent` pattern but much simpler:

- **Prompt composition**: agent-core.md (Layer 1) + plugin-agent.md (Layer 2) + agent markdown body (Layer 3)
- **Working directory**: `sessions/task-{id}/agents/{key}/` (created at spawn time)
- **Skills**: Plugin's `skills/` dirs symlinked into agent's `.claude/skills/`
- **Tools**: `send_message_to_agent`, `log_finding`, `Read`, `Glob`, `Grep`, `Skill` (read-only)
- **MCP server**: Reuses `createRepoAgentMcpServer` (same base tools: send_message + log_finding)
- **Session recovery**: Same retry-once pattern as repo-agent
- **No**: worktrees, git commands, Write/Edit tools, edit mode gating

**Key function:**
```typescript
export async function spawnPluginAgent(
  config: PluginAgentConfig,
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: BaseToolCallbacks,  // Plugin agents only need send_message + log_finding
  onSessionId: (sessionId: string) => void,
  existingSessionId?: string
): Promise<AgentHandle>
```

**SDK query options** (critical details):
- `settingSources: ["project"]` — required for Skill tool to discover skills in `.claude/skills/`
- `model`: `config.model || process.env.SONNET_MODEL || 'claude-sonnet-4-5-20250514'` — config override takes precedence, then env, then default
- `allowedTools`: `['Read', 'Glob', 'Grep', 'Skill']` — read-only, no Write/Edit/Bash

**Agent workspace setup at spawn time:**
1. Create `sessions/task-{id}/agents/{key}/`
2. Symlink plugin's `skills/*` into `agents/{key}/.claude/skills/`
3. Set `cwd` to agent workspace
4. Set `additionalDirectories` to include shared path

---

### Step 7: Update `src/system/task-runtime.ts`

**6a. Queue initialization** (`initializeTaskRuntime`):

```typescript
import { getAllPluginAgentConfigs } from '../agents/plugin-configs.js';

// Add after repo agent queue init:
for (const config of getAllPluginAgentConfigs()) {
  queues.set(config.agentId as AgentName, new MessageQueue());
}
```

**6b. Agent routing** (`ensureAgentSpawned`):

Add a third branch after the repo-agent check:

```typescript
const repoConfig = getRepoConfig(agentName);
if (repoConfig) {
  // ... existing repo agent spawn ...
} else if (agentName === "pm-agent") {
  // ... existing PM spawn ...
} else {
  // Check if it's a plugin agent
  const pluginConfig = getPluginAgentConfig(agentName);
  if (pluginConfig) {
    await addParticipant(runtime.taskId, agentName);
    const queue = runtime.queues.get(agentName);
    if (!queue) throw new Error(`${agentName} queue not initialized`);
    handle = await spawnPluginAgent(pluginConfig, metadata, queue, callbacks, onSessionId, existingSessionId);
    runtime.handles.set(agentName, handle);
  } else {
    throw new Error(`Unknown agent: ${agentName}`);
  }
}
```

---

### Step 8: Update `src/mcp/tools.ts`

Include plugin agents in the `send_message_to_agent` tool's agent enum:

```typescript
import { getAllPluginAgentIds } from '../agents/plugin-configs.js';

// In createSendMessageTool:
const allAgents = [
  'pm-agent',
  ...getAllRepoAgentIds(),
  ...getAllPluginAgentIds(),
] as [string, ...string[]];
```

Also update `createAssignTaskOwnerTool` — plugin agents can be task owners too:

```typescript
const taskOwnerAgents = [
  ...getAllRepoAgentIds(),
  ...getAllPluginAgentIds(),
] as [string, ...string[]];
```

---

### Step 9: Update PM team roster (`src/agents/pm.ts`)

Include plugin agents in the team list and expertise:

```typescript
import { getAllPluginAgentConfigs } from './plugin-configs.js';

async function generatePMSystemPrompt(): Promise<string> {
  const repoConfigs = getAllRepoConfigs();
  const pluginAgents = getAllPluginAgentConfigs();

  const teamList = [
    ...repoConfigs.map(c => `- ${c.agentId}: ${c.role}`),
    ...pluginAgents.map(a => `- ${a.agentId}: ${a.role}`),
  ].join("\n");

  const assignmentGuidelines = [
    ...repoConfigs.map(c => `- ${c.agentId}: ${c.expertise}`),
    ...pluginAgents.map(a => `- ${a.agentId}: ${a.expertise}`),
  ].join("\n");

  return loadPrompt("pm-agent", { TEAM_LIST: teamList, TEAM_EXPERTISE: assignmentGuidelines });
}
```

---

### Step 10: Update startup logging (`src/index.ts`)

Log plugin agents alongside repo agents:

```typescript
import { getAllPluginAgentConfigs } from './agents/plugin-configs.js';

// After repo agents:
for (const pa of getAllPluginAgentConfigs()) {
  logger.plain(`  ${pa.agentId} — ${pa.role} [${pa.pluginName}]`);
}
```

---

### Step 11: Update `src/agents/index.ts`

Add re-exports for the new modules:

```typescript
export { spawnPluginAgent } from './plugin-agent.js';
export { getPluginAgentConfig, getAllPluginAgentConfigs, getAllPluginAgentIds } from './plugin-configs.js';
export { buildPeerList } from './peer-list.js';
```

---

### Step 12: Create example marketing plugin

```
plugins/marketing/
  .claude-plugin/plugin.json       ← { "name": "marketing", "version": "1.0.0", ... }
  pm/marketing/SKILL.md            ← PM skill for marketing orchestration
  agents/copywriter.md             ← Copywriter agent definition
  skills/copywriting/SKILL.md      ← Agent craft skill
```

**`agents/copywriter.md`:**
```markdown
---
role: Senior copywriter. Expert in ad copy, landing pages, email campaigns.
expertise: Ad copy, landing pages, email campaigns, brand voice, A/B testing
---

# Copywriter Agent — Domain-Specific Instructions

When writing copy, always start with the value proposition...
```

**`pm/marketing/SKILL.md`:**
Marketing workflow skill for PM — how to orchestrate marketing tasks, what questions to ask, how to evaluate deliverables.

**`skills/copywriting/SKILL.md`:**
Copywriting craft skill — techniques, best practices, templates.

---

### Step 13: Update `src/system/task-manager.ts` — Namespace PM skill symlinks

Change the PM skill symlink logic to namespace with plugin name, preventing collisions:

```typescript
// Before:
await symlink(join(plugin.pmSkillsDir!, entry.name), join(skillsTarget, entry.name));

// After:
const namespacedName = `${plugin.name}-${entry.name}`;
await symlink(join(plugin.pmSkillsDir!, entry.name), join(skillsTarget, namespacedName));
```

Agent workspaces are created **at spawn time** in `spawnPluginAgent` (Step 6), not at task creation — avoids creating workspaces for agents that never get used.

**Breaking change note**: This namespacing changes the symlink directory names from `engineering/` to `engineering-engineering/`. Any existing active task sessions with old symlink names will still work (they're already resolved), but new tasks will use the namespaced format. No migration needed — sessions are ephemeral.

---

## Implementation Order

```
Phase A: Types and configs (foundation, no behavior changes)
─────────────────────────────────────────────────────────────
1. Create src/types/plugin-agent.ts + update types/index.ts
2. Extend src/system/plugin-loader.ts (add agent scanning for generic plugins)
3. Create src/agents/plugin-configs.ts (registry with collision detection)

Phase B: Prompts, peer list, and spawner
─────────────────────────────────────────────────────────────
4. Create prompts/plugin-agent.md (Layer 2 track extension)
5. Create src/agents/peer-list.ts + update src/agents/repo-agent.ts (cross-track peer discovery)
6. Create src/agents/plugin-agent.ts (spawner with workspace + skill symlinking)

Phase C: Wiring (connect everything)
─────────────────────────────────────────────────────────────
7. Update src/system/task-runtime.ts (queues + routing)
8. Update src/mcp/tools.ts (agent enums)
9. Update src/agents/pm.ts (team roster)
10. Update src/index.ts (startup logging)
11. Update src/agents/index.ts (re-exports)

Phase D: Collision handling + example plugin
─────────────────────────────────────────────────────────────
12. Create plugins/marketing/ example (plugin.json, agents, pm skills, agent skills)
13. Update src/system/task-manager.ts (namespace PM skill symlinks as {plugin}-{skill})
```

## Files Changed (Summary)

| File | Action | Phase |
|------|--------|-------|
| `src/types/plugin-agent.ts` | **NEW** | A |
| `src/types/index.ts` | Modified (add re-export) | A |
| `src/system/plugin-loader.ts` | Modified (scan generic agents + skills path) | A |
| `src/agents/plugin-configs.ts` | **NEW** | A |
| `prompts/plugin-agent.md` | **NEW** | B |
| `src/agents/peer-list.ts` | **NEW** (cross-track peer discovery) | B |
| `src/agents/repo-agent.ts` | Modified (use `buildPeerList()`) | B |
| `src/agents/plugin-agent.ts` | **NEW** | B |
| `src/system/task-runtime.ts` | Modified (queue init + routing) | C |
| `src/mcp/tools.ts` | Modified (agent enums) | C |
| `src/agents/pm.ts` | Modified (team roster) | C |
| `src/index.ts` | Modified (startup logging) | C |
| `src/agents/index.ts` | Modified (re-exports) | C |
| `plugins/marketing/*` | **NEW** (example plugin, gitignored) | D |
| `src/system/task-manager.ts` | Modified (namespace PM skill symlinks) | D |

## Key Reuse

- **`createRepoAgentMcpServer`** from `src/mcp/tools.ts` — reused for plugin agents (provides send_message + log_finding)
- **`createRecoverableInputGenerator`** from `src/system/message-queue.ts` — same session recovery pattern
- **`loadPrompt`** from `src/utils/prompt-loader.ts` — for Layer 1 and Layer 2
- **`gray-matter`** — already a dependency, used for parsing agent frontmatter
- **`processAgentEventForLogging`** from `src/system/logger.ts` — same logging pattern
- **`buildPeerList`** — new shared utility, used by both `repo-agent.ts` and `plugin-agent.ts`

## Verification

1. **Startup**: Run the system — should log both engineering repo agents AND marketing plugin agent(s)
2. **Queue init**: Verify `copywriter-agent` queue is created in `initializeTaskRuntime`
3. **PM roster**: Verify PM system prompt includes `copywriter-agent` in TEAM_LIST
4. **PM skills**: Verify `marketing-marketing/SKILL.md` and `engineering-engineering/SKILL.md` are symlinked into task shared folder (namespaced)
5. **Peer list**: Verify repo agents see plugin agents in their peer list and vice versa
6. **Agent spawning**: PM sends message to `copywriter-agent` → it should spawn via `spawnPluginAgent`
7. **Agent workspace**: Verify `sessions/task-{id}/agents/copywriter/` is created with `.claude/skills/copywriting/` symlinked
8. **Agent tools**: Verify copywriter-agent has Read/Glob/Grep/Skill + send_message + log_finding (no Write/Edit)
9. **Collision detection**: Adding a second plugin with `agents/backend.md` should fail at startup (conflicts with engineering's backend-agent)
10. **TypeScript**: `npx tsc --noEmit` passes

## Review Findings (incorporated)

The following issues were identified during architect + coder review and have been addressed in this plan:

1. **Missing peer list utility** — Repo agents only saw other repo agents; plugin agents would have no peers. Added Step 5 (`buildPeerList()` in `peer-list.ts`) to provide cross-track peer discovery for both agent types.

2. **Callback type** — Step 6 uses `BaseToolCallbacks` (not `RepoAgentToolCallbacks`). Plugin agents only need `onSendMessage` + `onLogFinding`. Using the base type keeps them decoupled from repo-specific concerns — if `RepoAgentToolCallbacks` gains repo-specific callbacks later, plugin agents won't be affected.

3. **Missing `settingSources: ["project"]`** — Required for the Skill tool to discover skills in `.claude/skills/`. Added to Step 6 SDK query options.

4. **Model override precedence** — Clarified: `config.model` (from frontmatter) → `process.env.SONNET_MODEL` → hardcoded default.

5. **Module init order** — `plugin-configs.ts` calls `getAllRepoAgentIds()` for collision cross-check. ES module evaluation order handles this naturally via import chain, but documented in Step 3.

6. **LoadedPlugin defaults** — Existing repo plugins need `agents: []` and `skillsPath: null` defaults. Documented in Step 2.

7. **PM skill namespacing is a minor breaking change** — Old sessions have non-namespaced symlinks. Documented as non-issue since sessions are ephemeral (Step 13).

8. **GitHub tools exclusion** — Confirmed: only `createSendMessageTool` and `createAssignTaskOwnerTool` need plugin agent IDs. The 9 GitHub tools derive `repoKey` from repo configs and correctly exclude plugin agents.
