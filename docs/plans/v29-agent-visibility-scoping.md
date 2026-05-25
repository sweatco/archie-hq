# Agent Visibility Scoping (global / local)

## Context

Today every agent loaded from any plugin is globally addressable. The registry holds a flat list keyed by agent id (`registry.ts:19`), and `send_message_to_agent` (`tools.ts:157`) builds a static enum from `['pm-agent', ...getAgentIds()]` — every agent appears in every other agent's peer list, regardless of which plugin they belong to.

This forces plugins to expose all of their helpers as part of their public surface. A plugin can't have private internal agents, and the PM agent ends up routing through a flat namespace that grows linearly with every plugin's internals.

We're adding a `visibility: global | local` field to agent frontmatter so a plugin can declare internal agents that only its own agents can address. PM becomes "just a plugin" (`pluginName: 'pm'`) so the rule applies uniformly with no special bypass.

**Naming model: flat IDs with strict global uniqueness.** An evaluated alternative — qualified internal keys (`plugin/agent`) so two plugins can each ship a `local helper-agent` — was rejected because it requires migrating `agent_sessions` persistence keys *and* per-task on-disk paths (`agents/<key>`, `claude/<key>` in `spawn.ts:93,144`), neither of which is worth the convenience of duplicate short names. Plugin authors prefix their internal agent filenames instead (e.g. `analytics-helper-agent.md`).

A separate `subagent` (ephemeral) mode is deferred.

## Design summary

- **Id format unchanged**: `${key}-agent`. The registry array, `agentProcesses` map, `agent_sessions` persistence, and on-disk paths all stay flat.
- **One startup invariant**: agent IDs are globally unique across all plugins, regardless of visibility. (Today's collision check already enforces this; we only need to ensure the rule survives the addition of `visibility`.)
- **Per-sender `send_message_to_agent` enum** built at agent spawn (sender's `AgentDef` is already in scope): same-plugin agents (any visibility) ∪ other-plugin agents with `visibility === 'global'` ∪ `pm-agent`. Enum members are just the ids — no resolution layer needed.
- **PM is just a plugin**: `pluginName: 'pm'`. PM's enum includes `pm`-plugin locals + all globals. PM cannot address other plugins' locals.
- **Repo agents may declare `visibility: local`.** Webhook routing via `getAgentDefByGithubRepo` (`registry.ts:141`) is an external entry that bypasses peer-list visibility — a local repo agent still receives webhooks for its repo. PM cannot `assign_task_owner` to a local repo agent; same-plugin agents can message it directly.
- **Default visibility**: `global` for backward compatibility. Existing agents without the field behave as today.

## Implementation milestones

Each milestone leaves the tree compiling and tests passing.

### M1 — Frontmatter + type field (no behavior change)

Files:
- `src/system/plugin-loader.ts` (parse `visibility` from frontmatter ~line 195; add to `PluginAgentDef` interface ~line 73)
- `src/types/agent.ts` (add `visibility: 'global' | 'local'` to `AgentDef`)
- `src/agents/registry.ts` (default `visibility = 'global'` in both branches of `scanAgentDefs`)

Parsing pattern matches the existing manual-check style at `plugin-loader.ts:194-195`:
```
const visibility = data.visibility === 'local' ? 'local' : 'global';
```

### M2 — Collision check survives the new field; PM moves to `pm` plugin

File: `src/agents/registry.ts`

- The existing `checkCollision` (line 170) already enforces global id uniqueness, which is exactly the invariant we want. No change to the rule itself; just verify the new `visibility` field doesn't loosen it inadvertently.
- `buildPmDef` at line 224: change `pluginName: 'core'` → `pluginName: 'pm'`. PM now belongs to the `pm` plugin for visibility purposes; the `pm` plugin's locals become addressable by PM, and locals elsewhere don't.
- The skip rule at line 47 (`if (plugin.name === 'pm' && agent.key === 'pm') continue;`) remains correct.
- Add `buildPeerListForSender(senderDef)` that returns the visibility-filtered peer set (same-plugin any visibility ∪ other-plugin globals, excluding sender + PM). Render as the same `- ${d.id}: ${d.role}` format `buildPeerList` uses today.
- Keep existing `buildPeerList(excludeAgentId)` as a back-compat wrapper, or update its two callers in this milestone — see M4.

### M3 — Per-sender enum in `send_message_to_agent` (and `assign_task_owner`)

Files:
- `src/agents/tools.ts:157-176` — replace `allAgents()` with a function that takes the sender `AgentDef` and returns `buildPeerIdsForSender(senderDef) ∪ ['pm-agent']`. The tool factory already runs per-agent at spawn time (`spawn.ts:233`), so the sender is in scope. Guard against degenerate empty sets by always including `pm-agent`.
- `src/agents/tools.ts:360` (PM's `assign_task_owner`) — narrow to global agents + `pm`-plugin locals using the same filter (effectively `buildPeerIdsForSender(pmDef)` minus `pm-agent`).
- `src/tasks/task.ts:619-646` (`toolSendMessage`) — no resolution needed (ids are unique), but add a defensive visibility check: if the resolved target isn't in the sender's visible set, error back with the visible list. This guards against an agent that constructs the call outside the Zod enum (jailbreak/tool-call fuzz).

### M4 — Prompt-visible peer list narrowed

Files: `src/agents/spawn.ts:53, 74`

- Swap `buildPeerList(def.id)` → `buildPeerListForSender(def)` at both call sites. Visibility-filtered peers flow into the `PEER_LIST` template variable.
- PM's `TEAM_LIST` / `TEAM_EXPERTISE` are currently built once in `buildPmDef` (`registry.ts:227-233`) from all teammates. Filter them through PM's visibility set (global + `pm`-plugin locals). PM's visibility set is stable across spawns, so building inside `buildPmDef` is fine.

### M5 — Display and startup logging

File: `src/index.ts:113-130`

- In the startup team summary, render `[<pluginName>] <id> (<visibility>) — <role>` so operators can see the visibility model at a glance.
- After registry init, for each non-`pm` plugin: if it has zero `global` agents *and* no `local` repo agents (which can still receive webhooks), log `Warning: plugin "X" has no externally reachable agents — PM cannot dispatch into it`. Don't fail.
- Status API at `routes.ts:137` displays ids; no logic change (ids are unchanged).

## Files to be modified

Production code (5 files):
- `src/system/plugin-loader.ts`
- `src/types/agent.ts`
- `src/agents/registry.ts` (riskiest — collision check stays, but `buildPmDef` and the new `buildPeerListForSender` land here)
- `src/agents/tools.ts`
- `src/agents/spawn.ts`
- `src/tasks/task.ts` (only the defensive visibility check in `toolSendMessage`)
- `src/index.ts`

New test files (2):
- `src/agents/__tests__/registry-visibility.test.ts`
- `src/agents/__tests__/peer-list.test.ts`

Test fixtures to update:
- `src/agents/__tests__/tool-contract.test.ts` (add `visibility: 'global'` to `AgentDef` literals; per-sender enum assertions)
- `src/agents/__tests__/pr-tools.test.ts` (add `visibility: 'global'` to `AgentDef` literals)

## Reused existing utilities

- `resolveAgentMcpServers` (`registry.ts:189`) — unchanged.
- `getPlugins()` / `getRootMcpConfig()` / `getPmOverlay()` — unchanged plugin loader API.
- `loadPrompt` in `spawn.ts:44-74` — unchanged; feeds the new peer-list helper output into `PEER_LIST`.
- `checkCollision` (`registry.ts:170`) — unchanged.
- `getAgentDef` / `getAgentDefByGithubRepo` (`registry.ts:134, 141`) — unchanged.
- `agent_sessions` persistence (`task.ts:151,596,836`, `persistence.ts:158-172`, `recovery.ts:55`, `agent.ts:82`, `routes.ts:137,145`) — **unchanged**; flat ids continue to work.
- Per-task on-disk paths `agents/<key>` and `claude/<key>` (`spawn.ts:93,144`) — **unchanged**; flat keys continue to work.

## What's deliberately not in this plan

- No persistence-key migration. `agent_sessions` keeps flat ids.
- No on-disk path qualification or rename migration. `agents/<key>` and `claude/<key>` stay flat.
- No name resolver. Ids are unique, so the dispatcher just looks them up directly.
- No `subagent` mode. Separate piece of work.

## Verification

**Unit tests:**
- `registry-visibility.test.ts`: collision matrix is the existing rule (any two agents with the same id → throws, regardless of visibility); `visibility` defaults to `global` when frontmatter omits it; repo agents respect declared visibility; PM is built with `pluginName: 'pm'`.
- `peer-list.test.ts`: `buildPeerListForSender` returns expected sets for (a) PM (globals + `pm`-plugin locals), (b) a plugin agent with one local + one global sibling (sees both same-plugin agents and any external globals), (c) a plugin agent in a plugin with only locals (sees same-plugin peers + external globals, no external locals).
- Tool-contract test: `send_message_to_agent` enum reflects per-sender filter; sender from plugin A cannot include plugin B's local in the enum.

**End-to-end manual scenarios:**
1. Create a temp plugin with one global + one local agent. Confirm via spawn-time logs that the global agent's enum contains both same-plugin peers; an agent in a different plugin sees only the global.
2. Confirm PM dispatches to the global but cannot address the local via `assign_task_owner` or `send_message_to_agent`.
3. Boot with an in-progress task whose `agent_sessions` contains the local agent's id; verify recovery resumes it normally (flat ids → no migration needed).
4. Two plugins ship locals named `helper-agent` → confirm startup fails fast with the existing duplicate-id error. Rename one to `analytics-helper-agent` → confirm it loads.
5. Mark all agents in a plugin `local`; confirm the startup warning fires (no entry point) and the system boots.
6. Declare `visibility: local` on a repo agent; confirm webhook routing still works but PM cannot `assign_task_owner` to it.

**Type check + existing test suite:**
```
npm run typecheck
npm test
```

## Out of scope

- `subagent` (ephemeral) visibility — separate piece of work, requires SDK Task-tool integration and a different lifecycle.
- Qualified internal ids / persistence-key migration / on-disk path qualification — explicitly deferred. Plugin authors prefix internal agent filenames to avoid collisions.
- Cross-plugin permission/authorization beyond visibility (signed manifests, capability tokens) — not requested.
