# Migrating to the flat PM (0.2.0)

## What changed

Until 0.1.x a task ran several long-lived agent processes — a PM plus repo and plugin agents — that coordinated through message queues, a shared knowledge log and an owner handoff. From 0.2.0 a task runs exactly **one** agent, the PM: it loads any plugin skill into its own context and spawns workers through the SDK's built-in `Agent` tool when work is bulky, needs a fixed output envelope, or must be blind to the material it reviews. Skills and agent definitions are now loaded natively by the Claude Agent SDK from your plugin directories, MCP servers and the sandbox network allowlist are engine-owned root files, and repositories are mounted on demand instead of being bound to an agent. The engine and the plugins repo must be upgraded together — there is no compatibility flag.

## Who is affected

Anyone running Archie with their own plugins repo. If your plugins repo has `agents/*.md` files with `role`/`expertise`/`mcpServers`/`metadata.archie` frontmatter, per-plugin `.mcp.json` files, or no root `archie.json`, you have work to do before deploying 0.2.0. If you only use the bundled example plugins, `git pull` is enough.

## Step by step

**1. Upgrade both repos in one deploy.** Prepare the plugins-repo changes on a branch, point a staging instance at it (`ARCHIE_PLUGINS_BRANCH`), then merge and deploy the pair together.

**2. Convert your plugins.**

- **Skills stay as they are.** Every skill is now PM-loadable and namespaced `plugin:skill`, so same-named skills in different plugins no longer collide. Rewrite prose that assumes the old runtime: a task owner, `send_message_to_agent`, `log_finding`, `share_artifact`, `report_completion`, the knowledge log, "you are headless and hand content to the PM". A worker's returned result *is* the report; a review loop is spawn, read the verdict, revise, spawn again.
- **Keep an agent file only with a reason** — a fixed procedure and output envelope, a reviewer that must not see how the material was made, or a `model`/`effort`/`disallowedTools`/`skills` setting the PM cannot express per spawn. Agents that were only coordination shims get deleted; move their real content into a skill.
- **Trim the frontmatter** to `name`, `description`, `model`, `effort`, `disallowedTools`, `skills`, `memory`. Drop `role`, `expertise`, `mcpServers`, `allowedNetworkDomains`, `statusLabel` and the whole `metadata.archie` block, including repo bindings and per-agent `maxMode`. The `description` is now the only thing the PM reads when choosing a worker, so it must absorb what `role` and `expertise` carried.
- **Move MCP servers to the root `.mcp.json`** and delete the per-plugin copies — they are no longer connected. Every server there attaches to the session. Optionally give a server an `archie` block (`default`, `allow`, `ask`, `deny`, `titles`) to put critical calls behind per-call human approval; a per-agent `disallowedTools` list that belonged to the server becomes `archie.deny`.
- **Add a root `archie.json`** with `allowedNetworkDomains` (the union of every per-agent list you had — it is one sandbox allowlist for the whole session now) and `repos` entries carrying `warm` and `autoMerge`. Repos are no longer declared: the GitHub App installation is the allowlist, and warming is only a latency optimisation.

**3. Update the environment.** New: `ARCHIE_PM_MODEL`, `ARCHIE_PM_EFFORT` (the PM's model and effort, default `opus`/`medium`), `ARCHIE_PM_MAX_MODEL`, `ARCHIE_PM_MAX_EFFORT` (what max mode upgrades the PM session to, default `claude-fable-5-1`/`high`), and `ARCHIE_TASK_TIMEOUT_MS`. Removed: `ARCHIE_MAX_MODE_MODEL` and `ARCHIE_MAX_MODE_EFFORT` — max mode is now one switch over the whole session rather than a per-agent upgrade.

**4. Slack.** Scopes are unchanged by this release. Note that the reactions tool needs `reactions:read`; without it the tool now reports the missing scope instead of reporting "no reactions", which is a behaviour change you may notice in existing workflows.

## What happens to existing tasks

Session folders are compatible and are not rewritten by hand. On a task's first load the `repositories` map flattens from per-agent lists to one list per task and is persisted once; the on-disk `agents/pm` and `claude/pm` keys are unchanged, so usage and cost history keep their shape. Per-agent clones under `sessions/<task>/repos/…` are **adopted in place** — `mount_repo` picks up the existing clone rather than re-cloning, so check `git status` in each before continuing, since a former agent may have left uncommitted work. A one-time runtime-change notice is prepended to each pre-upgrade task's first wake, telling its PM that the specialists it was talking to are gone and which tools no longer exist.

What is lost: work a specialist agent had in flight but never relayed. Its process does not survive the upgrade and there is nothing in the new runtime to resume it. **Freeze new tasks for a short window before deploying** and let in-flight ones finish; anything still running should be re-asked after the upgrade.

## Checklist

- [ ] Plugins branch ready: agent frontmatter trimmed, shim agents deleted, prose rewritten
- [ ] Root `.mcp.json` holds every server; per-plugin copies deleted
- [ ] Root `archie.json` has the network allowlist and per-repo `warm`/`autoMerge`
- [ ] `.env` updated (`ARCHIE_PM_*`; old `ARCHIE_MAX_MODE_*` removed)
- [ ] Staging boot against the plugins branch: plugins all load, a skill loads, a worker spawns
- [ ] Task freeze, in-flight tasks drained
- [ ] Both repos merged and deployed together

## Rollback

Revert both repositories to the previous release together — the engine and the plugins repo are a matched pair, and reverting only one leaves a runtime that cannot read its own plugins.
