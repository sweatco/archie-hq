> **Status: Partially implemented** — Plugin loader, repo-config.json loading, three-layer prompt composition, and PM skills are implemented. Plugin discovery works for the engineering plugin. Full dynamic discovery for arbitrary plugins is partially complete.

# MVP v6: Plugin Architecture Migration (Steps 1-3)

## Goal

Restructure Archie so all domain knowledge (agent configs, PM skills, agent prompt overrides) lives in a `plugins/engineering/` folder, while core infrastructure remains in `src/` and `prompts/`. The system must work identically after migration — same agents, same behavior — just with data sourced from the plugin structure.

**This phase covers steps 1-3 of the migration path from `docs/plugin-agent-architecture.md`. Steps 4-7 (plugin-loader discovery, generic plugin-agent spawner, task-runtime plugin branch, multi-plugin PM roster) are deferred.**

## Scope

| In scope | Out of scope |
|----------|-------------|
| Split `repo-agent.md` → `agent-core.md` + slimmed `repo-agent.md` | Generic plugin-agent spawner (`spawnPluginAgent`) |
| Create `plugins/engineering/` with repo-config.json, pm/ skills, agents/ | Plugin-loader discovery (`plugin-loader.ts`) |
| Make `repo-configs.ts` load from JSON file | Marketing or other non-engineering plugins |
| Wire PM to use `pm-agent-core.md` | New `plugin-agent.md` track extension prompt |
| Move PM skills from `prompts/.claude/skills/` → `plugins/engineering/pm/` | MCP server per-plugin |
| Update prompt composition to use layered approach | Plugin hooks or commands |
| Make `createTask()` dynamic (remove hardcoded backend/mobile paths) | |
| Add `plugins/` to `.gitignore` | |

## End State

```
archie-hq/
  prompts/
    agent-core.md              ← NEW: universal multi-agent protocol
    repo-agent.md              ← UNCHANGED (original preserved as reference)
    pm-agent.md                ← UNCHANGED (original preserved as reference)
    pm-agent-core.md           ← EXISTS (already written, now wired in)
    triage-agent.md            ← UNCHANGED
    .claude/skills/            ← UNCHANGED (kept for reference, no longer symlinked)

  plugins/                     ← NEW: gitignored, eventually cloned from separate repo
    engineering/
      .claude-plugin/
        plugin.json            ← Standard Claude plugin manifest
      repo-config.json         ← Agent configs (was hardcoded in repo-configs.ts)
      pm/                      ← PM orchestration skills
        engineering/
          SKILL.md             ← Moved from prompts/.claude/skills/engineering/
        engineering-pr/
          SKILL.md             ← Moved from prompts/.claude/skills/engineering-pr/
      agents/                  ← Per-agent prompt overrides (Layer 3, optional)
        backend.md
        mobile.md

  src/
    agents/
      repo-configs.ts          ← MODIFIED: registry loaded from JSON (same API)
      repo-agent.ts            ← MODIFIED: layered prompt composition
      pm.ts                    ← MODIFIED: uses pm-agent-core.md
    system/
      task-manager.ts          ← MODIFIED: dynamic createTask() + plugin skill symlinks
      event-handler.ts         ← MODIFIED: dynamic repo paths from registry
      server.ts                ← MODIFIED: dynamic ServerConfig
    index.ts                   ← MODIFIED: dynamic repo path loading
    utils/
      prompt-loader.ts         ← MODIFIED: support loading from arbitrary paths
```

## Step-by-Step Implementation

### Step 1: Create `plugins/engineering/` directory structure

Create the engineering plugin with all content extracted from current sources.

#### 1a. `plugins/engineering/.claude-plugin/plugin.json`

```json
{
  "name": "engineering",
  "version": "1.0.0",
  "description": "Engineering agents and workflows for Archie"
}
```

#### 1b. `plugins/engineering/repo-config.json`

Extracted from hardcoded `src/agents/repo-configs.ts` (lines 10-31). Uses object-key convention from the design doc:

```json
{
  "backend": {
    "role": "Senior Ruby on Rails engineer. Expert in APIs, databases, authentication, background jobs.",
    "expertise": "APIs, databases, business logic, infrastructure, Ruby on Rails best practices, database queries and optimization, authentication and authorization, background jobs and queues",
    "githubRepo": "sweatco/sweatcoin-backend",
    "baseBranch": "master",
    "repoPath": "/repos/backend"
  },
  "mobile": {
    "role": "Senior React Native engineer with Swift/Kotlin expertise. Expert in mobile UI/UX, deep linking, push notifications.",
    "expertise": "React Native, Swift for iOS native modules, Kotlin for Android native modules, iOS and Android platform specifics, mobile UI/UX patterns, deep linking and push notifications, app store deployment, mobile performance optimization, network handling and offline support",
    "githubRepo": "sweatco/sweatcoin-mobile",
    "baseBranch": "main",
    "repoPath": "/repos/mobile"
  }
}
```

**Derivation at load time** (done in `repo-configs.ts`):
- Object key `"backend"` → `repoKey = "backend"`, `agentId = "backend-agent"`
- `repoPath` → `defaultRepoPath` (falls back to `${ARCHIE_REPOS_DIR || '/repos'}/${key}`)

#### 1c. `plugins/engineering/pm/engineering/SKILL.md`

Copy of `prompts/.claude/skills/engineering/SKILL.md` (unchanged content).

#### 1d. `plugins/engineering/pm/engineering-pr/SKILL.md`

Copy of `prompts/.claude/skills/engineering-pr/SKILL.md` (unchanged content).

#### 1e. `plugins/engineering/agents/backend.md` (optional, Layer 3)

```markdown
---
role: Senior Ruby on Rails engineer. Expert in APIs, databases, authentication, background jobs.
expertise: APIs, databases, business logic, infrastructure, Ruby on Rails best practices, database queries and optimization, authentication and authorization, background jobs and queues
---

# Backend Agent — Domain-Specific Instructions

(Currently empty — role and expertise from repo-config.json are sufficient for Layer 1 interpolation. This file is a placeholder for future per-agent domain knowledge.)
```

#### 1f. `plugins/engineering/agents/mobile.md` (optional, Layer 3)

Same pattern as backend.md but with mobile role/expertise.

---

### Step 2: Create `prompts/agent-core.md` (new prompt)

Extract universal multi-agent protocol from current `repo-agent.md`. This prompt is used by ALL agents (repo and plugin).

**Content mapping from current `repo-agent.md`:**

| Current repo-agent.md section | Lines | Destination |
|------------------------------|-------|-------------|
| Identity (agent ID, role, expertise) | 1-4, 7 | agent-core.md |
| Peer agents section | 9-16 | agent-core.md |
| Repo responsibility ("responsible for {{REPO_KEY}}") | 5 | stays in repo-agent.md |
| Mission ("investigate and/or modify code") | 18-20 | stays in repo-agent.md |
| Task Lifecycle Context | 22-31 | stays in repo-agent.md |
| Dual Role System (Task Owner/Participant) | 35-43 | agent-core.md |
| Dual Mode System (Read-Only/Edit) | 45-51 | stays in repo-agent.md |
| Communication Tools | 53-56 | agent-core.md |
| Git Workflow (edit mode) | 58-93 | stays in repo-agent.md |
| Coordination Strategies | 95-108 | agent-core.md |
| Critical Stopping Points | 110-122 | agent-core.md |
| Workflow (establish context, analyze, work, report) | 124-179 | agent-core.md |
| Example Response Structure | 181-204 | agent-core.md |
| Key Principles | 206-217 | agent-core.md |

**Template variables**: `{{AGENT_ID}}`, `{{AGENT_ROLE}}`, `{{EXPERTISE}}`, `{{PEER_LIST}}`

**Estimated size**: ~150 lines (universal protocol)

The new `agent-core.md` should include a generic mission statement like:
> You are a specialized agent in a multi-agent collaborative system. You receive work from pm-agent and other agents, perform your specialized tasks, and report findings.

The track-specific mission (investigate/modify code in a repository) stays in `repo-agent.md`.

---

### Step 3: Slim down the repo-agent prompt (new version)

Create a new version of the repo-agent prompt containing ONLY repo-specific content. This becomes Layer 2 for repo agents.

**Content** (all from current `repo-agent.md`):
- Line 5: Repo responsibility (`{{REPO_KEY}}`)
- Lines 18-31: Mission + task lifecycle (research → implement → review → conflicts)
- Lines 45-51: Dual mode system (read-only vs edit, tool-based detection)
- Lines 58-93: Git workflow (commands, making changes, resolving conflicts, restrictions)

**Template variables**: `{{REPO_KEY}}`, `{{BASE_BRANCH}}`

**Estimated size**: ~60 lines

**Important**: The original `prompts/repo-agent.md` stays untouched. The new slimmed version is a separate file. Options for naming:
- `prompts/repo-agent-ext.md` (extension)
- Or compose it inline in `repo-agent.ts` without a separate file

**Recommendation**: Use `prompts/repo-agent-ext.md` to keep it as a loadable template.

---

### Step 4: Update `src/utils/prompt-loader.ts`

Currently, `loadPrompt()` only reads from the `prompts/` directory:

```typescript
const PROMPTS_DIR = join(__dirname, '..', '..', 'prompts');

export async function loadPrompt(templateName: string, variables: Record<string, string>): Promise<string> {
  const templatePath = join(PROMPTS_DIR, `${templateName}.md`);
  // ...
}
```

**Change**: Add an overload (or new function) to load from an absolute path:

```typescript
/**
 * Load a prompt template from an absolute file path and interpolate variables
 */
export async function loadPromptFromPath(
  absolutePath: string,
  variables: Record<string, string> = {}
): Promise<string> {
  let template = await readFile(absolutePath, 'utf-8');
  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`{{${key}}}`, 'g');
    template = template.replace(pattern, value);
  }
  return template;
}
```

This is needed for loading plugin agent overrides (Layer 3) from `plugins/engineering/agents/backend.md`.

---

### Step 5: Update `src/agents/repo-configs.ts`

Transform from hardcoded array to a registry that loads from `plugins/engineering/repo-config.json`.

**Before** (current):
```typescript
export const repoConfigs: RepoAgentConfig[] = [
  { agentId: 'backend-agent', repoKey: 'backend', ... },
  { agentId: 'mobile-agent', repoKey: 'mobile', ... },
];
```

**After**:
```typescript
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { RepoAgentConfig } from '../types/repo-agent.js';

const PLUGINS_DIR = join(process.cwd(), process.env.ARCHIE_PLUGINS_DIR || 'plugins');

// Registry — populated at load time from plugins
let repoConfigs: RepoAgentConfig[] = [];

/**
 * Load repo configs from all plugins that have repo-config.json
 * Called once at module load time (synchronous for simplicity)
 */
function loadRepoConfigsFromPlugins(): RepoAgentConfig[] {
  const configs: RepoAgentConfig[] = [];
  const engineeringPlugin = join(PLUGINS_DIR, 'engineering');
  const configPath = join(engineeringPlugin, 'repo-config.json');

  if (!existsSync(configPath)) {
    // Fallback: no plugin found, return empty (or could throw)
    return configs;
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

  for (const [key, value] of Object.entries(raw)) {
    const config = value as any;
    configs.push({
      agentId: `${key}-agent`,
      repoKey: key,
      defaultRepoPath: config.repoPath || join(process.env.ARCHIE_REPOS_DIR || '/repos', key),
      role: config.role,
      expertise: config.expertise,
      githubRepo: config.githubRepo,
      baseBranch: config.baseBranch,
    });
  }

  return configs;
}

// Load at module initialization
repoConfigs = loadRepoConfigsFromPlugins();

// ALL EXISTING FUNCTIONS UNCHANGED — same signatures, same behavior
export function getRepoConfig(agentId: string): RepoAgentConfig | undefined { ... }
export function getAllRepoConfigs(): RepoAgentConfig[] { ... }
export function getAllRepoAgentIds(): string[] { ... }
export function getRepoConfigByGithubRepo(githubRepo: string): RepoAgentConfig | undefined { ... }
```

**Key points**:
- Uses sync `readFileSync` at module load time for simplicity (runs once at startup)
- **Must fail-fast** if no configs loaded — empty array causes `z.enum()` crash in `mcp/tools.ts`
- All 4 exported functions keep exact same signatures
- All callers across the codebase work unchanged
- For now, hardcoded to read `plugins/engineering/repo-config.json`. In the future (steps 4-7), the plugin-loader will scan all plugin directories

**Add startup validation**:
```typescript
repoConfigs = loadRepoConfigsFromPlugins();
if (repoConfigs.length === 0) {
  throw new Error(
    'No repo configs loaded. Ensure plugins/engineering/repo-config.json exists. ' +
    'Set ARCHIE_PLUGINS_DIR if plugins are in a non-default location.'
  );
}
```

**Callers that need NO changes** (they use the existing API):
| File | Functions used |
|------|---------------|
| `src/agents/repo-agent.ts` | `getAllRepoConfigs()` |
| `src/agents/pm.ts` | `getAllRepoConfigs()` |
| `src/agents/index.ts` | re-exports all |
| `src/system/task-runtime.ts` | `getRepoConfig()`, `getAllRepoConfigs()` |
| `src/system/task-manager.ts` | `getAllRepoConfigs()` (dynamic import) |
| `src/system/server.ts` | `getRepoConfigByGithubRepo()` |
| `src/system/event-handler.ts` | `getRepoConfigByGithubRepo()` |
| `src/github/merge-orchestrator.ts` | `getRepoConfig()` |
| `src/mcp/tools.ts` | `getAllRepoAgentIds()` (×11 usages for tool enums) |

---

### Step 6: Update `src/agents/repo-agent.ts` — Layered prompt composition

**Before** (current, lines 37-54):
```typescript
async function generateRepoAgentPrompt(config: RepoAgentConfig): Promise<string> {
  const peerList = getAllRepoConfigs()
    .filter(c => c.agentId !== config.agentId)
    .map(c => `- ${c.agentId}: ${c.role} (${c.repoKey} repository)`)
    .join("\n");

  return loadPrompt("repo-agent", {
    AGENT_ID: config.agentId,
    AGENT_ROLE: config.role,
    REPO_KEY: config.repoKey,
    EXPERTISE: config.expertise,
    PEER_LIST: peerList,
    BASE_BRANCH: config.baseBranch || "main",
  });
}
```

**After**:
```typescript
async function generateRepoAgentPrompt(config: RepoAgentConfig): Promise<string> {
  const peerList = getAllRepoConfigs()
    .filter(c => c.agentId !== config.agentId)
    .map(c => `- ${c.agentId}: ${c.role} (${c.repoKey} repository)`)
    .join("\n");

  // Layer 1: Universal multi-agent protocol
  const corePrompt = await loadPrompt("agent-core", {
    AGENT_ID: config.agentId,
    AGENT_ROLE: config.role,
    EXPERTISE: config.expertise,
    PEER_LIST: peerList,
  });

  // Layer 2: Repo-agent track extension
  const repoPrompt = await loadPrompt("repo-agent-ext", {
    REPO_KEY: config.repoKey,
    BASE_BRANCH: config.baseBranch || "main",
  });

  // Layer 3: Plugin agent override (optional)
  // For now, no Layer 3 content. Future: load from plugins/engineering/agents/{repoKey}.md

  return [corePrompt, repoPrompt].join("\n\n");
}
```

**Changes**:
- Two `loadPrompt` calls instead of one
- Uses `agent-core` and `repo-agent-ext` templates
- Template variables split between the two layers
- Rest of `spawnRepoAgent` function is UNCHANGED

---

### Step 7: Update `src/agents/pm.ts` — Use `pm-agent-core.md`

**Before** (current, lines 25-38):
```typescript
async function generatePMSystemPrompt(): Promise<string> {
  const repoConfigs = getAllRepoConfigs();
  const teamList = repoConfigs.map(c => `- ${c.agentId}: ${c.role}`).join("\n");
  const assignmentGuidelines = repoConfigs.map(c => `- ${c.agentId}: ${c.expertise}`).join("\n");
  return loadPrompt("pm-agent", {
    TEAM_LIST: teamList,
    TEAM_EXPERTISE: assignmentGuidelines,
  });
}
```

**After**:
```typescript
async function generatePMSystemPrompt(): Promise<string> {
  const repoConfigs = getAllRepoConfigs();
  const teamList = repoConfigs.map(c => `- ${c.agentId}: ${c.role}`).join("\n");
  const teamExpertise = repoConfigs.map(c => `- ${c.agentId}: ${c.expertise}`).join("\n");
  return loadPrompt("pm-agent-core", {
    TEAM_LIST: teamList,
    TEAM_EXPERTISE: teamExpertise,
  });
}
```

**Change**: `"pm-agent"` → `"pm-agent-core"`. The new domain-agnostic PM prompt. Everything else unchanged.

Note: `pm-agent-core.md` already exists and uses the same `{{TEAM_LIST}}` and `{{TEAM_EXPERTISE}}` template variables.

---

### Step 8: Update `src/system/task-manager.ts` — Skill symlinking

**Before** (current, lines 157-162):
```typescript
// Symlink .claude from prompts so PM agent discovers skills
const claudeDir = join(process.cwd(), 'prompts', '.claude');
const symlinkPath = join(sharedPath, '.claude');
if (existsSync(claudeDir) && !existsSync(symlinkPath)) {
  await symlink(claudeDir, symlinkPath);
}
```

**After**:
```typescript
// Symlink PM skills from plugin directories into task shared folder
const skillsTarget = join(sharedPath, '.claude', 'skills');
await mkdir(join(sharedPath, '.claude'), { recursive: true });

const pluginsDir = join(process.cwd(), process.env.ARCHIE_PLUGINS_DIR || 'plugins');
const engineeringPmSkills = join(pluginsDir, 'engineering', 'pm');

if (existsSync(engineeringPmSkills)) {
  // Symlink each skill subdirectory individually
  const { readdir: readdirAsync } = await import('fs/promises');
  for (const entry of await readdirAsync(engineeringPmSkills, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const target = join(skillsTarget, entry.name);
      if (!existsSync(target)) {
        await mkdir(skillsTarget, { recursive: true });
        await symlink(join(engineeringPmSkills, entry.name), target);
      }
    }
  }
}
```

**What changes**:
- Instead of symlinking the entire `prompts/.claude/` directory, we symlink individual skill directories from `plugins/engineering/pm/`
- This creates `shared/.claude/skills/engineering/` → `plugins/engineering/pm/engineering/`
- PM agent discovers them via `settingSources: ["project"]` exactly as before
- In future phases, this loop will also process other plugins' `pm/` directories

---

### Step 9: Make `createTask()` dynamic (remove hardcoded repo paths)

**This is the deepest structural coupling** in the codebase. Currently, `backendRepoPath` and `mobileRepoPath` are threaded through 4 files as explicit parameters:

```
src/index.ts (env vars) → src/system/server.ts (ServerConfig) → src/system/event-handler.ts (setRepoPaths) → src/system/task-manager.ts (createTask)
```

#### 9a. `src/system/task-manager.ts` — Dynamic `createTask()`

**Before** (current, lines 143-178):
```typescript
export async function createTask(
  slackThread: SlackThread,
  backendRepoPath: string,
  mobileRepoPath: string
): Promise<TaskMetadata> {
  // ...
  const metadata: TaskMetadata = {
    // ...
    repositories: {
      backend: { path: backendRepoPath },
      mobile: { path: mobileRepoPath },
    },
  };
}
```

**After**:
```typescript
import { getAllRepoConfigs } from '../agents/repo-configs.js';

export async function createTask(
  slackThread: SlackThread
): Promise<TaskMetadata> {
  // Build repositories map dynamically from loaded repo configs
  const repositories: Record<string, { path: string }> = {};
  for (const config of getAllRepoConfigs()) {
    repositories[config.repoKey] = { path: config.defaultRepoPath };
  }

  const metadata: TaskMetadata = {
    // ...
    repositories,
  };
}
```

**Key change**: No more explicit repo path parameters. `createTask()` reads from the registry.

#### 9b. `src/system/event-handler.ts` — Remove `setRepoPaths()`

**Before** (current):
```typescript
let backendRepoPath = process.env.BACKEND_REPO_PATH || '/repos/backend';
let mobileRepoPath = process.env.MOBILE_REPO_PATH || '/repos/mobile';

export function setRepoPaths(backend: string, mobile: string): void {
  backendRepoPath = backend;
  mobileRepoPath = mobile;
}

// In createNewTask():
await createTask(slackThread, backendRepoPath, mobileRepoPath);
```

**After**:
```typescript
// Remove setRepoPaths entirely — paths come from repo-configs registry
// In createNewTask():
await createTask(slackThread);
```

#### 9c. `src/system/server.ts` — Simplify ServerConfig

**Before**:
```typescript
interface ServerConfig {
  backendRepoPath: string;
  mobileRepoPath: string;
  // ... other fields
}
// Passes repo paths to event-handler and configures git identity per repo
```

**After**:
```typescript
// Remove backendRepoPath/mobileRepoPath from ServerConfig
// Use getAllRepoConfigs() for git identity configuration:
for (const config of getAllRepoConfigs()) {
  configureGitIdentity(config.defaultRepoPath);
}
```

#### 9d. `src/index.ts` — Remove individual env vars

**Before**:
```typescript
const backendRepoPath = process.env.BACKEND_REPO_PATH || '/repos/backend';
const mobileRepoPath = process.env.MOBILE_REPO_PATH || '/repos/mobile';
```

**After**: Remove these. Repo paths come from `repo-config.json` via the registry. Environment variable overrides can use `ARCHIE_REPOS_DIR` (base directory) or per-repo `repoPath` in the JSON.

**Note**: If per-repo env var overrides are still needed, the JSON loader in `repo-configs.ts` can check for `REPO_PATH_${key.toUpperCase()}` env vars as overrides for the JSON values.

---

### Step 10: Add `plugins/` to `.gitignore`

Append to `.gitignore`:
```
# Plugin configurations (cloned from separate repo)
plugins/
```

---

### Step 11: Fix hardcoded agent names in `src/system/active-tasks.ts`

**This was missed in the original plan.** The `getAgentStatus()` function has hardcoded `backend-agent`/`mobile-agent`:

**Before** (current, lines 79-90):
```typescript
export function getAgentStatus(taskId: string): Record<string, boolean> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    return { pm: false, backend: false, mobile: false };
  }
  return {
    pm: runtime.handles.get('pm-agent')?.isRunning ?? false,
    backend: runtime.handles.get('backend-agent')?.isRunning ?? false,
    mobile: runtime.handles.get('mobile-agent')?.isRunning ?? false,
  };
}
```

**After**:
```typescript
export function getAgentStatus(taskId: string): Record<string, boolean> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    return {};
  }
  const status: Record<string, boolean> = {};
  for (const [agentName, handle] of runtime.handles) {
    status[agentName] = handle.isRunning;
  }
  return status;
}
```

---

### Step 12: Clean up hardcoded type assertion in `task-runtime.ts`

**Line 139** has an unnecessary hardcoded type assertion:

**Before**:
```typescript
const targetQueue = runtime.queues.get(
  target as "pm-agent" | "backend-agent" | "mobile-agent"
);
```

**After**:
```typescript
const targetQueue = runtime.queues.get(target);
```

The `queues` Map is `Map<AgentName, MessageQueue>` and `target` is `AgentName`. The cast is unnecessary and misleading.

---

### Step 13: Update `src/agents/index.ts` re-exports

**Before**:
```typescript
export { repoConfigs, getRepoConfig, getAllRepoConfigs, getAllRepoAgentIds } from './repo-configs.js';
```

**After**:
```typescript
export { getRepoConfig, getAllRepoConfigs, getAllRepoAgentIds } from './repo-configs.js';
```

Remove `repoConfigs` from re-export since it's no longer a const export (it's a module-scoped `let`). All callers use the functions, not the raw array. Verify no external code imports `repoConfigs` directly.

---

## Prompt Split: Detailed Gaps to Address

The architect identified these specific areas where current `repo-agent.md` content needs generalization when moving to `agent-core.md`:

### Gap 1: Repo-specific language in identity block
- **Line 5**: "You are responsible for the {{REPO_KEY}} repository" — this is repo-specific, must stay in `repo-agent-ext.md`
- **Lines 18-20**: "investigate and/or modify code in your assigned repository" — repo-specific mission, stays in `repo-agent-ext.md`
- `agent-core.md` gets a generic mission: "You perform your assigned work and collaborate with other agents."

### Gap 2: Mode Determination in thinking framework
- **Lines 144-149**: Asks agent to check for Write/Edit tools to determine Edit vs Read-Only mode. This is repo-specific.
- `agent-core.md` should generalize to "Capability Assessment": "List available tools, determine your operating capabilities"
- `repo-agent-ext.md` adds specific mapping: Write/Edit available → Edit Mode, otherwise → Read-Only Mode

### Gap 3: Repository language in Work Analysis
- **Line 155**: "Break down what needs to be done in which repository" — repo-centric
- `agent-core.md` should say: "Break down what needs to be done and by whom"

### Gap 4: `request_edit_mode` in pm-agent-core.md
- `pm-agent-core.md` line 100 lists `request_edit_mode` as a Turn-Ending Tool
- This is engineering-specific but **keep it in core** — it's PM infrastructure, not domain knowledge. Unused if no engineering plugin, doesn't confuse the model.

### Gap 5: PM prompt coverage is complete
- `pm-agent-core.md` + `engineering/SKILL.md` + `engineering-pr/SKILL.md` fully cover everything in `pm-agent.md`
- The split is clean: core has generic orchestration, skills have engineering-specific workflows
- Original `pm-agent.md` can be retired once the new system is wired in

---

## Implementation Order

```
Phase A: New files (no code changes, safe to do first)
──────────────────────────────────────────────────────
1. Create plugins/engineering/ directory structure
   - .claude-plugin/plugin.json
   - repo-config.json
   - pm/engineering/SKILL.md
   - pm/engineering-pr/SKILL.md
   - agents/backend.md (placeholder)
   - agents/mobile.md (placeholder)

2. Create prompts/agent-core.md
   - Extract universal protocol from repo-agent.md
   - Generalize 3 repo-specific sections (see gaps above)

3. Create prompts/repo-agent-ext.md
   - Repo-specific content from repo-agent.md
   - Add mode determination elaboration

Phase B: Core infrastructure changes (critical path)
──────────────────────────────────────────────────────
4. Update src/utils/prompt-loader.ts         [add loadPromptFromPath]

5. Update src/agents/repo-configs.ts         [load from JSON, fail-fast validation]
   ↓ All callers verified: no API changes needed

6. Update src/agents/index.ts                [remove repoConfigs export]

Phase C: Prompt wiring
──────────────────────────────────────────────────────
7. Update src/agents/repo-agent.ts           [layered prompt composition]

8. Update src/agents/pm.ts                   [pm-agent → pm-agent-core]

Phase D: Dynamic repo paths (deepest structural change)
──────────────────────────────────────────────────────
⚠️  ALL Phase D changes MUST be committed atomically — createTask() signature
    change breaks the call site in event-handler.ts.

9.  Update src/system/task-manager.ts        [dynamic createTask + skill symlinks]
10. Update src/system/event-handler.ts       [remove setRepoPaths]
11. Update src/system/server.ts              [simplify ServerConfig]
12. Update src/index.ts                      [remove individual env vars]

Phase E: Hardcoded agent name cleanup
──────────────────────────────────────────────────────
13. Fix src/system/active-tasks.ts           [dynamic getAgentStatus]
14. Fix src/system/task-runtime.ts:139       [remove hardcoded type assertion]
15. Note: src/system/logger.ts               [hardcoded AGENT_COLORS — has fallback, low priority]

Phase F: Finalize
──────────────────────────────────────────────────────
16. Add plugins/ to .gitignore
17. Add env var deprecation warning for BACKEND_REPO_PATH / MOBILE_REPO_PATH
```

Phase A is safe (new files only). Phase B is the riskiest (changes data source) but preserves the same API — includes fail-fast validation to prevent empty-config crashes. Phase C updates prompt composition. Phase D is the deepest structural change — all 4 files must change together. Phase E cleans up hardcoded agent name assumptions found by review. Phase F is finalization.

## Verification

After migration, verify:

1. **Agent spawning**: `spawnRepoAgent` works for both backend and mobile agents
2. **Prompt content**: Generated prompts contain all expected sections (agent-core + repo-specific)
3. **PM system prompt**: Uses `pm-agent-core.md`, includes correct team roster
4. **PM skills**: Skills are discoverable by PM agent in task shared folder
5. **Tool enums**: `send_message_to_agent` shows correct agent list, all GitHub tools show correct repo keys
6. **Webhook routing**: `findTaskByPRNumber` still resolves correctly

**Quick smoke test**: Start the system, create a task via Slack, verify PM acknowledges and can delegate to backend-agent. Verify the engineering skill is loadable.

## Complete File Change Map

All files that need changes and their status:

| File | Change | Phase |
|------|--------|-------|
| `src/agents/repo-configs.ts` | Rewrite as JSON-loading registry + fail-fast validation | B |
| `src/agents/index.ts` | Remove `repoConfigs` const export | B |
| `src/utils/prompt-loader.ts` | Add `loadPromptFromPath` function | B |
| `src/agents/repo-agent.ts` | Layered prompt composition (agent-core + repo-agent-ext) | C |
| `src/agents/pm.ts` | Switch to pm-agent-core.md | C |
| `src/system/task-manager.ts` | Dynamic `createTask()` + plugin skill symlinks | D |
| `src/system/event-handler.ts` | Remove `setRepoPaths`, use registry | D |
| `src/system/server.ts` | Simplify ServerConfig, dynamic git identity | D |
| `src/index.ts` | Remove hardcoded repo paths, add env var deprecation warning | D |
| `src/system/active-tasks.ts` | Dynamic `getAgentStatus()` (was hardcoded backend/mobile) | E |
| `src/system/task-runtime.ts:139` | Remove unnecessary hardcoded type assertion | E |

**Files needing NO changes** (already fully dynamic):

| File | Functions used | Why safe |
|------|---------------|----------|
| `src/mcp/tools.ts` | `getAllRepoAgentIds()` ×11 | All enums built from function calls at tool-creation time |
| `src/system/task-runtime.ts` (rest of file) | `getRepoConfig()`, `getAllRepoConfigs()` | Dynamic lookups, queue init loops over configs |
| `src/github/merge-orchestrator.ts` | `getRepoConfig()` | Dynamic lookup by agentId |

**Low priority** (has fallback, cosmetic):
| File | Issue |
|------|-------|
| `src/system/logger.ts` | Hardcoded `AGENT_COLORS` for backend-agent/mobile-agent. Has fallback to `pc.green` for unknown agents. Fix when convenient. |

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Empty config crash**: If `plugins/` missing, `getAllRepoAgentIds()` returns `[]` → `z.enum()` in mcp/tools.ts crashes at MCP server creation | Critical | Fail-fast in `repo-configs.ts`: throw at startup if no configs loaded |
| **Phase D atomicity**: `createTask()` signature change breaks event-handler.ts | High | All 4 Phase D files must be committed in one atomic commit |
| **Symlink discovery**: Changing from single directory symlink to per-skill symlinks may break Claude's `settingSources: ["project"]` discovery | Medium | Test: verify `ls -la shared/.claude/skills/engineering/SKILL.md` resolves through symlink chain |
| JSON parsing failure at startup | Medium | Validate JSON schema. Throw with clear error message including expected path. |
| Field derivation mismatch | Medium | Unit test: JSON loading produces identical `RepoAgentConfig[]` to hardcoded version |
| Env var backwards compat | Low | Log deprecation warning if `BACKEND_REPO_PATH`/`MOBILE_REPO_PATH` detected at startup |
| `repoConfigs` direct import | Low | Verified: no caller imports the raw array (only functions). Remove from index.ts export. |
| Prompt generalization loss | Low | Diff concatenated output (agent-core + repo-agent-ext) against original repo-agent.md to verify no content lost |
| PM skill loading timing | Low | PM proactively loads engineering skill when encountering engineering tasks. If PM doesn't load skill before a PR event, it has no GitHub workflow guidance. Mitigation: engineering SKILL.md description is clear enough for PM to auto-load. |

## What's Deferred (Next Phase: Steps 4-7)

- `plugin-loader.ts` — Generic plugin discovery (scan all plugin dirs, not just engineering)
- `plugin-agent.ts` — Generic agent spawner for non-repo domains
- `plugin-agent.md` — Lightweight track extension prompt
- Multi-plugin PM roster (include plugin agents alongside repo agents)
- Plugin agent queue initialization in task-runtime.ts
- Marketing/other domain plugins
