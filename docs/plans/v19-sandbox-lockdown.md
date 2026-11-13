# Sandbox Lockdown: OS-level + Hook-based Filesystem/Network Enforcement

> **Historical record — filing review 2026-11-11.** Current documentation: [Security](../architecture/security.md). Original design and verification claims below describe their recorded revision; they are not current implementation instructions.

## Context

Agents currently run with `permissionMode: 'dontAsk'` and rely on `allowedTools` allowlists to gate access. This has several weaknesses:
- No OS-level filesystem isolation — agents can read anything via Read/Glob/Grep
- No network restrictions — Bash can `curl` freely
- Brittle `Bash(git log*)` pattern enumeration for repo agents
- `dontAsk` denies non-listed tools but doesn't truly sandbox

The goal: lock agents down with defense-in-depth — OS-level sandbox for Bash, PreToolUse hooks for in-process tools, network deny-all, and a simpler denylist-based tool model.

## Scope

This change covers the main agent spawner (`spawn.ts`) only. Research sub-agents (`research-tools.ts`) and triage (`triage.ts`) are out of scope for now.

## Files to Change

| File | Action |
|------|--------|
| `src/agents/sandbox.ts` | **NEW** — sandbox config builder + PreToolUse guard hooks |
| `src/agents/spawn.ts` | **MODIFY** — bypassPermissions, disallowedTools, sandbox integration |
| `src/system/workdir.ts` | **MODIFY** — add `PLUGINS_DATA_DIR` constant |
| `src/types/agent.ts` | **MODIFY** — add `pluginDataPath` to `AgentDef` |
| `src/agents/registry.ts` | **MODIFY** — set `pluginDataPath` on all agent defs |

---

## Step 1: Create `src/agents/sandbox.ts`

New module with two exports:

### `SandboxOptions` interface
```typescript
export interface SandboxOptions {
  cwd: string;
  allowReadPaths: string[];
  allowWritePaths: string[];       // empty = read-only
  denyWritePaths?: string[];       // e.g., [cwd/.claude]
  allowedNetworkDomains?: string[]; // empty = deny all (default)
}
```

### `buildSandboxConfig(opts: SandboxOptions)`

Returns SDK `sandbox` object:
- `enabled: true`
- `allowUnsandboxedCommands: false` — blocks `dangerouslyDisableSandbox` bypass
- `autoAllowBashIfSandboxed: true` — Bash auto-approved when sandboxed
- `filesystem.denyRead: ['/']` — deny everything
- `filesystem.allowRead: [cwd, ...allowReadPaths]` — poke holes
- `filesystem.allowWrite: allowWritePaths`
- `filesystem.denyWrite: denyWritePaths` (if non-empty)
- `network.allowedDomains: allowedNetworkDomains ?? []`

### `createFilesystemGuardHooks(opts: SandboxOptions): HookCallbackMatcher[]`

Returns a single `PreToolUse` hook matcher (no `matcher` field — fires on all tools, filters by `tool_name` inside) that enforces filesystem boundaries on Read, Write, Edit, Glob, Grep.

Path extraction per tool:
- Read/Write/Edit: `tool_input.file_path` (absolute)
- Glob/Grep: `tool_input.path` (optional; absent = cwd = allowed)

Validation:
- Resolve path to absolute via `path.resolve(cwd, rawPath)`
- Read tools: deny if not under any `allowReadPaths`
- Write tools: deny if not under any `allowWritePaths`, OR if under any `denyWritePaths`

---

## Step 2: Add `PLUGINS_DATA_DIR` to `src/system/workdir.ts`

Add a new path constant alongside the existing ones:
```typescript
/** Persistent per-plugin data directory */
export const PLUGINS_DATA_DIR = join(WORKDIR, 'plugins-data');
```

Also ensure it's created in `bootstrapWorkdir()`.

### Add `pluginDataPath` to `AgentDef` (`src/types/agent.ts`)

```typescript
/** Absolute path to plugin's persistent data directory (workdir/plugins-data/<name>/) */
pluginDataPath?: string;
```

### Set `pluginDataPath` in `src/agents/registry.ts`

Set on all three tracks during def construction:

```typescript
// Repo agent (line ~57)
pluginDataPath: join(PLUGINS_DATA_DIR, plugin.name),

// Plugin agent (line ~77)
pluginDataPath: join(PLUGINS_DATA_DIR, plugin.name),

// PM agent (line ~232)
pluginDataPath: join(PLUGINS_DATA_DIR, 'pm'),
```

Import `PLUGINS_DATA_DIR` from `../system/workdir.js`.

---

## Step 3: Refactor `src/agents/spawn.ts`

### 3a. Permission mode

```diff
- permissionMode: 'dontAsk' as const,
+ permissionMode: 'bypassPermissions' as const,
+ allowDangerouslySkipPermissions: true,
```

### 3b. Drop `allowedTools`, use `disallowedTools` only

Remove the `allowedTools` variable and all `Bash(git log*)` patterns. Bash stays available for all tracks except PM — it's OS-sandboxed, so no need to block it.

**PM track:**
```typescript
disallowedTools = ['Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch', ...(def.disallowedTools || [])];
```

**Repo RW track:**
```typescript
disallowedTools = ['WebSearch', 'WebFetch', ...(def.disallowedTools || [])];
```

**Repo RO track:**
```typescript
disallowedTools = [
  'Write', 'Edit', 'WebSearch', 'WebFetch',
  // Block write MCP tools
  'mcp__repo-tools__push_branch', 'mcp__repo-tools__create_pull_request', ...etc,
  ...(def.disallowedTools || []),
];
```

**Plugin track:**
```typescript
disallowedTools = ['WebSearch', 'WebFetch', ...(def.disallowedTools || [])];
```

### 3c. Compute `SandboxOptions` per track

| Track | allowReadPaths | allowWritePaths | denyWritePaths |
|-------|---------------|-----------------|----------------|
| PM | [workspace, shared] | [workspace] | [workspace/.claude] |
| Repo RO | [repo, shared] | [] | — |
| Repo RW | [repo, shared] | [repo] | [repo/.claude] |
| Plugin | [workspace, shared, def.pluginPath, def.pluginDataPath] | [workspace] | [workspace/.claude] |

All paths from `def.pluginDataPath` and `def.pluginPath` are optional — filter out undefined before passing to `SandboxOptions`.

### 3d. Wire sandbox + hooks into `buildQueryOptions`

### 3e. `def.tools` handling

If `def.tools` is defined: pass as SDK `tools` parameter (restricts availability). If absent: omit (all tools available, gated by `disallowedTools`).

---

## Enforcement Summary

```
Layer 1: OS-level sandbox (Bash only)
  ├── denyRead [/] + allowRead [cwd, shared]
  ├── allowWrite [cwd] or [] + denyWrite [.claude]
  └── network: allowedDomains [] (deny all)

Layer 2: PreToolUse hooks (Read, Write, Edit, Glob, Grep)
  ├── Resolves paths to absolute before checking
  ├── Same allow/deny logic as sandbox filesystem
  └── Returns permissionDecision: 'deny' on violation

Layer 3: disallowedTools (removes tools from model context)
  ├── WebSearch, WebFetch — all agents
  ├── Write, Edit — Repo RO
  ├── Bash, Write, Edit — PM only
  └── Write MCP tools — Repo RO

Layer 4: tools parameter (optional, from plugin def.tools)
  └── Restricts available built-in tools when specified

Layer 5: GitHub server-side (unchanged)
  └── Branch protection, no force push
```

---

## Note: Symlinks and Plugin Directories

- **`pluginPath`** = plugin source dir (`workdir/plugins/<name>/`). Read-only for agents.
- **`pluginDataPath`** = plugin data dir (`workdir/plugins-data/<name>/`). Persistent runtime data. Read-only for agents.
- **`skillsPath`** = symlinked into `workspace/.claude/skills/` at setup. Protected by `.claude` deny-write.
- SDK reads `.claude/settings.json` and skills at init, before sandbox applies.

---

## Verification

1. **Typecheck**: `npm run typecheck` — ensure new sandbox types compile
2. **Build**: `npm run build` — full compilation
3. **Manual test — Repo RW**: Agent can read repo+shared, write to repo, not to `.claude/`. Bash works within sandbox.
4. **Manual test — Repo RO**: Agent has Bash (sandboxed RO), Read/Glob/Grep. No Write/Edit. Bash write operations fail at OS level.
5. **Manual test — PM**: No Bash/Write/Edit. Can Read within workspace+shared.
6. **Manual test — Plugin**: Writes to workspace, reads workspace+shared+pluginPath+pluginDataPath. No web from Bash.
7. **Negative test**: Read tool on file outside allowed paths → hook denies.
8. **Negative test**: `.claude/settings.json` written by setupAgentWorkspace before spawn → still read by SDK (parent process, not sandboxed).
