# Flat PM rework: design notes and order of work

Design notes agreed before the flat-PM rework was built (September 2026). Kept as the rationale record; the architecture docs describe the result. Companion: `20260910-plugins-flat-migration.md` for the plugins repository side.

## 1. The idea in one paragraph

Archie today runs several long-lived agent processes per task (PM, repo agents, plugin agents) that coordinate through message queues, a shared knowledge log, owner handoffs and a recovery watchdog. The rework runs exactly one agent per task, the PM, as a long-lived Claude Agent SDK session. Everything else is either a skill the PM loads into its own context or a subagent the PM spawns through the SDK's built-in Agent tool when the work is bulky, needs a fixed discipline, or must be blind to the PM's material. The PM does small conversational and operational work itself. Coordination between workers is the PM's job, done in prose, not enforced by machinery. Plugins are loaded by the SDK itself, not by our own loader.

## 2. Why roles existed and why most of them go away

Today each agent bundles three unrelated things: knowledge (skills and prompt), access (MCP servers, repo binding) and a process. Processes were the only way to scope knowledge and access, so every domain got an agent whether it needed one or not. Evidence from the plugins repo: the backend agent's own prompt is three lines, growth-ops and ops are a tool grant plus ten skills each, the PM overlay file is empty and its 24 skills are already PM knowledge.

Once the PM can load any skill and spawn any worker, a role earns a definition file only if one of three things is true:

- Bulk: the work floods context and must run outside the PM. This is a property of the task, not the domain, and the PM judges it per spawn.
- Discipline: a fixed procedure and output envelope matter enough to bake into a prompt. Analytics is the clear case.
- Blindness: a reviewer must not see the generation material. The two reviewers are the clear cases.

Growth and ops meet none of these. A task that uses growth or ops skills usually uses nothing else, so loading those skills into the PM's context is fine, and when a step is heavy the PM spawns a generic worker for it.

## 3. Decisions agreed

1. One PM session per task, Opus, resumed across turns. It is the only agent Archie runs itself and the only one allowed to post to Slack.
2. Delegation is through the SDK Agent tool. Workers are either the built-in general-purpose subagent with a model chosen per spawn, or a named agent shipped by a plugin.
3. No per-subagent isolation machinery in the first version. No worktree hook, no per-subagent path policy. The isolation boundary is the task: one session folder, one clone per repo the PM mounts, everything inside writable, base clones read-only. The PM keeps two workers off the same clone by briefing them, not by enforcement.
4. Plugins contribute exactly two things: skills and agents. Both are loaded natively by the SDK's `plugins` option. The engine owns nothing domain-shaped.
5. The engine owns the root MCP config. It has more in it than the standard format allows: server declarations, env interpolation, OAuth injection, and default human-in-the-loop rules (deny and ask tiers). The engine reads it, interpolates, injects tokens and passes the servers inline to the session.
6. No repo declarations. The GitHub App installation is the allowlist. The PM can mount any repo the App can see. Base branch comes from the GitHub default branch. Auto-merge overrides live in one small root file.
7. No engine-owned worker definitions. If effort variety for coding matters, the plugins repo ships two or three coder agent files with different model and effort and the PM picks one per task. If not, the PM spawns the generic worker with a model and a brief and no definition exists anywhere.
8. One engine prompt, the PM's, trimmed to what is engine-invariant: tasks, Slack, edit mode, approvals, delegation, context protection. No worker preamble. Everything domain-shaped, including the git and PR flow, moves into skills.
9. Edit mode stays a per-task, one-way approval gate. Before approval the task's clones are deny-write and the push and PR tools are absent. Approval flips both and resumes the PM session with the new configuration.
10. Recovery shrinks to a Stop hook that reads outstanding background tasks, plus the existing task timeout and the existing background-task settle handling that wakes the PM when a worker finishes.
11. Review loops go through the PM: spawn the blind reviewer, read the verdict, revise, respawn. Nested spawning is available in the SDK if a worker genuinely needs a helper, but we do not design around it.
12. Both repositories flip in one deploy. No runtime flag and no compatibility shims. Develop on paired branches, boot the pair with the E2E harness, merge both, deploy. Rollback is reverting both.
13. Prompt rule for the PM: workers return short structured summaries, and anything expected to produce more than a screen of output goes through a worker regardless of domain. Auto-compaction is on but is not relied upon.

## 4. Target shape

### Engine (archie-hq)

- One PM session per task. Plugin directories passed through the SDK `plugins` option. Root MCP servers passed inline through `mcpServers`.
- A `mount_repo(name)` tool that shared-clones a base repo into the session folder and returns the path. The PM passes the path into worker briefs.
- One sandbox policy per task: workdir read-only, base clones deny-write, session folder writable. Network egress is the union of what any role needed, which today is four domains.
- Root MCP config handling: read, interpolate `${MCP_*}`, inject OAuth headers on every activation, pass inline. Deny tiers feed the SDK disallowed-tools option. Ask tiers feed the existing PreToolUse approval gate, now session-wide and live for the first time.
- Edit mode per task as above. Stop hook plus timeout for recovery.
- Prompts: `pm-agent.md` trimmed. `agent-core.md`, `repo-agent.md`, `plugin-agent.md`, `triage-agent.md` deleted. Memory prompts unchanged.
- Plugin handling that remains ours: git clone and pull of the plugins repo, enumerating plugin directories, asserting on the init message that every plugin loaded (failures are silent skips), calling `reloadPlugins()` after a pull.

### Plugins (archie-plugins)

- Skills: one flat set, all PM-loadable, namespaced by the SDK as `plugin:skill`, so same-named skills in different plugins no longer collide. The nine PM/specialist duplicates are still merged because they are duplicates, not because they collide. PM skills fold into their domain plugins. The git and PR flow becomes an engineering skill that coders load.
- Agents: four definitions remain with a stated reason. data-analyst for discipline. tov-reviewer and qa-reviewer for blindness. release-manager for its deny list protecting release state. Optionally two or three coder variants for effort.
- Deleted as definitions, their few real facts moved into skills: backend, mobile, infrastructure, archie, growth-ops, ops, copywriter, qa-analyst.
- Per-plugin `.mcp.json` copies removed. Servers live only in the engine-owned root config.
- Frontmatter contract for the remaining agents, all honoured natively by the SDK: name, description, model, effort, disallowedTools, skills (preloads, does not restrict). Dropped: role, expertise, mcpServers (ignored for plugin agents), allowedNetworkDomains, the Archie metadata block with repo bindings.

### The user's "stable role" idea

It survives as a runtime object rather than a plugin file. A finished subagent returns an agent id, and the PM can resume it later with its full prior context. The PM keeps ids in task metadata and re-addresses the same coder for follow-ups on the same repo within a task. Agent memory (a persistent notes file per agent type) gives state across invocations without context. Agent teams and teammates are not available from the SDK and are not part of the design.

## 5. What gets simplified or removed

| Subsystem | Verdict | Note |
|---|---|---|
| Message queues, `send_message_to_agent`, owner handoff | Removed | The Agent tool result is the reply |
| `knowledge.log` writers and readers | Removed | PM context is the shared context |
| Recovery nudge-and-respawn, idle debounce, owner-targeted reinforcement | Rewritten | Stop hook plus timeout, one agent |
| Triage agent | Removed | Already dead, call site commented out |
| Plugin loader scanning, skill symlinking, core skill mounts, skill-path resolution | Removed | SDK `plugins` option loads skills and agents natively |
| Per-agent MCP interpolation and subsetting, policy merge | Removed | One root config, one session |
| Per-agent clones under `sessions/{task}/repos/{agentId}/` | Rewritten | One clone per repo per task, webhook lookup by branch preserved |
| Registry two-track repo/plugin agent building, dynamic repo agents, peer visibility | Removed | Plugin agents are loaded by the SDK |
| `spawn_repo_agent`, `assign_task_owner`, `get_agents_status`, `log_finding`, `share_artifact` | Removed | |
| Tool approval gate | Simplified and made live | Session-wide instead of per agent; driven by tiers in the root config |
| Three worker prompt layers | Removed | Plugin agents carry their own prompt; generic workers get the PM's brief |
| Sandbox network allowlist | Simplified | One union instead of per-agent lists |
| Multi-agent status composition, per-agent usage rows, API and CLI agent bar | Simplified | One PM line; subagent token roll-up stays |
| Metadata fields: `task_owner`, `participants`, `dynamic_agents`, `agent_sessions`, `TriageResult` | Removed or collapsed | `repositories` re-keyed per task |

## 6. What stays unchanged

- Slack connector, thread-to-task linkage, canvases, pins. Posting was PM-only already.
- GitHub App auth, PR tooling (the largest keep block), webhooks. All already task-keyed.
- OAuth vault. Same code, header injection run on every PM activation so a long-lived session does not hold stale tokens.
- Memory subsystem. Attaches in one line at spawn, write path already per task.
- Triggers and scheduling tools. Orthogonal.
- Sandbox filesystem policy. Same three layers.
- Background-task settle handling. The SDK's task-started and task-notification messages already wake the PM.
- In-process MCP servers the PM needs: comms, orchestration (minus the removed tools), scheduling, repo tools, research, file bridge.

## 7. Facts about the SDK the design rests on

Verified against the installed SDK 0.3.220 and its bundled CLI, with the latest 0.3.263 adding nothing relevant.

- The `plugins` option invokes the full Claude Code plugin loader: skills, agents, commands, hooks, `.mcp.json`, `bin/`. No marketplace or manifest needed. Skills are namespaced `plugin:skill` and need no setting sources. Plugin agents are spawnable as `plugin:agent`. `reloadPlugins()` refreshes skills and agents without a restart.
- Plugin agents honour name, description, model, effort, tools, disallowedTools, skills, memory, background and worktree isolation. They ignore mcpServers, permissionMode and hooks with a warning. Unknown fields are tolerated.
- A root `.mcp.json` outside a plugin has no SDK path. Servers go inline through `mcpServers`. This is why the engine owns the root config.
- Subagents run in the PM's process and share its cwd, additional directories, sandbox and network policy. There is no per-subagent cwd, sandbox or filesystem grant.
- Per-spawn Agent tool input takes a model (sonnet, opus, haiku, fable) but not effort or tool restrictions. A generic worker inherits the session's effort. Effort variety needs agent files.
- Background subagents are the default. The parent's turn can end while a worker runs. The host must re-engage the parent, which Archie already does.
- Subagent results are the only thing that reaches the parent context. Intermediate tool output stays inside the worker.
- Subagent resume by agent id exists and survives a process restart while the parent session id survives.
- Subagents can spawn subagents up to three layers deep and can message siblings by name. Not used in the first version.
- Tool search is on by default and defers all tool schemas. Attaching many MCP servers costs roughly a name per tool. This is why plugin agents seeing every server is acceptable.
- Under bypass-permissions mode the permission callback is bypassed. Any per-call policy has to be a PreToolUse hook, which both the filesystem guard and the approval gate already are.
- Worktree isolation on the Agent tool requires the PM's cwd to be inside a git repo, or a WorktreeCreate hook. Deliberately not used in the first version.
- Workflow tool is available for large fan-outs with structured outputs that never touch PM context. Available for analytics later.

## 8. Security posture change to name in the docs

Today each agent is its own bubblewrap process with its own MCP servers and network allowlist, so a data-analyst process cannot reach the GitHub token and only the ops agent's shell can reach the production admin host. In the flat model every worker runs in the PM's process, the credential set and network allowlist are the union across roles, and per-worker tool restriction is model-facing policy rather than containment. Accepted for an internal system, but security.md must stop promising the old boundary. The human-in-the-loop tiers in the root config become the primary protection for production writes.

## 9. Order of work

### Phase 1, engine

1. Single-session task runtime. Per-agent process map becomes one PM handle. Metadata drops owner, participants, dynamic agents, triage, per-agent sessions. Clone list re-keys per task with the webhook lookup preserved. Recovery becomes Stop hook plus timeout. Reinforcement prompts stop naming the messaging tool.
2. Native plugin loading. Pass plugin directories through the `plugins` option. Delete scanning, skill symlinking, core skill mounts, agent definition building. Keep clone, pull, enumeration, init assertion, reload after pull.
3. Repo mounting. `mount_repo` shared-clones into the session folder. Repo tools bind to task clones. Edit approval flips the clone writable and resumes the PM, with a guard for the resume-before-flip race the current code handles for repo agents.
4. Root MCP config. Read, interpolate, inject OAuth on every activation, pass inline. Deny tiers to disallowed tools. Ask tiers to the approval gate, session-wide. File bridge always on.
5. Sandbox. One policy with the union allowlist.
6. Deletions. Triage, agent-tools server, knowledge log, peer visibility, dynamic agents, multi-agent status, API and CLI agent bar, three worker prompt layers.
7. PM prompt trimmed to engine-invariant behaviour with the delegation and context-protection rules.
8. Docs and tests. Rewrite agents, orchestration, plugin-system, security, tool-approvals, edit-mode, persistence. E2E scenarios: PM answers directly, PM spawns the analyst, edit mode with a coder, background worker completion wakes the PM, an ask-tier tool call pauses for approval.

### Phase 2, plugins

Starts once the frontmatter contract from engine step 2 is fixed.

1. Merge the nine duplicated skill pairs. Fold PM skills into domain plugins. Rewrite delegation prose from messaging to spawning. Remove every task-owner reference. Turn the repo-agent git and PR flow into an engineering skill.
2. Delete the nine agent files. Move real facts into skills: the backend New Relic sampler note, the infrastructure blast-radius rules, the mobile must-load list, the archie self-improvement runbook.
3. Remove per-plugin `.mcp.json` copies. Add deny and ask tiers to the root config where mobile and release-manager had hand-written deny lists and where prompts currently enforce human confirmation (ops publish, MoEngage send, streak writes).
4. Repo policy file with auto-merge overrides. Drop repo frontmatter.
5. Apply the frontmatter contract to the remaining agents. Add coder variants if effort variety is wanted.
6. Fix on the way: growth is missing from the marketplace manifest.

### Phase 3, cutover

Boot the branch pair through the E2E harness, run the scenarios, merge both, deploy, watch a week of tasks against the usage records.

## 10. Sizing

Across the touched engine files: roughly 900 lines deleted, 2,100 rewritten, 4,400 simplified, 3,300 kept, before counting the plugin loader and skill wiring (about 700 more lines removed by native loading). About 500 test lines deleted outright and 640 rewritten. The largest kept block is the PR tooling. In the plugins repo: nine agent files removed, nine skill pairs merged, 24 PM skills relocated, prose edits wherever skills mention agents or messaging tools.

## 11. Load-bearing details not to miss

- `task_owner` is read by recovery to pick the nudge target, not just displayed. Replace the Stop hook before deleting the field.
- `getAgentStatus()` is on the API contract and the CLI task list renders its count.
- `metadata.repositories` is keyed by agent id and the webhook handler walks every agent's clones to resolve a PR to a task. The re-shape must keep that lookup working.
- `agent_sessions` is the only on-disk record of which sessions to resume at startup and which to clear on max-mode.
- The recovery reinforcement prompt names three tools verbatim, including the messaging tool.
- The dead triage module is still asserted on by a render-path structure test.
- The per-agent session directory layout drives per-agent cost derivation, so collapsing it changes historical report shape.
- Plugin load failures are silent skips. Without an init assertion a broken plugin would vanish quietly.
- The SDK `env` option replaces the process environment. Spread `process.env` so `${MCP_*}` values and HOME survive.
- Two architecture docs are already stale: orchestration.md cites a file that no longer exists and plugin-system.md describes a repo config format the plugins repo dropped.

## 12. Still to verify before building

- Whether the plugins clone URL can carry a branch ref, so the E2E harness can boot an engine branch against a plugins branch.
- That deny tiers for MCP servers can be expressed with the SDK's disallowed-tools patterns. The last check suggested they can.
- Measured token cost of listing about 75 skill descriptions in the PM's system prompt. Expected to be a few thousand tokens.
- Whether the PM should be allowed to read code directly. Recommendation: keep the "delegate investigations" rule for context protection, allow quick lookups.
- Whether plugin MCP server reload in a headless session matters to us. It should not, since servers live in the engine-owned root config, not in plugins.
