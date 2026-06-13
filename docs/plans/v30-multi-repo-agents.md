# Multi-repo agents and dynamic repo-agent spawning

> **Shipped scope (this PR): multi-repo agents, eager-mount only.**
> A repo agent declares one or more repos in frontmatter and **all of them are
> mounted at spawn**. There is no on-demand attach and no respawn machinery —
> the simplest model that delivers "an agent controls 2+ repos."
>
> **Deferred to a follow-up PR** (design retained below for reference, full
> implementation preserved on branch `claude/multi-repo-full-backup`):
> - On-demand `attach_repo` (mount a declared repo mid-conversation via a
>   turn-ending tool + sessionId-resume respawn). Dropped in favour of eager
>   mounting; would only return if lazy mounting becomes a real need.
> - PM dynamic spawning (`spawn_repo_agent` / `list_available_repos`). Will be
>   rebuilt on the eager-mount foundation — a PM-spawned agent just eager-mounts
>   its repos at spawn, no respawn needed.
>
> The sections below describe the original fuller design; treat the two deferred
> capabilities as not-yet-implemented.

## Context

Today every repo agent is bound 1:1 to a single GitHub repo (`metadata.archie.repo` in plugin frontmatter → `AgentDef.repo: { githubRepo, baseBranch, defaultPath, repoKey }`). This forces:

1. **Cross-repo investigations are awkward.** A backend agent can't easily look at `org/shared-libs` to understand a callsite — there's no agent for it, and even if there were, coordination overhead defeats the purpose for quick lookups.
2. **Every agent must be pre-declared in the plugins repo.** Standing up Archie against a new GitHub installation requires editing/redeploying plugins for every repo you want covered. Slow on-ramp.

This plan adds two capabilities, both grounded in a shared "task-local clone" primitive:

- **Repo agents declare a list of repos in frontmatter** (one is primary, mounted at spawn). They can call `attach_repo({github})` at runtime to mount additional declared repos. After the call, the agent's turn ends; the runtime respawns the agent (sessionId resume) with the new clone added to its mount set.
- **PM can spawn ad-hoc repo agents** via `spawn_repo_agent({shortname, repos})`. The synthesized `AgentDef` is stored in task metadata, becomes a peer for the rest of the task, and behaves identically to a plugin-defined repo agent. Plus `list_available_repos` so PM can discover what the GitHub App can reach.

Outcome: Archie can be productive on a new GitHub installation with minimal plugin work, and existing agents can pull in related repos on-demand without orchestration.

---

## Approach

### Frontmatter shape (plugins repo)

Replace singular `repo` with plural `repos` and an optional `primary` selector.

```yaml
metadata:
  archie:
    repos:
      - github: org/backend
        baseBranch: main
      - github: org/shared-libs
        baseBranch: main
    primary: org/backend   # optional; defaults to repos[0].github
```

- `repos[]` is the agent's whitelist for `attach_repo`.
- `primary` mounts at spawn and is the default for `repo-tools` when `github?` arg omitted.
- If both `repo` (singular) and `repos` (plural) appear → fail loudly at load.
- Old singular `repo: {github, baseBranch}` is auto-migrated by the loader (see Migration).

### Per-agent clone paths

Move the per-task clone directory from `sessions/{taskId}/repos/{repoKey}/` (one entry per repo, keyed by short repo name) to `sessions/{taskId}/repos/{agentId}/{org}/{repo}/` (per-agent grouping, github nested as a directory). This isolates clones per-agent so two agents with overlapping whitelists (or PM-spawned dynamic agents that overlap with a plugin agent's secondary repo) don't collide on the same working tree in RW mode. `git clone --shared` keeps disk cost bounded — only working-tree + refs are duplicated. Clones are siblings of the agent's cwd (`sessions/{taskId}/agents/{agentId}/`) rather than nested under it — the workspace stays a pure RW scratch space, and clone permissions are controlled solely via sandbox allow/deny mounts (no deny-inside-allow carve-outs).

Base cache stays at `$ARCHIE_WORKDIR/repos/{org}/{repo}/` (shared across all tasks via alternates, as today).

New helper in `src/tasks/persistence.ts`: `getAgentClonePath(taskId, agentId, github)` builds `sessions/{taskId}/repos/{agentId}/{github}` (the slash in `org/repo` nests naturally; `mkdir -p` the parent before `git clone`).

### Type changes (`src/types/agent.ts`)

```ts
interface RepoEntry {
  github: string;       // 'org/repo' — also serves as the key
  baseBranch: string;
}
interface RepoConfig {
  repos: RepoEntry[];
  primary: string;      // resolved at load: explicit or repos[0].github
}
interface AgentDef {
  // ...
  repo?: RepoConfig;    // shape changes; field name unchanged for minimal churn
}
```

`PluginAgentDef.repo` (in `src/system/plugin-loader.ts`) gets the same shape change.

Helper: `getRepoEntry(def, github) → RepoEntry | undefined` for tools that need to look up an entry's baseBranch.

### Metadata changes (`src/types/task.ts`)

Concrete before/after for `metadata.json`:

```jsonc
// BEFORE — today
{
  "task_id": "task-…",
  "edit_allowed": false,
  "task_owner": "backend-agent",
  "participants": ["backend-agent"],
  "agent_sessions": {
    "backend-agent": { "session_id": "…", "active": true }
  },
  "repositories": {
    "backend": {                                 // ← keyed by short repoKey
      "path": "/workdir/repos/backend",          //   base cache (derivable)
      "clone_path": "/sessions/<id>/repos/backend",
      "current_branch": "feature/task-…",
      "branch_states": { "feature/task-…": { "base_branch": "main", "pr_number": 42 } }
    }
  }
}
```

```jsonc
// AFTER
{
  "task_id": "task-…",
  "edit_allowed": false,
  "task_owner": "backend-agent",
  "participants": ["backend-agent", "frontend-agent", "explorer-a3f9-agent"],
  "agent_sessions": {
    "backend-agent":         { "session_id": "…", "active": true },
    "frontend-agent":        { "session_id": "…", "active": true },
    "explorer-a3f9-agent":   { "session_id": "…", "active": true }
  },
  // `repositories` keeps the name but the shape changes: it's now keyed by
  // agentId, and each value is a list of AttachedRepo records — the per-agent
  // clone state moved here. The base-cache path used to live in `RepositoryInfo`
  // is gone; it's derivable as `join(REPOS_DIR, github)`.

  "repositories": {
    "backend-agent": [
      {
        "github": "org/backend",
        "clone_path": "/sessions/<id>/agents/backend-agent/clones/org/backend",
        "current_branch": "feature/task-…",
        "branch_states": { "feature/task-…": { "base_branch": "main", "pr_number": 42 } }
      },
      {
        "github": "org/shared-libs",
        "clone_path": "/sessions/<id>/agents/backend-agent/clones/org/shared-libs",
        "current_branch": "main",
        "branch_states": {}
      }
    ],
    "frontend-agent": [
      {
        "github": "org/shared-libs",                                      // ← same repo
        "clone_path": "/sessions/<id>/agents/frontend-agent/clones/org/shared-libs",  // ← independent clone
        "current_branch": "main",                                         // ← independent state
        "branch_states": {}
      }
    ],
    "explorer-a3f9-agent": [
      {
        "github": "org/payments",
        "clone_path": "/sessions/<id>/agents/explorer-a3f9-agent/clones/org/payments",
        "current_branch": "main",
        "branch_states": {}
      }
    ]
  },

  "dynamic_agents": [
    {
      "id": "explorer-a3f9-agent",
      "shortname": "explorer",
      "repos": [{ "github": "org/payments", "baseBranch": "main" }],
      "role": "Generic engineer for org/payments",
      "expertise": "Investigation"
    }
  ]
}
```

Key shape decisions (committed, not open):

- **`repositories` keeps its name but the keying flips from repo to agent.** Today `RepositoryInfo` mixes two concerns: base-cache path (derivable from `github`, never agent-specific) and per-clone state (`clone_path`, `current_branch`, `branch_states`, which are inherently per-agent in the multi-repo world). The per-clone state moves to be the *value* of the map, keyed by agentId. The base-cache path drops (computed on demand as `join(REPOS_DIR, github)`).
- **New type:** `AttachedRepo = { github, clone_path, current_branch, branch_states }`. Reuses the existing `BranchState` type for `branch_states`. The legacy `RepositoryInfo` type and its 14+ call sites are migrated in lockstep.
- **`metadata.repositories: Record<agentId, AttachedRepo[]>`** — same field name, new shape. Two agents attaching the same `github` have two independent records, each with their own branch/PR state — which is exactly what per-agent clone paths require.
- **`dynamic_agents` stores spec inputs only, not derived `AgentDef`s.** What PM passed (`shortname`, `repos`, `role`, `expertise`) plus the assigned `id`. A new helper `synthesizeDynamicAgentDef(spec)` in `registry.ts` rebuilds the full `AgentDef` deterministically on each `Task.get` — keeps the metadata small and never stale.

**Migration of existing on-disk metadata.** Same field name, different shape — discriminate by structure. In `Task.get`, after JSON parse:
1. Detect old shape: any value in `metadata.repositories` is an object with `clone_path` (vs. new shape which is an array).
2. For each old `repoKey` entry, look up `getAgentDef(`${repoKey}-agent`)?.repo?.primary` to get the github. Synthesize one `AttachedRepo` and assign it to `repositories[`${repoKey}-agent`] = [attached]` (single agent owning the clone, matching the 1:1 world).
3. Move the old `clone_path` from `sessions/<id>/repos/<key>/` to `sessions/<id>/repos/<agentId>/<org>/<repo>/` — on first access. If the clone dir doesn't exist yet, just record the new path; `setupSharedClone` recreates it as needed.
4. Persist on next `debouncedSave`.

### Spawn flow (`src/agents/spawn.ts`, repo track)

Loop over `metadata.agent_attachments[agentId]` (default to `[primary]` when empty):
- For each github, run existing `setupSharedClone` against `getAgentClonePath(taskId, agentId, github)`.
- Read/write mode follows the single global `metadata.edit_allowed` flag (RW applies to all attached repos when granted — explicit user decision; not adding per-repo carve-outs).
- Aggregate clone paths into `additionalDirectories`. Aggregate sandbox `allowReadPaths`/`allowWritePaths`.
- The system prompt's "Current Context" block lists every attached repo with its current branch and mode.
- `feature/{taskId}` branch convention works per-repo unchanged (each `branch_states` map is per-RepositoryInfo).

### Why `attach_repo` requires a respawn

The straightforward question: can't we just `git clone` the new repo into a directory the agent already has mounted, and let the agent discover it without restarting?

Two SDK constraints force a respawn:

1. **Sandbox `allowReadPaths` is baked at `query()` time.** The OS-level sandbox (`src/agents/sandbox.ts`) and the filesystem-guard hooks (`createFilesystemGuardHooks` in `src/agents/sandbox.ts`) get a fixed list of allowed read/write paths at SDK init. There is no live API to add a path. If we drop a clone into an unallowed location, the agent gets EACCES on read. We could work around this by pre-mounting the whole `sessions/<id>/agents/<id>/clones/` parent directory at spawn time — but then we hit the next constraint.
2. **Skills (`.claude/skills/`) are discovered at SDK init.** The user specifically wants agent skills shipped *inside* each repo to be picked up (e.g., a backend repo's debugging skills). The SDK scans `additionalDirectories` for `.claude/skills/` during `query()` startup; new skills added after init are invisible until the next `query()`. There's no runtime skill-reload API.

So: even if (1) is worked around, (2) still forces respawn whenever we want the attached repo's skills to count. Since we do want the skills, respawn is unavoidable.

The respawn itself is cheap: SDK session resume (`resume: sessionId` in `buildQueryOptions`) means the model keeps its conversation context. The agent doesn't "forget" anything — just gets re-initialized with new mounts and new skills, then a continuation message ("Repo X mounted at Y, continue.") wakes it up where it left off. From the agent's point of view it's a brief pause, not a fresh start.

### `attach_repo` is a turn-ending tool (completion-style)

Modeled on `report_completion`: calling it ends the agent's current turn. The agent doesn't have to "remember to stop" — the runtime forces the turn to end. Agent prompt language treats it as a turn-ending tool alongside `report_completion`.

Signature: `attach_repo({ github: string }) → string`

Synchronous validation (rejects in tool):
- `github` not in agent's `repos[]` whitelist → reject with whitelist contents.
- already in `metadata.agent_attachments[agentId]` → reject.
- GitHub App can't reach the repo (only checked if not already in base cache) → reject.

On success:
- Set `agent.pendingAttach = github`.
- Set `agent.respawning = true` (suppresses idle detection — see below).
- Return success string: "Repo `{github}` will be mounted on your next turn. Turn ending now."

Then the SDK Stop hook does the rest — the agent doesn't need any "remember to stop" instruction in its prompt:

- Stop hook in `spawn.ts:539-544` already fires when the model's turn ends naturally (after the tool result is processed). It checks `agent.pendingAttach`:
  - If set: returns `{continue: false}` to terminate the SDK iterator cleanly. Does **not** call `task.updateAgentState(def.id, false)` — keeps `session.active = true` so idle detection ignores this agent during the respawn window.
  - If not set: normal path — `task.updateAgentState(false)` then `{continue: true}` (today's behavior).
- The `handle.running.then(...)` watcher in `agent.ts:101-105` checks `pendingAttach`:
  - Run `setupSharedClone` against `getAgentClonePath(taskId, agentId, github)`. `mkdir -p` the `org/` parent.
  - Push the new `AttachedRepo` record onto `metadata.repositories[agentId]`. Persist via `task.debouncedSave()`.
  - Drop continuation message into the queue: "Repo {github} mounted at {path}. Continue from where you left off."
  - Clear `pendingAttach`.
  - Call `spawnAgent(this, task)` again. Existing `session.session_id` drives SDK resume; `buildQueryOptions` is rebuilt fresh per spawn (confirmed at `spawn.ts:503`) — `additionalDirectories`, `sandboxOpts`, `mcpServers` all recomputed from the updated `metadata.repositories[agentId]`.
  - Clear `respawning` after the new `spawnAgent` call returns (handle.isRunning flips back to true). Now idle detection works normally again.
- Failure during respawn: drop a failure message into the queue, clear `pendingAttach` and `respawning`, fall through to normal inactive marking.

### Recovery / idle-detection interaction

The existing flow in `src/tasks/recovery.ts`:
- Every time `task.updateAgentState(id, false)` runs, `scheduleIdleCheck(task)` queues a 3s timer (`task.ts:768`).
- The timer fires `checkAllAgentsInactive(task)` (`recovery.ts:91-98`) which iterates `task.agentProcesses` and returns `true` if every `agent.session.active === false`.
- If all inactive: `triggerRecovery` sends a reinforcement nudge to the lead agent (attempt 1-2) or nukes via `task.stop()` + `recoverTaskAgents` (attempt 3+). The nudge re-activates the agent and the next idle check sees it active.

Without intervention, the respawn window (Stop hook fires → respawn finishes) would be flagged as idle. The 3s timer might fire mid-respawn and push `AGENT_PROMPTS.reinforceAgent` into the queue — that nudge would then be the first thing the respawned agent sees, ahead of our intended continuation message. Worst case after three such cycles: nuclear restart.

**Fix (two small changes):**

1. In `spawn.ts` Stop hook: when `agent.pendingAttach` is set, **do not** call `task.updateAgentState(def.id, false)`. The Stop hook returns `{continue: false}` and the SDK exits, but `session.active` stays true. Watcher in `agent.ts:101` (which also calls `updateAgentState(false)` after `handle.running` resolves) gets a `pendingAttach`-aware branch — when set, do the respawn instead of marking inactive.
2. In `recovery.ts` `checkAllAgentsInactive`: treat agents with `agent.respawning === true` as active — `if (agent.session.active || agent.respawning) return false;`. This is belt-and-suspenders in case the watcher hasn't run yet but the SDK iterator has already exited.

With both, `scheduleIdleCheck` simply never fires triggerRecovery during a respawn. Once respawn completes and `respawning` flips back to false, the system returns to normal idle behavior — if the respawned agent goes idle again later (e.g., after processing the continuation message), the existing flow handles it.

A `agent.attaching: Promise<void> | undefined` guard on `agent.spawn()` prevents a peer-triggered `ensureAgentSpawned` from racing the respawn — `agent.spawn()` awaits the in-flight respawn promise rather than starting a second SDK process against the same queue. Peer messages still enqueue safely (`MessageQueue.addMessage` works whether or not the queue is being consumed).

### `spawn_repo_agent` PM tool (new)

Signature:
```ts
spawn_repo_agent({
  shortname: string,                                       // [a-z][a-z0-9-]*
  repos: Array<{github: string, baseBranch?: string}>,    // first = primary
  role?: string,
  expertise?: string,
}) → { agentId: string }
```

Behavior:
1. **Anti-duplication on primary only.** Reject if any plugin-defined repo agent has any of the requested githubs as its `primary`. Whitelist overlap is fine — per-agent clones make it safe in RW too.
2. ID: `{shortname}-{4charHex}-agent`. Validate shortname matches `^[a-z][a-z0-9-]*$`.
3. Synthesize `AgentDef`: `track: 'repo'`, repo from args (`primary = repos[0].github`, baseBranches default to `'main'` when omitted), generic role/expertise defaults if PM omits, no Layer-3 prompt, no skills, no plugin MCP servers.
4. Lazy-clone any uncached repos (gated by GitHub App reachability — fail tool synchronously if unreachable).
5. Append to `metadata.dynamic_agents`. Persist. Add to `task.team`.
6. Return `{agentId}`. PM calls `send_message_to_agent(agentId, ...)` next turn.

Dynamic agent's `repos[]` = exactly what PM supplied → its `attach_repo` rejects anything outside that list. Cleanly consistent.

### `list_available_repos` PM tool (new)

Wraps `apps.listReposAccessibleToInstallation` via existing `getOctokit()` in `src/connectors/github/client.ts`. Returns `[{github, default_branch, description?}]`. Cached for the task lifetime to avoid hammering the API.

### `repo-tools` `github?` arg

Every tool that operates on a clone or GitHub repo gains optional `github?: string`. All resolution happens **per-call** (not closure capture):
- Default to `agent.def.repo!.primary` when omitted.
- Validate `github ∈ task.metadata.agent_attachments[agent.def.id]`.
- For local-clone tools (`fetch`, `switch_branch`, `create_branch`, `list_branches`, `push_branch`): resolve via `getAgentClonePath(taskId, agentId, github)`.
- For GitHub-API tools (`list_prs`, `get_pr`, `create_pull_request`, …): pass `github` directly to `githubClient`.

20 tool definitions touched in `src/agents/tools.ts`.

### Team & peer list

- `buildPeerList(excludeAgentId, team)` in `src/agents/registry.ts` — accepts a team list, defaults to global `registry`. Repo-track peers list their primary github in the formatted line.
- `Task.get` / `Task.create` merge `metadata.dynamic_agents` into the freshly-scanned team **before** returning the Task instance — must happen before `recoverTaskAgents` runs, otherwise dynamic agents fail `task.team.find(...)` lookup in `ensureAgentSpawned`.
- `allAgents()` in `src/agents/tools.ts` rewritten to take `task` and read `task.team` instead of the global `getAgentIds()`. This is the source for the `send_message_to_agent` Zod enum (rebuilt per spawn since `createSendMessageTool` is invoked inside `createPMAgentMcpServer`/`createBaseAgentMcpServer`, both called fresh in `spawnAgent`).
- `generateRepoAgentPrompt` / `generatePluginAgentPrompt` pass `task.team` to `buildPeerList`.

### Migration

**Frontmatter (`src/system/plugin-loader.ts`):**
- If `metadata.archie.repo` (singular) present and `metadata.archie.repos` (plural) absent → synthesize `repos: [{github, baseBranch}]`, `primary: github`.
- If both present → fail at load with the agent's filename.

**On-disk metadata (`Task.get`):**
- After JSON parse, walk `metadata.repositories`. For each key without `/`, look up `getAgentDef(`${key}-agent`)?.repo?.primary` (the migrated singular case maps cleanly). Re-key the entry. Persist on next `debouncedSave`.
- Orphan keys (plugin removed) get logged and left alone.

**Call site fixup (`src/connectors/github/merge.ts:213`):** replace `getAgentDef(`${repoKey}-agent`)` with `getAgentDefByGithubRepo(github)`. Update `linkedPRs` typing in `branch-state.ts` if it carries `repoKey`.

**Other read sites** (14 across `src/`): update each to read `def.repo.primary` (when defaulting) or iterate `def.repo.repos[]`. Most are mechanical.

### Prompt updates

**`prompts/repo-agent.md`** Layer-2 — `{{REPO_KEY}}` becomes `{{REPO}}` (now the primary repo's github identifier, e.g. `org/backend`); `{{BASE_BRANCH}}` keeps its name and resolves to the primary's base branch. Add a section:
> You may have a primary repo (mounted at spawn) and additional declared repos available via `attach_repo`. Most repo-tools accept a `github` argument; omitted, they target your primary. To work in a related declared repo, call `attach_repo({github})`, then stop your turn — you'll be respawned with the repo mounted, then continue from where you left off.

The "Current Context" block injected at spawn lists all currently-attached repos with paths, branches, and mode.

**`prompts/pm-agent.md`** — new section:
> **Repo agent selection.** Prefer plugin-defined specialists. Use `list_available_repos` to discover what the GitHub App can reach. Use `spawn_repo_agent` only when no plugin agent covers the relevant repo — the runtime rejects spawn against repos that already have a plugin specialist as their primary.

---

## Edge cases addressed

- **Stop-hook race.** Returning `{continue: false}` exits the SDK iterator so `handle.running` resolves; no concurrent SDK processes on the same queue.
- **Idle nudge during respawn.** Covered by the "Recovery / idle-detection interaction" section above — `agent.respawning` keeps `checkAllAgentsInactive` from returning true; Stop hook also skips `updateAgentState(false)` so `session.active` stays true.
- **Peer message during respawn.** `MessageQueue.addMessage` is unaffected; messages enqueue and are consumed when the respawned SDK starts. `agent.attaching` promise gates `agent.spawn()` to prevent a third spawn racing the respawn.
- **Recovery of dynamic agents.** Merge `metadata.dynamic_agents` into `team` inside `Task.get` synchronously, before `new Task(...)` returns, so `recoverTaskAgents` and `ensureAgentSpawned` find them.
- **MCP server stale captures.** Tools resolve clone path per-call via `metadata.repositories[agentId]`. Closure captures `agent`/`task`, not a baked-in `repoKey`. After respawn (which rebuilds the MCP server), tools see the updated attachments.
- **Edit mode is global.** Approving edit mode RWs all attached repos. Explicit decision per user — not adding per-repo carve-outs.

## Out of scope (v1)

- Dynamic agents attaching repos beyond their initial spawn list.
- Wildcard whitelists (`org/*`).
- Mid-conversation peer-list updates to already-running agents (existing agents see new dynamic peers on next respawn).
- Per-repo edit-mode approval.

## Files modified

- `src/types/agent.ts` — `RepoEntry`, `RepoConfig` shapes
- `src/types/task.ts` — `agent_attachments`, `dynamic_agents`, repositories key change
- `src/system/plugin-loader.ts` — frontmatter parsing + singular→plural migration
- `src/agents/registry.ts` — `buildPeerList(excludeId, team)` overload, `getAgentDefByGithubRepo` helper if not already present
- `src/agents/agent.ts` — `pendingAttach`, `suppressIdleCheck`, `attaching` fields; respawn from `handle.running.then` watcher
- `src/agents/spawn.ts` — multi-repo mount loop in repo track; Stop hook checks `pendingAttach`; prompt context lists all attachments
- `src/agents/tools.ts` — `attach_repo`, `spawn_repo_agent`, `list_available_repos`; `github?` arg on all 20 repo-tools with per-call resolution; `allAgents(task)` reading task team
- `src/agents/message-queue.ts` — no change expected (verify `addMessage` doesn't throw mid-respawn)
- `src/tasks/task.ts` — merge `dynamic_agents` into team in `Task.get`/`Task.create`; `ensureAgentSpawned` already team-driven; `cleanupClones` updated for nested `org/repo` paths and per-agent layout
- `src/tasks/persistence.ts` — `getAgentClonePath(taskId, agentId, github)`; lazy migration of `metadata.repositories` keys
- `src/tasks/recovery.ts` — `scheduleIdleCheck` honors `agent.suppressIdleCheck`
- `src/system/workdir.ts` — `cloneRepos` iterates all `repos[]` across all repo agents (deduped by github)
- `src/connectors/github/client.ts` — `listAccessibleRepos()` helper
- `src/connectors/github/repo-clone.ts` — `mkdir -p` parent before `git clone`; path nesting for `org/repo` keys
- `src/connectors/github/events.ts` — uses `getAgentDefByGithubRepo` (likely already does); verify
- `src/connectors/github/merge.ts` — replace `getAgentDef(`${repoKey}-agent`)` with `getAgentDefByGithubRepo`
- `prompts/pm-agent.md` — repo-agent selection guidance
- `prompts/repo-agent.md` — multi-repo working model + variable rename
- `docs/architecture/agents.md`, `docs/architecture/plugin-system.md` — doc updates

## Implementation order

1. **Types + frontmatter migration** (`src/types/agent.ts`, `plugin-loader.ts`, `registry.ts`) + unit tests for migration.
2. **Per-agent clone path** (`getAgentClonePath`, update `setupSharedClone` callers) — single-repo behavior preserved.
3. **`metadata.repositories` rekey + lazy migration** (`Task.get`, fix `merge.ts:213`, update 14 read sites mechanically).
4. **Multi-repo spawn** (`spawn.ts` repo track mount loop, sandbox aggregation, prompt context) — preserves single-repo behavior when `agent_attachments[id]` has only the primary.
5. **`repo-tools` `github?` arg** with per-call resolution against `agent_attachments`.
6. **`attach_repo` tool + Stop-hook respawn flow** (`agent.ts` watcher, `recovery.ts` suppression flag, `agent.attaching` guard) + tests.
7. **`list_available_repos` PM tool** + `listAccessibleRepos` GitHub client helper.
8. **`spawn_repo_agent` PM tool** + `metadata.dynamic_agents` + Task.team merge + anti-duplication + `allAgents(task)` + `buildPeerList(excludeId, team)`.
9. **Prompt updates** + architecture doc updates.
10. **Plugins repo migration** (lockstep) — switch existing plugins to new `repos`/`primary` shape, though the loader's compat shim means no urgent break.

## Verification

**Unit tests:**
- Frontmatter migration: singular `repo` → plural `repos` + `primary`. Both shapes present → load fails. Plural with no `primary` → defaults to `repos[0].github`.
- `metadata.repositories` lazy rekey: pre-existing task with old `repoKey` keys, `Task.get` rewrites to `github` keys.
- `buildPeerList` with task-team override returns dynamic agents that aren't in global registry.
- `attach_repo` rejects: not-in-whitelist, already-attached, App-unreachable.
- `spawn_repo_agent` rejects: shortname format, primary collides with plugin agent.

**Integration tests:**
- Spawn a repo agent declared with two repos → primary mounts at spawn → agent calls `attach_repo` for the secondary → Stop hook fires → runtime respawns → secondary mount visible → `repo-tools` with `github` arg routes to the right clone.
- PM tool flow: `list_available_repos` → `spawn_repo_agent` against an installation repo → PM `send_message_to_agent` to the new agent → agent reads files in its primary → reports back to PM. Verify peer-list visibility in a sibling agent's prompt after respawn.
- Recovery: stop+restart with a `metadata.dynamic_agents` entry → `Task.get` rehydrates the team → `ensureAgentSpawned` finds the dynamic agent.

**Manual:**
- Run `npm run dev`, exercise an end-to-end Slack flow that spans two repos via `attach_repo`. Confirm continuation message appears, agent picks up where it left off, no spurious idle nudge.
- Confirm RW mode after edit-mode approval works on both primary and attached repos (separate `feature/{taskId}` branches per repo).
- Confirm `npm run typecheck` and existing test suite still pass.

## Critical files to reference

- `src/agents/agent.ts:101–105` — `handle.running.then` watcher; respawn-on-pendingAttach plugs in here.
- `src/agents/spawn.ts:267–429` — repo track spawn block; mount loop replaces single-repo `setupSharedClone` call.
- `src/agents/spawn.ts:539–544` — Stop hook; checks `pendingAttach` to return `{continue: false}`.
- `src/agents/spawn.ts:503` — `buildQueryOptions` rebuilt fresh per spawn (verified safe for new `additionalDirectories`).
- `src/agents/tools.ts:125–144` — `allAgents()` and `createSendMessageTool`; switch enum source to `task.team`.
- `src/agents/tools.ts:1126–1184` — `createPMAgentMcpServer` / `createRepoToolsMcpServer`; new tools register here.
- `src/agents/registry.ts:154–164` — `buildPeerList`; add `team` param.
- `src/tasks/task.ts:172–185` — `Task.get`; merge `dynamic_agents` into team here.
- `src/tasks/task.ts:775–788` — `ensureAgentSpawned`; already team-driven, no change beyond team source.
- `src/tasks/recovery.ts:77` — `scheduleIdleCheck`; honor `suppressIdleCheck`.
- `src/connectors/github/repo-clone.ts:87–142` — `setupSharedClone`; verify `mkdir -p` parent for nested `org/` dir.
- `src/connectors/github/merge.ts:213` — broken `getAgentDef(`${repoKey}-agent`)` lookup; replace with github-based lookup.
- `src/system/plugin-loader.ts:190–196` — frontmatter parsing; add migration shim.
