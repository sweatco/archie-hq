# Agents Architecture

This document describes the agent types, communication protocols, prompt composition, and behavioral patterns implemented in the Archie system. All descriptions reflect the actual codebase.

## Agent Types

Archie uses three active agent types (plus a disabled triage classifier). Each is backed by a specific Claude model and serves a distinct role:

| Agent Type | Model | Count | Role |
|---|---|---|---|
| ~~Triage Agent~~ | Haiku | — | Event classifier (**currently disabled** — see below) |
| PM Agent | Opus (default) | 1 per task | Task manager, user interface, agent coordinator |
| Repo Agents | Sonnet (default, configurable) | 1 per plugin-defined repo agent per task | Codebase investigation and modification; declares one or more repos in frontmatter, all mounted at spawn |
| Plugin Agents | Sonnet (default, configurable) | 1 per plugin agent per task | Lightweight, read-only domain specialists |

Models for repo and plugin agents come from each agent's plugin frontmatter (`model` field, with `effort` and `maxTurns` also supported); `Sonnet` is the fallback when frontmatter is silent. The PM agent defaults to Opus but can be overridden by the `pm` plugin overlay's frontmatter (see `src/agents/registry.ts` `buildPmDef()` and `src/agents/spawn.ts`).

### Triage Agent (currently disabled)

**Source**: `src/system/triage.ts` (still on disk, but no callers)

The triage agent is **not invoked** by the running system. In `src/connectors/slack/events.ts` the `triageSlackMessage` import and dispatch block are commented out — every incoming Slack event is routed directly to the PM agent:

- A fresh `Task` is created (and `AGENT_PROMPTS.newTask` sent to the PM) on an `@mention`, a DM, or a human reply to a thread Archie itself started (`rootAuthorWasBot` — a top-level message it posted via the `post_to_channel` explore tool).
- A reply in a thread already linked to a task appends the new messages and sends `AGENT_PROMPTS.existingTask` to that task's PM.
- A reply in a human-started thread the bot didn't start is ignored.

GitHub events follow the same deterministic pattern in `connectors/github/webhooks.ts` (PR reviews, push events, CI results) — none of them call triage either.

The classifier code remains in the repository for potential re-enablement. When it ran, it was a stateless Haiku-backed call that used `query()` from the Claude Agent SDK with `outputFormat: { type: "json_schema" }` and the following Slack schema:

```typescript
{
  action: "new_task" | "existing_task" | "cancel_task" | "noop",
  task_id?: string,
  confidence: "high" | "medium" | "low",
  similar_tasks?: string[],
  reasoning: string
}
```

It had access to `Glob`, `Grep`, and `Read` to search `sessions/` for matching tasks. The disabled call site is preserved in `events.ts` as a commented block referencing `triageSlackMessage`.

### PM Agent

**Source**: `src/agents/agent.ts`, `src/agents/spawn.ts`, `src/agents/tools.ts` (`createPMAgentMcpServer`)

One PM agent instance is spawned per task. It is the orchestrator: it receives all external input (from connectors), delegates work to specialist agents, communicates with users (Slack, CLI, GitHub), and manages the task lifecycle.

**Model**: Opus by default (`def.model || 'opus'` in `spawn.ts`). Overridable through the `pm` plugin overlay's frontmatter, which can also set `effort` and `maxTurns`.

**Tools** (registered on the `pm-agent-tools` MCP server):

| Tool | Purpose |
|---|---|
| `send_message_to_agent` | Send instructions/questions to any agent |
| `post_to_user` | Send a message to the user. Routes to the default linked channel or an existing linked thread (`target.channel`). The Slack/CLI/GitHub specifics live in `Task.postToUser`, so the PM never picks a transport directly. The PM cannot open new DMs or new task-linked threads — it stays where the task lives (in a channel thread, `@mention` people there; in a DM, stay 1:1). |
| `post_files_to_user` | Upload files to an already-linked thread (default channel or `channel` key). Does not open new destinations. |
| `share_artifact` | Publish an immutable, deduped snapshot of a file under `<task>/shared/artifacts/` for inter-agent sharing. |
| `find_slack_user` / `find_slack_channel` | Look up Slack user/channel IDs and metadata (e.g. a channel ID before reading, searching, or posting to it). |
| `read_channel_history` / `read_thread` | Read a PUBLIC channel's recent messages, or a specific thread — exploration only, not linked to the task. Private channels and DMs are refused (`assertPublicChannel`). |
| `search_messages` | Search messages across PUBLIC channels Archie is in (`search.messages`, `search:read.public` scope); private/DM matches are excluded. |
| `post_to_channel` | Post into a channel/thread WITHOUT linking it to the task. Member-gated by Slack; DMs refused. A human reply to a new top-level message posted here starts its own fresh task. |
| `assign_task_owner` | Designate an agent as task owner |
| `report_completion` | Optionally post a final message, then stop the task |
| `request_edit_mode` | Post an interactive Approve/Deny prompt to the default channel and pause the task |
| `get_agents_status` | Check which agents are spawned and active |
| `mute_channel` | Disengage from one Slack channel/thread (the one named via `channel`, or the task's default channel) until the bot is @mentioned there again. DM channels cannot be muted |
| `parse_datetime` / `set_reminder` / `cancel_reminder` | Schedule a reminder that wakes the task at an ISO datetime |
| `list_available_repos` | List repos the GitHub App installation can reach (paginates `GET /installation/repositories`); tags repos a plugin specialist already covers. Cached per task. |
| `spawn_repo_agent` | Create an on-demand repo agent bound to a chosen list of available repos (eager-mounted at spawn). Persists a `DynamicAgentSpec` to `metadata.dynamic_agents` and adds it to `task.team`. Rejects a repo already owned as a plugin specialist's primary. |

The `Skill` tool is provided by the Claude Agent SDK itself (not by `pm-agent-tools`); skills are mounted from the `pm` plugin's `skills/` directory and surfaced via `.claude/skills/` symlinks plus `settingSources: ['project']`. Built-in `Read`, `Glob`, and `Grep` tools are available against the PM workspace and the shared task folder (which is mounted read-only via `additionalDirectories`); `WebSearch` and `WebFetch` are explicitly disallowed.

PR lifecycle tools (push, create PR, merge, etc.) live on repo agents via the `repo-tools` MCP server — the PM has no direct git or GitHub access.

**Key behaviors**:

- Presents as a unified "Archie" persona -- never exposes internal agent mechanics to users
- Uses `<situation_analysis>` tags for structured reasoning before every action
- Loads domain-specific skills via the `Skill` tool before delegating work
- Follows the "waiting-for" mental model: after delegating to an agent the turn ends naturally; after responding to the user it calls `report_completion` to pause the system
- Dynamically builds its team list from all loaded repo and plugin agent configs at startup

### Repo Agents

**Source**: `src/agents/agent.ts`, `src/agents/spawn.ts`

Repo agents declare one or more repositories in their plugin frontmatter (`metadata.archie.repos: [...]` plus optional `primary`). **Every declared repo is mounted at spawn** — there is no runtime attach. The primary is the default target for `repo-tools` when the `github` arg is omitted. They investigate code, make changes (in edit mode), and coordinate with other agents. Configuration comes from plugins via `src/agents/registry.ts`.

The pre-v30 singular shape (`metadata.archie.repo: {github, baseBranch}`) is still accepted — the plugin loader synthesizes the plural shape on load.

**Model**: Sonnet by default (`def.model || 'sonnet'` in `spawn.ts`). Overridable per-agent via plugin frontmatter.

**Multi-repo mounts**: Each spawn iterates the agent's declared `repos` list, ensures an `AttachedRepo` record exists in `metadata.repositories[agentId]` for each (preserving the clone/branch state of repos already present), runs `setupSharedClone` per repo, and aggregates all clone paths into `additionalDirectories` and the sandbox `allowReadPaths`/`allowWritePaths`/`denyWritePaths`. Each repo gets its own task-local clone at `sessions/{taskId}/repos/{agentId}/{org}/{repo}/` — two agents that declare the same github get two independent clones with independent branch state. Because the loop iterates the *declared* list, adding a repo to an agent's frontmatter makes it mount on the next spawn (so an old task picks it up on recovery), and removing one simply stops mounting it (a stale metadata record is harmless).

**Tools** (via MCP servers `repo-agent-tools`, `repo-tools`, and `research-tools`):

| Tool | MCP Server | Availability | Purpose |
|---|---|---|---|
| `send_message_to_agent` | `repo-agent-tools` | Always | Report findings or coordinate with peers |
| `log_finding` | `repo-agent-tools` | Always | Write to shared knowledge log |
| `share_artifact` | `repo-agent-tools` | Always | Publish an immutable snapshot to `shared/artifacts/` |
| `web_research` | `research-tools` | Always | Spawn a research pipeline |
| `fetch` | `repo-tools` | Always | Fetch latest refs from origin |
| `switch_branch` | `repo-tools` | Always | Switch branches with auto-stash/pop |
| `list_prs` | `repo-tools` | Always | List PRs with filters |
| `get_pr` | `repo-tools` | Always | Get full PR details including diff |
| `get_pr_status` | `repo-tools` | Always | Check PR mergeable state |
| `get_pr_reviews` | `repo-tools` | Always | Review-level summary (approvals, change requests) |
| `get_pr_comments` | `repo-tools` | Always | Top-level PR conversation comments |
| `get_review_threads` | `repo-tools` | Always | Line-level review threads with thread/comment IDs |
| `Read`, `Glob`, `Grep` | (built-in) | Always | Investigate repository code |
| `git log`, `git diff`, `git show`, `git blame`, `git branch` | (Bash) | Always | Read-only git inspection |
| `Write`, `Edit` | (built-in) | Edit mode | Modify files in the clone |
| `git add`, `git commit`, `git status`, `git merge`, `git restore`, `rm`, `git rm` | (Bash) | Edit mode | Stage, commit, and manage changes |
| `push_branch` | `repo-tools` | Edit mode | Push commits to origin |
| `create_pull_request` | `repo-tools` | Edit mode | Create a PR on GitHub |
| `update_pr` | `repo-tools` | Edit mode | Update PR title/description/base |
| `add_pr_comment` | `repo-tools` | Edit mode | Add a general PR comment |
| `add_review_comment` | `repo-tools` | Edit mode | Start a new review thread on a specific line |
| `reply_to_review_comment` | `repo-tools` | Edit mode | Reply inside an existing review thread |
| `resolve_review_thread` | `repo-tools` | Edit mode | Mark a review thread as resolved |
| `request_re_review` | `repo-tools` | Edit mode | Request reviewers to re-review |
| `merge_pull_request` | `repo-tools` | Edit mode | Merge a PR |
| `close_pull_request` | `repo-tools` | Edit mode | Close a PR without merging |
| `create_branch` | `repo-tools` | Edit mode | Create and switch to a new branch |
| `list_branches` | `repo-tools` | Always | List branches visited by this agent in the current task |

`WebSearch` and `WebFetch` are explicitly disallowed for repo agents. In read-only mode the write-side `repo-tools` entries above are added to `disallowedTools` in `spawn.ts`, and the OS-level sandbox + `createFilesystemGuardHooks` together block `Write`/`Edit` to the clone.

**Multi-repo `github` arg**: every `repo-tools` entry that targets a specific repo accepts an optional `github: "org/repo"` argument. Omitted, the tool acts on the agent's primary repo. The handler validates the github is in the agent's declared `repos` list (via `resolveGithub`); local-clone tools additionally require the repo to have a local clone present (via `requireAttached`), which it always does post-spawn.

**Dual mode system**: The agent's mode is set per-task by `metadata.edit_allowed`. In read-only mode the sandbox makes every attached clone read-only and write-side MCP tools are disallowed; in edit mode every attached clone is writable and all `repo-tools` entries are exposed. The agent observes its mode through the available tool set and the injected `READ-ONLY` / `READ-WRITE` annotation in its system prompt. Edit mode is global to the task — when approved, RW applies to the primary and to every attached repo.

**Working directory**: The agent's cwd is its per-agent workspace at `sessions/{taskId}/agents/{agentId}/` — a pure scratch space that never contains repo state. Each mounted repo lives at `sessions/{taskId}/repos/{agentId}/{org}/{repo}/` (sibling of the agent's cwd, not nested inside it) and is exposed via `additionalDirectories`. Per-agent clone paths mean two agents that declare the same github get fully independent working trees. In read-only mode each clone is checked out on its base branch; in edit mode each carries an `archie/{taskId}` branch (or a previously persisted one). Shared task state at `sessions/{taskId}/shared/` is also mounted read-only.

### Dynamic Repo Agents (PM-spawned)

The PM can spawn a repo agent on demand via `spawn_repo_agent({shortname, repos, role?, expertise?})` — for repositories no plugin agent covers, without a redeploy. It behaves exactly like a plugin-defined repo agent (eager-mounts all its repos at spawn, same `repo-tools`, same lifecycle), differing only in:

- No plugin Layer-3 prompt body, no skills, no plugin MCP servers — just the universal protocol + the repo-agent track extension + a generic role/expertise.
- Its `repos` come from the PM's spawn args (validated reachable via `GitHubClient.resolveRepo`) rather than plugin frontmatter.
- Its id is `<shortname>-<4hex>-agent`, and its `visibility` is `global`.

Only the PM-supplied inputs are persisted, as a `DynamicAgentSpec` in `metadata.dynamic_agents`. On every `Task.get`, `synthesizeDynamicAgentDef` rebuilds the live `AgentDef` from each spec and merges it into `task.team` — so peer lists, `send_message_to_agent`/`assign_task_owner` enums (all filtered over `task.team`), and `ensureAgentSpawned` see it after a reload or process restart. There is no respawn machinery: a freshly-spawned agent just mounts its repos when first messaged.

**Anti-duplication**: `spawn_repo_agent` rejects a github already covered as a plugin specialist's primary, steering the PM to message that specialist instead. `list_available_repos` tags such repos so the PM sees it before spawning.

### Plugin Agents

**Source**: `src/agents/agent.ts`, `src/agents/spawn.ts`

Plugin agents are lightweight, read-only agents for domains that don't need git or GitHub infrastructure. They are loaded from plugins that lack a `repo-config.json`.

**Model**: Sonnet by default (`def.model || 'sonnet'` in `spawn.ts`). Configurable via frontmatter `model` (and `effort`, `maxTurns`).

**Tools**:

| Tool | MCP Server | Purpose |
|---|---|---|
| `send_message_to_agent` | `repo-agent-tools` | Report findings or coordinate with peers |
| `log_finding` | `repo-agent-tools` | Write to shared knowledge log |
| `share_artifact` | `repo-agent-tools` | Publish an immutable snapshot to `shared/artifacts/` |
| `web_research` | `research-tools` | Spawn a research pipeline |
| `Read`, `Glob`, `Grep` | (built-in) | Explore files in the agent workspace and (read-only) shared folder |
| `Skill` | (SDK built-in) | Load domain-specific agent skills mounted from the plugin |

`WebSearch` and `WebFetch` are explicitly disallowed. Plugin agents have no access to git or `repo-tools`.

**Workspace**: Each plugin agent gets its own workspace at `sessions/{taskId}/agents/{key}/` (cwd, read-write). Plugin skills are symlinked into `.claude/skills/`, plugin hooks are written to `.claude/settings.json`, and the shared task folder is mounted read-only via `additionalDirectories`.

## Two-Channel Communication

All agents communicate through two distinct channels:

### Channel 1: `send_message_to_agent`

Direct peer-to-peer messaging. Implemented as an MCP tool in `src/agents/tools.ts` and wired through `Task.toolSendMessage`.

**Behavior**:
1. The sender calls `send_message_to_agent(target, message)`
2. The task runtime logs the message to `knowledge.log` and increments the inter-agent message budget
3. If the target agent is not yet spawned, it is spawned on demand (`ensureAgentSpawned`)
4. The message is added to the target agent's `MessageQueue`
5. The target agent receives it via its streaming async generator
6. The sender receives an acknowledgment string

**Key property**: The target list is built dynamically from all registered repo and plugin agent IDs, plus `pm-agent`. This ensures agents can only message agents that actually exist.

```typescript
// From src/agents/tools.ts
function allAgents(): [string, ...string[]] {
  return ['pm-agent', ...getAgentIds()] as [string, ...string[]];
}
```

### Channel 2: `log_finding`

Broadcast-style logging to the shared `knowledge.log` file. Non-blocking -- the agent continues working after logging.

**Finding types**: `discovery`, `decision`, `completion`, `blocker`

**Behavior**: Appends a timestamped entry to `<task>/shared/knowledge.log` with the agent name and finding type. All agents and the PM read this file at the start of each turn to understand task context.

## Thread Owner Pattern

The thread owner pattern governs how work is coordinated across agents within a task:

1. **PM assigns ownership**: When delegating work, the PM calls `assign_task_owner(agent)` and includes "You are the task owner" in the delegation message.

2. **Task Owner responsibilities**: The task owner coordinates the overall completion of the task. It may involve other agents as participants, synthesize their findings, and report final results to the PM.

3. **Participant role**: Any agent not explicitly assigned as task owner acts as a participant. Participants perform requested work and report back to the requesting agent (not the PM).

4. **Coordination strategies** (defined in `prompts/agent-core.md`):
   - **Sequential**: One agent's work depends on another's results. Agent sends request, then stops and waits.
   - **Parallel**: Work can proceed independently. Task owner agrees on approach with participants, both work simultaneously, task owner waits for all completion reports.

5. **Critical stopping points**: Agents must stop after sending a sequential request, after completing participant work, or after reporting to the PM. This prevents runaway agent loops.

## Prompt Composition

Agent prompts are composed in layers, loaded by `src/utils/prompt-loader.ts` with variable substitution (`{{VAR}}`):

### Layer 1: Universal Multi-Agent Protocol (`prompts/agent-core.md`)

Shared by all repo agents and plugin agents. Defines:
- Agent identity (ID, role, expertise) via template variables
- Peer agent list (dynamically generated)
- Dual role system (Task Owner vs Participant)
- Communication tools (`send_message_to_agent`, `log_finding`)
- Coordination strategies (Sequential, Parallel)
- Critical stopping points
- Workflow steps: Establish Context, Analyze Situation (in `<thinking>` tags), Perform Work, Report Completion
- Research content handling (`<research_result>` tags)

Template variables: `{{AGENT_ID}}`, `{{AGENT_ROLE}}`, `{{EXPERTISE}}`, `{{PEER_LIST}}`

### Layer 2: Track Extension

Different for each agent track:

**Repo agents** (`prompts/repo-agent.md`):
- Repository responsibility (primary + any other declared repos, all mounted at spawn)
- Multi-repo working model (the optional `github` arg on repo-tools, default = primary)
- Task lifecycle context (Research, Implement, Review, Conflicts)
- Dual mode system (Read-Only vs Edit, determined by available tools)
- Git workflow: branch management (`switch_branch`, `create_branch`, `fetch`), staging, committing, PR lifecycle
- Honesty and transparency guidelines
- No template variables — per-repo data (github, clone path, current/base branch, RO/RW mode) is surfaced through the dynamic Current Context block built at spawn, not via static substitution. This keeps the prompt structurally correct for any number of repos.

**Plugin agents** (`prompts/plugin-agent.md`):
- Read-only mode declaration
- Available tools summary
- Workspace description
- Simple workflow: receive, research, log, report

### Layer 3: Domain-Specific Instructions

Loaded from plugin `agents/*.md` files. Parsed with `gray-matter` to extract frontmatter (role, expertise, optional model) and markdown body (domain-specific instructions).

For repo agents, this is the `agentPrompt` field from `RepoAgentConfig`. For plugin agents, this is the `prompt` field from `PluginAgentConfig`.

### PM Agent Prompt

The PM agent uses a separate prompt (`prompts/pm-agent.md`) that is not layered. It includes:
- Team list and expertise (dynamically injected via `{{TEAM_LIST}}` and `{{TEAM_EXPERTISE}}`). Each `{{TEAM_LIST}}` line is annotated by `buildPmDef()` with the external systems that teammate can reach via MCP — built from the agent's resolved `mcpServers` plus the optional `description` of each server in the plugins' `.mcp.json` — so the PM can route an integration request to the agent that owns it instead of assuming Archie lacks access
- The PM's own directly-callable integrations (`{{PM_INTEGRATIONS}}`), since the PM is not part of its own roster (empty when it has none)
- Core mental models (Single Read Principle, Turn Flow, Communication Channel Philosophy, Unified Persona, Delegation Protocol, Task Completion Philosophy)
- Available tools categorized as Action Tools vs Turn-Ending Tools
- Structured reasoning process (`<situation_analysis>` tags)
- Decision framework for common scenarios

### Triage Agent Prompt

`prompts/triage-agent.md` still ships in the repo and would be loaded by `runTriage()` if the call sites in `src/connectors/slack/events.ts` were re-enabled. With triage disabled it has no runtime effect.

## Prompt Composition Assembly

```
Repo Agent:
  agent-core.md(AGENT_ID, AGENT_ROLE, EXPERTISE, PEER_LIST)
  + repo-agent.md()
  + plugins/<name>/agents/<key>.md body (optional)

Plugin Agent:
  agent-core.md(AGENT_ID, AGENT_ROLE, EXPERTISE, PEER_LIST)
  + plugin-agent.md()
  + plugins/<name>/agents/<key>.md body (optional)

PM Agent:
  pm-agent.md(TEAM_LIST, TEAM_EXPERTISE, PM_INTEGRATIONS)
  + (optional) pm overlay prompt body from the `pm` plugin

Triage Agent (disabled):
  triage-agent.md()  // present but not loaded at runtime
```

## Agent Characteristics

### No Persistent Code Memory

Agents do not retain knowledge of code between tasks. Each task starts with fresh agent instances. Context comes from:
- `knowledge.log` (task history, previous findings)
- `metadata.json` (task state, participants, thread/PR info)
- The repository itself (read via tools)

### Session History

Within a single task, agents maintain session history via the Claude Agent SDK's session resume mechanism. If an agent crashes, the runtime attempts to resume the existing session. If resume fails, it retries with a fresh session using the `RecoverableInputGenerator` to replay consumed messages.

```typescript
// From src/agents/spawn.ts
const recoverable = createRecoverableInputGenerator(queue);
// On failure:
recoverable.reset(); // Put consumed messages back in queue
sessionId = undefined;
hasRetried = true;
```

### Peer Awareness

Every repo and plugin agent's prompt includes a dynamically generated peer list. This is built by `buildPeerList()` in `src/agents/registry.ts`, called from `spawn.ts` with the current task's team:

```typescript
export function buildPeerList(excludeAgentId: string, team?: AgentDef[]): string {
  const source = team ?? registry;
  const repoPeers = source
    .filter((d) => d.track === 'repo' && d.id !== excludeAgentId)
    .map((d) => `- ${d.id}: ${d.role} (${d.repo!.primary} repository)`);

  const pluginPeers = source
    .filter((d) => d.track === 'plugin' && d.id !== excludeAgentId)
    .map((d) => `- ${d.id}: ${d.role} [${d.pluginName}]`);

  return [...repoPeers, ...pluginPeers].join('\n');
}
```

Spawn passes `task.team` (registry agents plus any PM-spawned dynamic agents merged in at `Task.get` / `Task.create` time) so dynamic peers are visible. The list excludes the current agent and the PM (which is hardcoded in the agent-core prompt). This ensures agents know who they can communicate with and what each peer specializes in.

### Streaming Input

Agents receive messages via async generators connected to `MessageQueue` instances. Messages can arrive at any time:
- From the event handler (user messages, GitHub events)
- From other agents (via `send_message_to_agent` callbacks)
- From the system (recovery prompts, edit mode approval)

The queue uses a promise-based pull model: `nextMessage()` returns immediately if messages are queued, or waits for the next enqueued message.

### Interruptible

Agents can be interrupted at any time by stopping their message queue. When a queue is stopped, all pending resolvers are rejected, causing the agent's async generator to exit. This is used for:
- Task completion (`completeTask`)
- Task cancellation (`stopTask`)
- Edit mode requests (task pauses until user responds)
- Research budget exceeded (task pauses until user responds)
- Wall-clock timeout (30 minutes default)

### Idle Detection and Recovery

When an agent's SDK `query()` finishes (Stop hook fires), the task marks it as inactive via `updateAgentState()`. This triggers `scheduleIdleCheck()` in `src/tasks/recovery.ts`, which can send recovery prompts to idle agents that haven't reported completion.

Recovery prompts are defined in `src/agents/prompts.ts`:

```typescript
export const AGENT_PROMPTS = {
  reinforcePM: 'RECOVERY: You went idle without completing the task...',
  reinforceAgent: 'RECOVERY: You went idle without reporting back...',
};
```

## Task Assignment by PM

When the PM receives a new task:

1. Loads the relevant domain skill via the `Skill` tool
2. Acknowledges the request via `post_to_user` (routed to whichever channel the requester is on — Slack, CLI, GitHub)
3. Calls `assign_task_owner(agent)` to designate the lead agent
4. Calls `send_message_to_agent(agent, message)` with the delegation message starting with "You are the task owner for this request."

`Task.toolSendMessage` (in `src/tasks/task.ts`):
1. Logs the message to `knowledge.log` and increments the inter-agent message budget
2. Spawns the target agent if not already running (`ensureAgentSpawned`)
3. Adds the message to the target agent's queue
4. Returns an acknowledgment string to the sender

Agent spawning is lazy: agents are only instantiated when they first receive a message, not when a task is created.

## Agent Lifecycle

```
1. Task created
   → Disk structure (shared/, memory/, metadata.json, knowledge.log) created
   → No agents spawned yet — Task is inert until sendMessage() is called

2. First sendMessage() (defaults to pm-agent)
   → Task activates (status=in_progress, wall-clock timer started)
   → PM Agent created lazily and spawned with initial prompt
   → Message added to PM's queue

3. PM delegates to specialist
   → Target agent created lazily on first send_message_to_agent
   → ensureAgentSpawned spawns the SDK process
   → Message added to target's queue
   → Agent picks up the message via streaming generator

4. Agent works
   → Reads knowledge.log for context
   → Uses tools to investigate/modify code
   → Logs findings via log_finding
   → Reports back via send_message_to_agent

5. Task completes (or stops)
   → PM calls report_completion (or stop is invoked elsewhere)
   → All queues stopped, agent sessions deactivated
   → Read-only clones removed; RW clones preserved (have branches/commits/PRs)
   → Task metadata set to "completed" / "stopped"
   → Runtime removed from activeTasks

6. Task resumes (on new input)
   → Task.get() loads metadata, fresh team scan from registry
   → sendMessage() reactivates the task
   → Agents respawned, resumed with persisted session IDs (with one-shot retry on failure)
   → New message sent to the target agent
```

## Budget Controls

Each task has budget limits enforced by the runtime (see [security.md](security.md)):

| Budget | Default | Enforcement |
|---|---|---|
| Research requests | 5 per task | Hard stop, Slack approval for +5 |
| Inter-agent messages | 100 per task | Advisory warning to Slack |
| Wall-clock timeout | 30 minutes | Hard stop with Slack notification |

## Related Documentation

- [Architecture Overview](overview.md) -- system-level architecture and technology stack
- [Orchestration](orchestration.md) -- task runtime, message queues, and agent lifecycle details
- [Edit Mode](edit-mode.md) -- approval flow, shared clones, and git workflow
- [Plugin System](plugin-system.md) -- plugin structure, agent registration, and skill loading
- [Web Research](web-research.md) -- multi-agent research pipeline and defense layers
- [Security](security.md) -- research budget, sandwich defense, prompt injection mitigations

---

*The plugin architecture enables adding new agent types without modifying core code. New agents are registered by adding markdown files to a plugin directory and optionally providing infrastructure config for repository-backed agents.*
