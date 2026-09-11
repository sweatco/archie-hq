# Migrating to the flat PM (0.2.0)

## What changed

Until 0.1.x a task ran several agent processes — a PM plus repo and plugin agents — coordinating through message queues, a shared knowledge log and an owner handoff. From 0.2.0 a task runs exactly **one** agent, the PM: it loads plugin skills into its own context and spawns workers through the SDK's built-in `Agent` tool. The SDK loads skills and agent definitions natively from your plugin directories; MCP servers and the network allowlist are engine-owned root files; repositories are mounted on demand, not bound to an agent. Engine and plugins repo upgrade together — there is no compatibility flag.

## Who is affected

Anyone running Archie with their own plugins repo: a `pm` overlay plugin, `agents/*.md` carrying `role`/`expertise`/`mcpServers`/`metadata` frontmatter, or no root `archie.json` all mean work before deploying. If you only use the bundled example plugins, `git pull` is enough.

## Step by step

**1. Back up task metadata.** Copy `workdir/sessions/*/shared/metadata.json` first: it is each task's on-disk state, the only thing the upgrade rewrites (at the task's next activation), and what makes a rollback survivable.

**2. Upgrade both repos in one deploy.** Prepare the plugins changes on a branch, point a staging instance at it (`ARCHIE_PLUGINS_BRANCH`), then merge and deploy the pair together.

**3. Retire the `pm` overlay plugin.** 0.1.x appended the body of `pm/agents/pm.md` to the PM's prompt and honoured that file's `mcpServers` and tool fields. 0.2.0 reads no overlay — outside a plugin directory it reads only the root `.mcp.json` and `archie.json`. Move the body into a skill the PM can load; standing organisational context is what a skill is for. The overlay's MCP and tool fields are dropped, since every server now attaches to the session regardless.

**4. Convert your plugins.**

- **Skills stay as they are**, now PM-loadable and namespaced `plugin:skill`, so same-named skills no longer collide. Rewrite prose assuming the old runtime — a task owner, the knowledge log, the removed tools below. A worker's returned result *is* the report.
- **Keep an agent file only with a reason** — a fixed output envelope, a reviewer blind to how the material was made, or a `model`/`effort`/`skills` setting the PM cannot express per spawn. Delete coordination shims; move their content into a skill.
- **Trim the frontmatter.** Keep what the SDK honours for a plugin agent: `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, plus the background and worktree isolation flags. Drop the rest — `role`, `expertise`, `mcpServers`, `allowedNetworkDomains`, `permissionMode`, `hooks`, and the whole `metadata` block with its repo bindings and `maxMode`. The `description` is all the PM reads when choosing a worker, so it must absorb what `role` and `expertise` carried.
- **Re-check MCP exposure.** The engine always read one root `.mcp.json`; what goes away is the per-agent `mcpServers` selector choosing which of those servers an agent saw. Every server now attaches to the one PM session, so anything you deliberately withheld from some agents is reachable everywhere in the task. Re-decide each: where a structural block is needed, put those tools in the server's `archie.deny` tier, sensitive-but-useful calls behind `ask`. Both root files are below.

**5. Update the environment.** New: `ARCHIE_PM_MODEL`/`ARCHIE_PM_EFFORT` (the PM's model and effort, default `opus`/`medium`), `ARCHIE_PM_MAX_MODEL`/`ARCHIE_PM_MAX_EFFORT` (max mode's upgrade, default `claude-fable-5-1`/`high`), and `ARCHIE_TASK_TIMEOUT_MS` (wall-clock cap before a task parks itself; default `3600000`, 60 minutes). Removed: `ARCHIE_MAX_MODE_MODEL`/`ARCHIE_MAX_MODE_EFFORT` — max mode is now one session-wide switch.

**6. Slack.** Scopes are unchanged, but the reactions tool now reports a missing `reactions:read` scope rather than "no reactions".

## The two root files

Both live at the plugins repository root. `.mcp.json` is the single source of MCP servers, every one of which attaches to the session:

```json
{
  "mcpServers": {
    "tracker": {
      "command": "node",
      "args": ["${MCP_TRACKER_PATH}"],
      "description": "Issue tracker",
      "archie": {
        "default": "ask",
        "allow": ["get_status"],
        "deny": ["delete_thing"],
        "titles": { "delete_thing": "Delete this item — irreversible" }
      }
    }
  }
}
```

Tool names in the tiers are **bare** — `get_status`, not `mcp__tracker__get_status`. `default` covers everything unlisted and is `ask` when omitted. A malformed `archie` block **fails plugin loading** rather than being dropped: an ignored typo would ungate a tool you meant to gate.

`archie.json` — the engine's own config:

```json
{
  "allowedNetworkDomains": ["example.com"],
  "repos": {
    "owner/repo": { "warm": true, "autoMerge": false }
  }
}
```

`allowedNetworkDomains` is the session's one outbound sandbox allowlist — the union of your per-agent lists. `repos[*].warm` warm-clones that repo at startup, a latency optimisation only: repos are no longer declared. `repos[*].autoMerge` allows merging its PRs without a per-merge approval. Only literal `true` opts in, and a missing or malformed `archie.json` degrades quietly to the empty config.

Details: [plugin-system.md](../architecture/plugin-system.md), [tool-approvals.md](../architecture/tool-approvals.md).

## What happens to existing tasks

When a task is next **activated**, its `repositories` map flattens from per-agent lists to one list per task and is persisted once; a task only listed or looked up keeps its old shape. Where several agents had mounted the same repository, **only the first entry survives**. The other per-agent clones stay on disk under `sessions/<task>/repos/<agent>/…`, unreferenced — inspect each by hand for uncommitted work before deleting anything. The surviving clone is adopted in place rather than re-cloned, so check its `git status` too.

A one-time notice rides each pre-upgrade task's first wake, telling its PM the specialists are gone and naming the removed tools: `send_message_to_agent`, `assign_task_owner`, `spawn_repo_agent`, `log_finding`, `share_artifact`, `get_agents_status`. `report_completion`, `request_edit_mode`, `mount_repo` and the comms and scheduling tools do still exist — but they are **PM-only**: a worker calling one is denied and told to return its result to the PM.

What is lost: work a specialist had in flight but never relayed — nothing in the new runtime can resume it. **Freeze new tasks briefly before deploying**, let in-flight ones finish, and re-ask anything still running.

## Checklist

- [ ] `metadata.json` backups taken
- [ ] Overlay body moved into a skill; frontmatter trimmed; shim agents deleted
- [ ] Root `.mcp.json` re-reviewed, tiers set; root `archie.json` written
- [ ] `.env` updated (`ARCHIE_PM_*`, `ARCHIE_TASK_TIMEOUT_MS`; `ARCHIE_MAX_MODE_*` gone)
- [ ] Staging boot: plugins load, a skill loads, a worker spawns
- [ ] Tasks frozen and drained, both repos deployed together

## Rollback

Roll both repositories back together: reverting one alone leaves a runtime that cannot read its own plugins. Restoring the metadata backup is the other half: a task activated under 0.2.0 carries the flat `repositories` shape, and the old engine drops such a task's repository attachments — clone paths, branch states, PR numbers — with a warning. Restore `shared/metadata.json` for the tasks you still need; tasks never activated under 0.2.0 were never rewritten and need nothing.
