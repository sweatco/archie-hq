# Max Mode

Archie can run a task in **max mode** — a per-task, human-approved upgrade that runs the task's agent with more capability (a premium model and/or higher reasoning effort) for the remainder of the task. It mirrors the [edit-mode](edit-mode.md) approval gate, applied to *model tier / effort* instead of *write access*.

Like edit mode, max mode exists because the upgrade has a real cost: premium models (e.g. Fable) are significantly more expensive than the default, so switching to them is an explicit, human-approved, per-task choice rather than an always-on default.

## What max mode changes

A task runs one agent, the PM, so max mode is the **PM's** upgrade. When `metadata.max_mode === true`, `resolveAgentModel` / `resolveAgentEffort` (`src/agents/model-label.ts`) re-resolve its model and effort at spawn from `AgentDef.maxMode`, which the engine sets in `buildPmDef()` (`src/agents/registry.ts`).

| | Normal | Max mode | Override |
|---|---|---|---|
| Model | `opus` | `claude-fable-5-1` | `ARCHIE_PM_MODEL` / `ARCHIE_PM_MAX_MODEL` |
| Effort | `medium` | `high` | `ARCHIE_PM_EFFORT` / `ARCHIE_PM_MAX_EFFORT` |

The upgrade is a model swap and an effort raise by default. It is deliberately the upgrade the *repo agents* carried before the flattening, because the PM now does the coding and investigation work those agents used to do: leaving the PM on its normal model would have made the approval a no-op for exactly the work the upgrade exists for.

Workers the PM spawns are unaffected. The `Agent` tool takes a model per spawn and the PM picks `sonnet` or `opus` for each, in max mode exactly as outside it — a worker is never spawned on `fable`, because the upgrade is for the agent holding the problem, not for the hands it delegates to.

## Approval flow

Max mode follows the same request → pause → approve/deny → resume shape as edit mode:

1. **PM requests it.** The PM calls the `request_max_mode(reason)` MCP tool (`src/agents/tools.ts`, on the PM-only `orchestration-tools` server) after explaining the cost trade-off to the user via `post_to_user`. The tool posts a Block Kit message with **Approve** / **Deny** buttons (`approve_max_mode` / `deny_max_mode`), freezes the status, and defers `task.stop()` to turn-end — pausing the task pending a response. It is idempotent: if max mode is already on, it is a no-op.
2. **User approves or denies.**
   - Slack: the `approve_max_mode` / `deny_max_mode` actions (`src/connectors/slack/events.ts`).
   - CLI/API: `POST /api/tasks/:id/approve` with `type: 'max_mode'` (`src/connectors/api/routes.ts`), surfaced in the CLI via the `approval:requested` event.
   - Approve → `task.handleMaxModeApproval()`; deny → `task.handleMaxModeDenial()` (`src/tasks/task.ts`).
3. **On approval**, `handleMaxModeApproval`:
   - guards idempotency and cancels the PM's deferred stop,
   - sets `metadata.max_mode = true` and persists,
   - logs a `decision` finding and wakes the PM with it.

Max mode is **task-lifetime and one-way** (like `edit_allowed`): once `max_mode` is `true` it is never unset, it persists in `metadata.json`, and it survives task park/reopen and process restart. It is independent of edit mode — a task can have either, both, or neither.

## The session is not reset

Model and effort are per-request options: `buildQueryOptions` in `src/agents/spawn.ts` calls `resolveAgentModel` / `resolveAgentEffort` on **every** spawn, so the next turn is issued with the upgraded pair and the PM keeps its conversation. Nothing clears `agent_sessions`, and an approval mid-conversation costs no context.

**The risk this accepts, in one sentence:** a resumed SDK session can in principle pin the model it was created with, in which case the swap would be a silent no-op — that is why an earlier version force-cleared the session, and it was dropped because clearing it left the PM cold in the middle of the very conversation it had been upgraded for. The `Model: …` line on the session's `init` event is the check: it reports what the session actually resolved to.

## Where it surfaces

- The grey message footer (`buildUserFooter` in `src/tasks/task.ts`) reflects the swap — it shows `Fable 5.1` once the upgraded turn has run. It prefers the concrete model the SDK reported at `init` (`recordResolvedModel`), falling back to the configured alias until that arrives, so it can briefly name the upgrade before a turn has confirmed it. An effort-only change is not shown; the footer names a model, not an effort.
- The session's `system/init` log line (`Model: …`) shows the model it actually spawned on.

## Related

- [Edit Mode](edit-mode.md) — the sibling approval gate this mirrors.
- **Advisor tool (future).** A complementary way to raise coding quality is the Anthropic [advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool): a stronger "advisor" model consulted mid-generation by a cheaper executor. It is **not** reachable through the Claude Agent SDK today — the SDK cannot attach the beta server-tool definition or the `anthropic-beta` header to the requests it makes — so wiring it up would require a request-rewriting proxy in front of the API (productionizing `src/system/context-probe.ts`). Tracked as a separate follow-up, not part of max mode.
