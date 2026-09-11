# Plugin System Architecture

A plugin contributes exactly two things: **skills** the PM can load, and **agent definitions** the PM can spawn as workers. Both are loaded natively by the Claude Agent SDK — Archie passes every plugin directory through `query()`'s `plugins` option and the SDK reads the plugin's `skills/`, `agents/`, `commands/` and `hooks/` itself. Archie no longer parses anything *inside* a plugin: there is no agent-definition builder, no frontmatter scanner, no skill symlinking and no per-track mount table.

What Archie still owns is what the SDK does not: cloning and refreshing the plugins repo, enumerating which top-level directories are plugins, and the three root-level files (`.mcp.json`, `archie.json` and `pm.md`) that stay engine-owned.

**Source:** `src/system/workdir.ts`, `src/system/plugin-loader.ts`, `src/agents/spawn.ts`, `src/agents/registry.ts`

## Where plugins come from

Plugins are not bundled with the source tree. At startup, `bootstrapWorkdir()` clones the git repository pointed to by `ARCHIE_PLUGINS` (optionally pinned by `ARCHIE_PLUGINS_BRANCH`) into `$ARCHIE_WORKDIR/plugins/`, then materializes its git submodules. The repo is kept current on demand rather than on a timer: every task start/load runs `syncPlugins()` (`src/system/plugin-sync.ts`), which calls `refreshPlugins()` to do a lightweight `git ls-remote` HEAD check against the configured branch. If the remote tip hasn't moved, nothing happens; if it has, Archie fetches, hard-resets onto it and re-scans the plugin directories — so a push is picked up on the very next request. For local development `$ARCHIE_WORKDIR/plugins/` may be a symlink to a checkout, in which case Archie skips git management and just re-scans from disk.

An in-flight task is never disturbed. A stopped or completed task picks the change up when it is pinged again (it reloads from disk through `Task.get()`, which syncs and re-scans the PM definition), as does any task after a process restart. There is no hot reload for a running session.

The PM's context includes a "Plugins repo last updated" line — the committer date, short SHA and subject of the current plugins HEAD (`getPluginsHeadInfo()`) — so users in Slack can ask when the plugins were last updated and cross-check against the repo.

## Plugin directory structure

Every plugin is a top-level directory of the plugins repo carrying a `.claude-plugin/plugin.json` manifest. Directories without a valid manifest (missing `name`, `version` or `description`, or unparseable JSON) are skipped with a warning. The structure is the standard Claude Code plugin layout:

```
plugins/
  .mcp.json                       # engine-owned: MCP servers + Archie extensions
  archie.json                     # engine-owned: network allowlist + per-repo flags
  engineering/
    .claude-plugin/plugin.json    # required: { name, version, description }
    skills/
      pr-workflow/SKILL.md        # loadable as engineering:pr-workflow
    agents/
      qa-reviewer.md              # spawnable as engineering:qa-reviewer
    hooks/hooks.json              # loaded by the SDK, not copied by Archie
  marketing/
    .claude-plugin/plugin.json
    skills/
      tone-analysis/SKILL.md
    agents/
      tov-reviewer.md
```

There is no `repo-config.json`, no `metadata.archie.repo` binding and no `pm` overlay plugin. Repositories are not declared by plugins at all: the GitHub App installation is the allowlist and the PM mounts what it needs with `mount_repo` (see [edit-mode.md](edit-mode.md)).

## Skills

Every plugin's `skills/` directory is loaded by the SDK, and the PM reaches them through the built-in `Skill` tool. **Skill names are namespaced by plugin** — `core:thread-conduct`, `engineering:pr-workflow` — so two plugins may ship a skill of the same name without colliding. The PM's prompt tells it to read the tool's own list rather than memorise a roster.

A plugin agent may preload skills via its frontmatter `skills` field; that preloads, it does not restrict.

### The core plugin

Archie ships its own skills as one more plugin, `core-plugin/` in this repository, with the manifest name `core`. It holds the skills that belong to the engine rather than to a domain: `channel-canvas`, `self-awareness`, `thread-conduct`, `trigger-task` and `triggers`. It is passed to the SDK alongside the plugins-repo directories, so its skills load identically and appear as `core:<name>`.

The directory is resolved relative to the compiled module (`dist/agents/../../core-plugin`), which lands on the repo root in both the dev and production layouts — `Dockerfile.prod` copies it there and `docker-compose.yml` bind-mounts it. If it is missing the SDK simply loads no core skills, and the post-`init` assertion below says so.

### Load assertion

Plugin load failures are **silent skips** in the SDK: a bad manifest, an unreadable directory or a path the sandbox hides produces no error, just a session missing skills someone expects it to have. So `assertPluginsLoaded()` compares the `plugins` array on the session's `init` message against the directories we asked for and logs an error naming any that are absent.

## Agents

An `agents/*.md` file in a plugin is loaded by the SDK and becomes an agent type on the PM's `Agent` tool, addressable as `plugin:agent`. The SDK honours `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory` and the background/worktree isolation flags. It **ignores** `mcpServers`, `permissionMode` and `hooks` on a plugin agent, with a warning — MCP is engine-owned and session-wide, so a plugin agent sees every server the PM does.

Because a worker no longer needs a definition file just to exist, one is written only when a role earns it: a fixed procedure and output envelope, a reviewer that must be blind to how the material was made, or a model/effort combination the PM cannot express per spawn (effort is not a per-spawn `Agent` argument). Everything else goes to the general-purpose worker with a brief.

## The root MCP config

`$ARCHIE_WORKDIR/plugins/.mcp.json` is the single source of MCP servers, and **every server in it attaches to the PM session**. `loadMcpJson()` reads it, substitutes `${MCP_*}` environment variables, and splits out two Archie extensions before the config reaches the SDK, so a plugin repo authored for Archie stays a valid Claude plugin:

- `description` — one human-readable line per server, used to phrase the Slack status line for an integration call.
- `archie` — the tool approval policy for that server: `{ default, allow, ask, deny, titles }`. Policies from all servers are unioned into one session policy; `deny` tiers become `disallowedTools`, `ask` tiers attach the PreToolUse approval gate. A server without this block is unmanaged. A malformed block throws rather than being dropped. See [tool-approvals.md](tool-approvals.md).

Every plugin is passed with `skipMcpDiscovery: true`, so a plugin that still ships its own `.mcp.json` does not get its servers connected behind the engine's back.

OAuth bearer tokens are injected into HTTP/SSE servers on **every** spawn (`applyOAuthBindings`), so a long-lived session never holds a stale token; a server whose token cannot be refreshed is dropped before connect with an error. See [secrets.md](secrets.md).

## The root engine config (`archie.json`)

The one engine-level config surface the plugins repo has. A missing or malformed file means the empty config — no allowlisted domains, no warm repos, no auto-merge — which is the safe direction for all three. Loaded fresh on each read, so a plugins refresh is picked up by the next task.

```json
{
  "allowedNetworkDomains": ["sheets.googleapis.com"],
  "repos": {
    "org/backend":  { "warm": true, "autoMerge": true },
    "org/mobile":   { "warm": true }
  }
}
```

| Key | Effect |
|---|---|
| `allowedNetworkDomains` | The sandbox's outbound allowlist for the whole session, plus the trusted package registries when edit mode is on ([security.md](security.md#network)) |
| `repos[*].warm` | Warm-clone this repo's base cache at startup, so the first `mount_repo` of a large repository is cheap. Everything else is cloned on demand — warming is a latency optimisation, not a precondition |
| `repos[*].autoMerge` | May Archie merge this repo's PRs without a per-merge human approval? ([github-integration.md](github-integration.md#merge-policy-automerge)) |

Both booleans parse strictly: only the literal `true` opts in, so a typo fails safe.

## PM overlay (`pm.md`)

The third engine-owned root file. `pm.md` is a plain Markdown file at the plugins repository root, read at every PM spawn — no restart needed, the same "picked up on the next task start/load" timing as `.mcp.json` and `archie.json`. A missing file is a no-op; the PM's model, effort and max-mode default to the built-ins below.

Optional YAML frontmatter carries three keys: `model`, `effort`, and `maxMode: { model, effort }`. Precedence for each of the four resolved values is env var, then `pm.md`, then the built-in default:

| Value | Built-in default | `pm.md` frontmatter | Env override |
|---|---|---|---|
| Model | `opus` | `model` | `ARCHIE_PM_MODEL` |
| Effort | `medium` | `effort` | `ARCHIE_PM_EFFORT` |
| Max-mode model | `claude-fable-5-1` | `maxMode.model` | `ARCHIE_PM_MAX_MODEL` |
| Max-mode effort | `high` | `maxMode.effort` | `ARCHIE_PM_MAX_EFFORT` |

Malformed frontmatter is tolerated as body-only — the whole file is treated as body text rather than failing plugin load, unlike a malformed `archie` MCP block.

The file's body is appended to the PM's system prompt under a final heading, `# Deployment context`. This is the place for standing organisational context, tone and standing rules that apply to every task regardless of domain — not procedure, which still belongs in a skill the PM loads on demand.

## Bootstrap order (`src/index.ts`)

1. `bootstrapWorkdir()` — create the workdir tree, clone/pull the plugins repo, init submodules
2. `validateMasterKey()` — when the OAuth vault holds records or a key is configured
3. `initPlugins()` — enumerate plugin directories into the in-memory `LoadedPlugin[]`
4. `initRegistry()` — build the PM definition from the root `.mcp.json` and `archie.json`
5. `initEventPersistence()`, `initMemory()`
6. Warm the base clones `archie.json` marks with `warm: true`
7. Log what the next task will load — the plugin names, and the PM's model, effort, MCP servers and network allowlist

```typescript
// src/system/plugin-loader.ts
export interface LoadedPlugin {
  name: string;                 // manifest name — what the SDK namespaces skills under
  dir: string;                  // absolute path, passed to the SDK `plugins` option
  manifest: PluginManifest;     // parsed .claude-plugin/plugin.json
}
```

## Sandbox grants

The session must be able to *read* the files behind a loaded skill — its `SKILL.md`, and the reference files and scripts it points at. Two grants cover that, both punching through a broad denial: the plugins repo (which sits under `WORKDIR`, denied wholesale) and the core plugin directory (which sits in archie-hq's own tree, denied as `/app`). Loading a skill needs neither grant — `Skill` is gated by neither the PreToolUse guard nor bubblewrap — but reading a skill's file needs both layers to allow the real path. See [security.md](security.md#filesystem-isolation).

The plugins repo is deliberately **not** listed in `additionalDirectories`: `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` auto-loads a `CLAUDE.md` from every entry, and the plugins repo root carries one written for people authoring plugins, not for the PM running a task.

## Task directory structure

```
sessions/
  task-20260222-1400-a3f9k2/
    shared/                    # shared task state, mounted read-only
      metadata.json
      knowledge.log
      events.jsonl
      usage.jsonl
      memory/
      attachments/
      artifacts/
    agents/
      pm/                      # the PM's workspace (cwd, read-write)
        .claude/settings.json  # attribution only — hooks come from the plugins
    claude/
      pm/{session,tmp}         # SDK config and scratch dirs
    repos/
      org/backend/             # one clone per repo per task, created by mount_repo
    researches/
```

**Source:** `src/tasks/persistence.ts` (path helpers), `src/agents/spawn.ts` (workspace and SDK dirs)

## Core vs plugin separation

Everything in `src/` is domain-agnostic: the task runtime, the single agent spawner, the in-process MCP tools, the plugin enumerator and the root-config loaders. Everything domain-shaped lives in the `ARCHIE_PLUGINS` repository — skills, agent definitions, hooks, the MCP server declarations and their approval tiers, and the per-repo flags. Adding a domain means adding a plugin directory; no core change and no redeploy, because the next task to start or load runs `syncPlugins()` and picks it up.

## Related Documentation

- [Agents](./agents.md) — the PM, plugin agents, and the general-purpose worker
- [Tool Approvals](./tool-approvals.md) — the `archie` block and the approval gate
- [Security](./security.md) — sandbox grants and the shared-credential posture
