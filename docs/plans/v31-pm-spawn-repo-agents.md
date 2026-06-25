# PM on-demand repo-agent spawning

> **Status: implemented.** Follow-up to v30 (multi-repo agents, eager-mount).
> This is the "deferred" half of the v30 plan, rebuilt on the eager-mount
> foundation so it needs no respawn machinery.

## Context

v30 let a repo agent declare multiple repos in plugin frontmatter, all mounted
at spawn. But standing Archie up against a new repo still meant editing the
plugins repo and waiting for a sync. This adds the on-demand path: the **PM can
spawn a repo agent at runtime** for any repo the GitHub App can reach, pick the
exact repo set, and put it to work — no redeploy, no config change.

Because v30 mounts eagerly, a spawned agent simply mounts its repos when first
messaged. None of the original design's respawn/attach machinery is needed —
this PR is purely additive.

## Approach

Two PM-only tools on the `orchestration-tools` MCP server:

- **`list_available_repos()`** — paginates `GET /installation/repositories` via
  the GitHub App client (`GitHubClient.listAccessibleRepos`). Tags repos a
  plugin specialist already covers (`findAgentDefsContainingRepo`). Cached on
  the `Task` instance for the task's lifetime.
- **`spawn_repo_agent({ shortname, repos, role?, expertise? })`** —
  - Validates each requested repo is reachable (`GitHubClient.resolveRepo`),
    filling in a default base branch.
  - Anti-duplication: rejects a github already owned as a plugin specialist's
    primary (PM should message that specialist instead).
  - Builds a `DynamicAgentSpec` (id `<shortname>-<4hex>-agent`, first repo =
    primary), persists it to `metadata.dynamic_agents`, and pushes the live
    `AgentDef` (`synthesizeDynamicAgentDef`) onto `task.team`.

### Reachability = "the team roster, not just the registry"

Dynamic agents live in `task.team` (registry agents ⨁ rehydrated specs), not the
global registry. So the messaging/visibility helpers take an optional team
roster:

- `getVisiblePeerIdsForSender(senderDef, team = registry)` and
  `buildPeerListForSender(senderDef, team = registry)` filter over the passed
  roster.
- `send_message_to_agent` and `assign_task_owner` enums, and the spawn-time peer
  lists, pass `task.team` — so a spawned agent is immediately a valid
  target/owner/peer. When a task has no dynamic agents, `task.team` equals the
  registry and behaviour is unchanged.

### Persistence & recovery

Only the PM-supplied inputs are stored (`DynamicAgentSpec`), never a derived
`AgentDef`. `Task.get` rehydrates them via `synthesizeDynamicAgentDef` and
merges into the team before the task is constructed, so reloads and process
restarts see the agent. The agent eager-mounts its repos on first spawn exactly
like any repo agent (lazy base-cache clone covers a repo not pre-warmed at
startup).

## Files

- `src/types/task.ts` — `DynamicAgentSpec`, `TaskMetadata.dynamic_agents`.
- `src/agents/registry.ts` — `synthesizeDynamicAgentDef`,
  `findAgentDefsContainingRepo`, `team` param on the two peer helpers.
- `src/connectors/github/client.ts` — `listAccessibleRepos`, `resolveRepo`.
- `src/tasks/task.ts` — rehydrate `dynamic_agents` into the team in `Task.get`.
- `src/agents/tools.ts` — the two tools; team-scoped messaging/ownership enums.
- `src/agents/spawn.ts` — peer lists built over `task.team`.
- `prompts/pm-agent.md`, `docs/architecture/agents.md` — guidance + reference.

## Out of scope

- On-demand `attach_repo` (mounting a repo mid-conversation) — eager mounting at
  spawn covers the need; revisit only if lazy mounting becomes necessary.
- Letting a spawned agent change its own repo set after spawn — to retarget,
  the PM spawns another agent.

## Verification

- Unit: `synthesizeDynamicAgentDef` (primary, base defaults, empty-list throw);
  dynamic agent visible via `task.team` but not the bare registry;
  `findAgentDefsContainingRepo` for anti-dup; tool-contract lists the two tools.
- Manual: `list_available_repos` → `spawn_repo_agent` against an uncovered repo
  → `send_message_to_agent` to the new id → it mounts the repo and reports back;
  reload the task and confirm the agent is rehydrated and still reachable;
  confirm anti-duplication rejects a plugin specialist's primary.
