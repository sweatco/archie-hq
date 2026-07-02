# Max Mode

Archie can run a task in **max mode** — a per-task, human-approved upgrade that runs the coding agents with more capability (a premium model and/or maximum reasoning effort) for the remainder of the task. It mirrors the [edit-mode](edit-mode.md) approval gate, applied to *model tier / effort* instead of *write access*.

Like edit mode, max mode exists because the upgrade has a real cost: premium models (e.g. Fable) are significantly more expensive than the default, so switching to them is an explicit, human-approved, per-task choice rather than an always-on default.

## What max mode changes

When a task has max mode approved (`metadata.max_mode === true`), every agent's model and reasoning effort are re-resolved at spawn time by `resolveAgentModel` / `resolveAgentEffort` (`src/agents/model-label.ts`):

- **Model** — unchanged unless the agent opts in. An agent swaps models only when it declares `metadata.archie.maxMode.model` in its frontmatter (e.g. the engineering repo agents pin `claude-fable-5`), or — for repo/dynamic agents without their own `maxMode` — when the deployment sets `ARCHIE_MAX_MODE_MODEL`.
- **Effort** — repo/dynamic agents default to `max` reasoning effort (the built-in "increase accuracy" default). An explicit `maxMode.effort` wins; `ARCHIE_MAX_MODE_EFFORT` overrides the default for repo/dynamic agents. Generic plugin agents and the PM keep their normal effort unless they set `maxMode.effort` explicitly.

### Resolution order

`resolveAgentModel(def, maxMode)`:

1. `def.maxMode.model` (frontmatter opt-in) — any agent
2. `ARCHIE_MAX_MODE_MODEL` env — repo/dynamic agents only
3. normal model (`def.model`, or the PM/default fallback)

`resolveAgentEffort(def, maxMode)`:

1. `def.maxMode.effort` (frontmatter opt-in) — any agent
2. repo/dynamic agents: `ARCHIE_MAX_MODE_EFFORT` env, else `max`
3. otherwise the agent's normal `effort`

Generic plugin agents and the PM are therefore unchanged by default — max mode is a no-op for them unless they set `maxMode` in frontmatter.

## Configuration

### Per-agent frontmatter (plugins repo)

```yaml
metadata:
  archie:
    maxMode:
      model: claude-fable-5   # optional — swap to this model when max mode is approved
      effort: max             # optional — reasoning effort when max mode is approved
```

Both fields are optional; an empty or invalid spec is dropped and behaves as unset. It is parsed in `src/system/plugin-loader.ts`, typed as `MaxModeSpec` and carried onto `AgentDef.maxMode` (`src/types/agent.ts`) through `src/agents/registry.ts` (including the PM overlay, so a `pm` overlay could opt in too).

### Environment (engine)

| Env var | Applies to | Effect |
| --- | --- | --- |
| `ARCHIE_MAX_MODE_MODEL` | repo/dynamic agents without a frontmatter `maxMode.model` | Model to swap to in max mode (e.g. `claude-fable-5`) |
| `ARCHIE_MAX_MODE_EFFORT` | repo/dynamic agents without a frontmatter `maxMode.effort` | Reasoning effort in max mode (`low`…`max`) |

The env vars exist mainly for **dynamic agents** — PM-spawned repo agents synthesized at runtime (`synthesizeDynamicAgentDef` in `src/agents/registry.ts`), which have no frontmatter file to edit. They never affect generic plugin agents or the PM, and a per-agent frontmatter `maxMode` always takes precedence.

## Approval flow

Max mode follows the same request → pause → approve/deny → respawn shape as edit mode:

1. **PM requests it.** The PM calls the `request_max_mode(reason)` MCP tool (`src/agents/tools.ts`, on the PM-only `orchestration-tools` server) after explaining the cost trade-off to the user via `post_to_user`. The tool posts a Block Kit message with **Approve** / **Deny** buttons (`approve_max_mode` / `deny_max_mode`), freezes the status, and defers `task.stop()` to turn-end — pausing the task pending a response. It is idempotent: if max mode is already on, it is a no-op.
2. **User approves or denies.**
   - Slack: the `approve_max_mode` / `deny_max_mode` actions (`src/connectors/slack/events.ts`).
   - CLI/API: `POST /api/tasks/:id/approve` with `type: 'max_mode'` (`src/connectors/api/routes.ts`), surfaced in the CLI via the `approval:requested` event.
   - Approve → `task.handleMaxModeApproval()`; deny → `task.handleMaxModeDenial()` (`src/tasks/task.ts`).
3. **On approval**, `handleMaxModeApproval`:
   - guards idempotency and cancels the PM's deferred stop,
   - sets `metadata.max_mode = true` and persists,
   - **resets the session of every non-PM agent whose resolved model changes** (see below),
   - logs a `decision` finding and re-engages the PM.

Max mode is **task-lifetime and one-way** (like `edit_allowed`): once `max_mode` is `true` it is never unset, it persists in `metadata.json`, and it survives task park/reopen and process restart. It is independent of edit mode — a task can have either, both, or neither.

## Why sessions are reset on a model change

Model (and effort) are per-request options passed to the Claude Agent SDK `query()`. But a repo agent that already ran read-only holds an SDK `session_id`, and on its next spawn it *resumes* that session. A resumed session can pin its original model, which would make the swap a silent no-op — and the message footer (which shows the *resolved* model) would then falsely display the upgraded model.

To make the switch correct-by-construction, `handleMaxModeApproval` forces a fresh session for every non-PM agent whose resolved model actually changes under max mode (`modelChangingAgentIds` in `src/agents/model-label.ts`). Crucially, `request_max_mode` *pauses and evicts* the task, so the instance that handles the approval is a fresh reload (`Task.get`) whose live `agentProcesses` map is empty. The reset is therefore driven off the **task team** and the **persisted `agent_sessions`**, not live handles: for each model-changing agent it clears the `metadata.agent_sessions` entry — which survives to disk because `save()` only re-syncs sessions for agents still spawned — and also nulls a live `Agent.session.session_id` if the approval happened to land before the pause fired (the same-instance race). On its next spawn the agent restores no `session_id`, resumes nothing, and runs on the new model. In-session reasoning is lost, but findings live in the shared `knowledge.log`, which a fresh spawn re-reads. An **effort-only** upgrade changes no model, so it does not reset the session — a raised effort is a per-turn parameter the next turn picks up.

## Where it surfaces

- The grey message footer (`collectModelsUsed` in `src/tasks/task.ts`) reflects a model swap — e.g. it shows `Fable 5` once a Fable-swapping agent runs in max mode. An effort-only change is not shown (the footer lists models, not effort).
- Each agent's `system/init` log line (`Model: …`) shows the model it actually spawned on.

## Related

- [Edit Mode](edit-mode.md) — the sibling approval gate this mirrors.
- **Advisor tool (future).** A complementary way to raise coding quality is the Anthropic [advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool): a stronger "advisor" model consulted mid-generation by a cheaper executor. It is **not** reachable through the Claude Agent SDK today — the SDK cannot attach the beta server-tool definition or the `anthropic-beta` header to the requests it makes — so wiring it up would require a request-rewriting proxy in front of the API (productionizing `src/system/context-probe.ts`). It is tracked as a separate, repo-agents-only follow-up, not part of max mode.
