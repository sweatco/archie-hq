# Agents Architecture

This document describes the agent types, communication protocols, prompt composition, and behavioral patterns implemented in the Archie system. All descriptions reflect the actual codebase.

## Agent Types

Archie uses four agent types, each backed by a specific Claude model and serving a distinct role:

| Agent Type | Model | Count | Role |
|---|---|---|---|
| Triage Agent | Haiku | 1 (stateless) | Event classifier for Slack messages and GitHub PR comments |
| PM Agent | Opus | 1 per task | Task manager, user interface, agent coordinator |
| Repo Agents | Sonnet | 1 per repository per task | Codebase investigation and modification |
| Plugin Agents | Sonnet (configurable) | 1 per plugin agent per task | Lightweight, read-only domain specialists |

### Triage Agent

**Source**: `src/agents/triage.ts`

The triage agent is a stateless classifier that runs once per incoming event. It does not maintain sessions or participate in task coordination. It uses the Haiku model for fast, cost-effective classification.

**How it works**:

1. Receives a formatted input string with event context (Slack message + thread history, or GitHub comment + comment history)
2. Uses `query()` from the Claude Agent SDK with `outputFormat: { type: "json_schema" }` for structured output
3. Validates the result against a Zod schema
4. Returns a typed classification result

**Slack triage schema** (`SlackTriageSchema`):

```typescript
{
  action: "new_task" | "existing_task" | "cancel_task" | "noop",
  task_id?: string,
  confidence: "high" | "medium" | "low",
  similar_tasks?: string[],
  reasoning: string
}
```

**GitHub comment triage schema** (`GitHubCommentTriageSchema`):

```typescript
{
  action: "existing_task" | "noop",
  confidence: "high" | "medium" | "low",
  reasoning: string
}
```

The triage agent has access to `Glob`, `Grep`, and `Read` tools to search the `sessions/` directory for matching tasks by thread ID, PR number, or keyword. It uses context hints (e.g., "THREAD MATCH: This thread belongs to task X") provided by `buildSlackContext()` for fast lookups.

GitHub events that don't require LLM classification (PR reviews, push events, CI results) are routed deterministically by `webhook-router.ts` without invoking the triage agent.

### PM Agent

**Source**: `src/agents/pm.ts`

One PM agent instance is spawned per task. It is the orchestrator: it receives all external input (from event-handler), delegates work to specialist agents, communicates with users via Slack, and manages the task lifecycle.

**Model**: Opus (with 1M context beta)

**Tools** (via MCP server `pm-agent-tools`):

| Tool | Purpose |
|---|---|
| `send_message_to_agent` | Send instructions/questions to any agent |
| `post_to_slack` | Post messages to task's Slack thread(s) |
| `assign_task_owner` | Designate an agent as task owner |
| `report_completion` | Stop the task, optionally post final message |
| `request_edit_mode` | Request user approval for code changes |
| `get_agents_status` | Check which agents are spawned and active |
| `web_research` | Spawn a multi-agent research pipeline |
| `Skill` | Load domain-specific PM skills from plugins |
| `Read`, `Glob`, `Grep` | Read files in the shared task folder |

**Edit mode tools** (available only after user approval):

| Tool | Purpose |
|---|---|
| `push_branch` | Push commits from worktree to origin |
| `create_pull_request` | Create a PR on GitHub |
| `get_pr_status` | Check PR mergeable state |
| `get_pr_reviews` | Fetch PR reviews and comments |
| `update_pr_description` | Update PR body |
| `add_pr_comment` | Add a general PR comment |
| `add_review_comment` | Comment on a specific line of code |
| `resolve_review_thread` | Mark a review thread as resolved |
| `request_re_review` | Request reviewers to re-review |
| `trigger_merge_check` | Check and merge ready PRs |

**Key behaviors**:

- Presents as a unified "Archie" persona -- never exposes internal agent mechanics to users
- Uses `<situation_analysis>` tags for structured reasoning before every action
- Loads domain-specific skills via the `Skill` tool before delegating work
- Follows the "waiting-for" mental model: after delegating to an agent the turn ends naturally; after responding to the user it calls `report_completion` to pause the system
- Dynamically builds its team list from all loaded repo and plugin agent configs at startup

### Repo Agents

**Source**: `src/agents/repo-agent.ts`

Repo agents are specialized for a single repository. They investigate code, make changes (in edit mode), and coordinate with other agents. Configuration comes from plugins via `repo-configs.ts`.

**Model**: Sonnet (with 1M context beta)

**Tools** (via MCP server `repo-agent-tools`):

| Tool | Purpose |
|---|---|
| `send_message_to_agent` | Report findings or coordinate with peers |
| `log_finding` | Write to shared knowledge log |
| `web_research` | Spawn a research pipeline |
| `Read`, `Glob`, `Grep` | Investigate repository code |

**Edit mode tools** (when `metadata.edit_allowed === true`):

| Tool | Purpose |
|---|---|
| `Write`, `Edit` | Modify files in the worktree |
| `git add`, `git commit` | Stage and commit changes |
| `git status`, `git diff`, `git log` | Inspect working tree state |
| `git merge` | Resolve conflicts with origin/main |
| `git restore` | Unstage or discard changes |

**Dual mode system**: Repo agents discover their mode (read-only vs edit) from their available tools. When `Write` and `Edit` are present, they operate in edit mode within an isolated git worktree. When absent, they operate in read-only mode on the base repository.

**Working directory**: In read-only mode, the agent's cwd is the base repository path. In edit mode, it switches to the worktree path. The `additionalDirectories` option gives agents access to both the repository and the shared task folder.

### Plugin Agents

**Source**: `src/agents/plugin-agent.ts`

Plugin agents are lightweight, read-only agents for domains that don't need git, worktree, or GitHub infrastructure. They are loaded from plugins that lack a `repo-config.json`.

**Model**: Sonnet by default (configurable via frontmatter `model` field)

**Tools** (via MCP server `repo-agent-tools`):

| Tool | Purpose |
|---|---|
| `send_message_to_agent` | Report findings or coordinate with peers |
| `log_finding` | Write to shared knowledge log |
| `web_research` | Spawn a research pipeline |
| `Read`, `Glob`, `Grep` | Explore files in workspace |
| `Skill` | Load domain-specific agent skills |

**Workspace**: Each plugin agent gets its own workspace directory at `sessions/<task>/agents/<key>/`. Plugin skills are symlinked into the agent's `.claude/skills/` directory at spawn time.

## Two-Channel Communication

All agents (except triage) communicate through two distinct channels:

### Channel 1: `send_message_to_agent`

Direct peer-to-peer messaging. Implemented as an MCP tool in `src/mcp/tools.ts`.

**Behavior**:
1. The sender calls `send_message_to_agent(target, message)`
2. The task runtime logs the message to `knowledge.log`
3. If the target agent is not yet spawned, it is spawned on demand
4. The message is added to the target agent's `MessageQueue`
5. The target agent receives it via its streaming async generator
6. The sender receives an acknowledgment string

**Key property**: The target list is built dynamically at startup from all registered repo and plugin agent IDs, plus `pm-agent`. This ensures agents can only message agents that actually exist.

```typescript
// From src/mcp/tools.ts
const allAgents = ['pm-agent', ...getAllRepoAgentIds(), ...getAllPluginAgentIds()];
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
- Repository responsibility
- Task lifecycle context (Research, Implement, Review, Conflicts)
- Dual mode system (Read-Only vs Edit, determined by available tools)
- Git workflow (staging, committing, conflict resolution)
- Restrictions (no push, no fetch, no destructive operations)
- Template variables: `{{REPO_KEY}}`, `{{BASE_BRANCH}}`

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
- Team list and expertise (dynamically injected via `{{TEAM_LIST}}` and `{{TEAM_EXPERTISE}}`)
- Core mental models (Single Read Principle, Turn Flow, Communication Channel Philosophy, Unified Persona, Delegation Protocol, Task Completion Philosophy)
- Available tools categorized as Action Tools vs Turn-Ending Tools
- Structured reasoning process (`<situation_analysis>` tags)
- Decision framework for common scenarios

### Triage Agent Prompt

The triage agent uses `prompts/triage-agent.md` with no layering or template variables. It defines classification actions for Slack and GitHub events, task search strategies, and response format.

## Prompt Composition Assembly

```
Repo Agent:
  agent-core.md(AGENT_ID, AGENT_ROLE, EXPERTISE, PEER_LIST)
  + repo-agent.md(REPO_KEY, BASE_BRANCH)
  + plugins/<name>/agents/<key>.md body (optional)

Plugin Agent:
  agent-core.md(AGENT_ID, AGENT_ROLE, EXPERTISE, PEER_LIST)
  + plugin-agent.md()
  + plugins/<name>/agents/<key>.md body (optional)

PM Agent:
  pm-agent.md(TEAM_LIST, TEAM_EXPERTISE)

Triage Agent:
  triage-agent.md()
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
// From src/agents/repo-agent.ts
const recoverable = createRecoverableInputGenerator(queue);
// On failure:
recoverable.reset(); // Put consumed messages back in queue
sessionId = undefined;
hasRetried = true;
```

### Peer Awareness

Every repo and plugin agent's prompt includes a dynamically generated peer list. This is built by `buildPeerList()` in `src/agents/peer-list.ts`:

```typescript
export function buildPeerList(excludeAgentId: string): string {
  const repoPeers = getAllRepoConfigs()
    .filter((c) => c.agentId !== excludeAgentId)
    .map((c) => `- ${c.agentId}: ${c.role} (${c.repoKey} repository)`);

  const pluginPeers = getAllPluginAgentConfigs()
    .filter((c) => c.agentId !== excludeAgentId)
    .map((c) => `- ${c.agentId}: ${c.role} [${c.pluginName}]`);

  return [...repoPeers, ...pluginPeers].join('\n');
}
```

The list excludes the current agent and always includes `pm-agent` (hardcoded in the agent-core prompt). This ensures agents know who they can communicate with and what each peer specializes in.

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

When an agent's SDK `query()` finishes (Stop hook fires), the runtime marks it as inactive via `updateAgentState()`. This triggers `scheduleIdleCheck()` in `src/system/task-recovery.ts`, which can send recovery prompts to idle agents that haven't reported completion.

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
2. Acknowledges the request in Slack
3. Calls `assign_task_owner(agent)` to designate the lead agent
4. Calls `send_message_to_agent(agent, message)` with the delegation message starting with "You are the task owner for this request."

The `send_message_to_agent` callback in `task-runtime.ts`:
1. Logs the message to `knowledge.log`
2. Spawns the target agent if not already running (`ensureAgentSpawned`)
3. Adds the message to the target's queue
4. Returns an acknowledgment to the PM

Agent spawning is lazy: agents are only instantiated when they first receive a message, not when a task is created.

## Agent Lifecycle

```
1. Task created
   → PM agent queue created (+ queues for all known agents)
   → PM agent spawned with initial prompt

2. PM delegates to specialist
   → Target agent spawned on demand (ensureAgentSpawned)
   → Message added to target's queue
   → Agent picks up message via streaming generator

3. Agent works
   → Reads knowledge.log for context
   → Uses tools to investigate/modify code
   → Logs findings via log_finding
   → Reports back via send_message_to_agent

4. Task completes
   → PM calls report_completion
   → All queues stopped
   → All agent sessions deactivated
   → Task metadata set to "completed"
   → Runtime removed from active tasks

5. Task resumes (on new input)
   → Runtime rebuilt from disk metadata
   → Agents resumed with existing session IDs
   → New message sent to PM agent
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
- [Edit Mode](edit-mode.md) -- approval flow, worktrees, and git workflow
- [Plugin System](plugin-system.md) -- plugin structure, agent registration, and skill loading
- [Web Research](web-research.md) -- multi-agent research pipeline and defense layers
- [Security](security.md) -- research budget, sandwich defense, prompt injection mitigations

---

*The plugin architecture enables adding new agent types without modifying core code. New agents are registered by adding markdown files to a plugin directory and optionally providing infrastructure config for repository-backed agents.*
