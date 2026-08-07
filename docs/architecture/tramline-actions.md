# Tramline Release Actions

Tramline is the mobile release-management system. Its MCP server exposes 9 reads and 36 release-lifecycle **write** actions — start a release, retry a failed CI build, retry a store submission, move a staged rollout — on a single API key.

This gate is what lets an agent use the useful half of that without being able to move a rollout on its own judgement. Every write is held until a human approves **that exact call** in Slack.

> A sibling of [edit mode](edit-mode.md) in spirit, but not in shape. Edit mode is a one-way, task-lifetime grant over a *capability class* (repo writes). This gate is per-call, single-use, and bound to the arguments — the granularity a live release needs. The closest existing relative is the per-PR `merge` gate (see [GitHub Integration → Merge Policy](github-integration.md#merge-policy-automerge)), and two of its properties are borrowed directly.

## Why the gate lives here

Tramline's API key scopes are binary — `read` and `write`. A key that can retry a submission can also push a rollout to 100%; there is no server-side way to express the difference. So the distinction has to be drawn on this side.

The obvious alternative — have the agent ask the PM, have the PM call an approval tool, then have the agent make the call — gates the agent's *description* of what it intends to do, not the call itself. After approval nothing constrains which tool runs, or with which arguments. A `PreToolUse` hook sees the real tool name and the real arguments, which is the only place the two cannot diverge.

## Classification

`src/agents/tramline-guard.ts` sorts every `mcp__tramline__*` call into one of four dispositions.

| Disposition | Count | Behaviour |
| --- | --- | --- |
| **read** | 9 | Straight through. Allow-listed by name. |
| **auto** | 3 | Straight through. Writes that only mirror state the external system has already moved (`poll_workflow_run_status`, `fetch_workflow_run_status`, `sync_submission_from_store`). |
| **gated** | 28 | Denied until a human approves this exact call. |
| **never** | 5 | Denied always. No approval unlocks them. |

Reads are allow-listed rather than derived, so **a Tramline tool added later defaults to gated** rather than silently arriving open.

### The never-list

`fully_release_rollout`, `halt_rollout`, `fully_release_previous_rollout`, `prepare_submission`, `cancel_submission_review`.

These are not merely the most dangerous — they are the ones *wrongly shaped for a chat button*. Each is irreversible, and each needs the operator looking at the rollout percentages, the release-health metrics, or App Store Connect while they decide. A Slack button invites that decision to be made from a phone on the strength of a one-line summary. (`prepare_submission` is the least obvious member: re-preparing force-overwrites the store version's metadata, including release notes, destroying edits made directly in App Store Connect.)

The agent's job for these is to say what it thinks should happen and let a human do it in Tramline. They are also absent from the agent's tool list in `archie-plugins`; the set here is the second layer, and holds even if an agent is misconfigured with the tools.

## Flow

```
agent calls mcp__tramline__retry_submission { id: "4f3a…" }
  │
  ├─ guard: gated, no approval on file
  │    ├─ render the prompt from the tool arguments + the task's target index
  │    ├─ no label for that id?  → deny: "call get_release first"
  │    ├─ post Approve/Deny to Slack, write pending_tramline_action, park the task
  │    └─ deny this attempt: "needs human approval, you'll be reactivated"
  │
  ├─ a release approver clicks Approve
  │    ├─ clicker checked against ARCHIE_RELEASE_APPROVERS
  │    ├─ digest verified against the pending slot (mismatch → stale no-op)
  │    ├─ approval stored in approved_tramline_actions (one-shot, 10 min TTL)
  │    └─ PM reactivated
  │
  └─ agent retries the same call
       └─ guard: digest matches → consume → continue
```

Approval **stores a permission; it does not execute**. The agent spends it by retrying its own call, so the action still runs through the same audited MCP path as everything else — there is no second code path that performs release actions.

### Two borrowed properties

**Bound to the exact call.** The approval is keyed on `sha256(action + canonicalized arguments)`, truncated to 16 hex chars. Approving "retry submission A" cannot be spent on submission B, cannot be spent on a different tool against the same target, and cannot be spent twice. Argument order doesn't affect the digest; `undefined` values are dropped.

**Rendered by us, not by the agent.** The Slack prompt is built from the real arguments and Tramline's own read data — never from the agent's summary of its intent. An agent that has misdiagnosed still shows the approver a correctly-labelled button. This is the property that makes the button worth having.

## Naming the target

Action tools address records by UUID, and Tramline has no `GET` endpoint for a submission, rollout, workflow run, or platform run — only `get_release`, whose payload nests all of them. So a `PostToolUse` hook (`createTramlineContextHook`) walks every Tramline read response and indexes each id it finds against a human label:

```
4f3a1c2e-… → "253.0.0 IOS · store submission · (failed)"
```

The index lives in `TaskMetadata.tramline_targets`, capped at `TARGET_INDEX_LIMIT` (120) with oldest-first eviction, and survives the park/reload cycle that approval requires.

**A gated call whose target has no label is denied, not posted.** You cannot act on a release record this task has not read. That is a deliberate safety property rather than a workaround for the missing endpoints: approving an opaque UUID means trusting the agent's word for what it points at. The denial says to call `get_release` first, so it costs one extra call, not a loop.

## One at a time

`pending_tramline_action` is a single slot. A second gated call while one is outstanding is refused, not queued — a stack of release buttons is something a human learns to clear rather than read.

Unlike the merge slot there is **no supersede path**. Superseding would let an agent swap the action out from under a human who is mid-way through reading it. A pending request is cleared by a resolution or by the task ending.

## Who may approve

`ARCHIE_RELEASE_APPROVERS` — comma-separated Slack user ids.

**Unset means nobody can approve.** An unconfigured deployment behaves exactly as it did before this feature: the agent reads, humans act. That is the correct direction to fail.

This gate is the only one that authorizes the clicker. `approve_edit_mode` and `approve_merge` accept a click from anyone who can see the message (they resolve the user's identity only for attribution, and skip external users solely to keep their name out of git history). These buttons move a live release, so the click itself is checked. An unauthorized click leaves the prompt live and explains itself ephemerally — a misdirected click is not an incident worth broadcasting.

External/guest users are refused outright.

## Attribution

Two records, deliberately in different places.

**In Archie**, `knowledge.log` gets a `decision` finding at each step: requested, approved by *name*, or denied. The Slack message itself is updated in place to `✅ Tramline action approved by @user`, so the thread is the primary human-readable audit trail.

**In Tramline**, the action is stamped on the release timeline as the API key that made it (`archie (API key)`) rather than as `Tramline`. That needed a change on the Tramline side — `Current.api_actor`, honoured by `Passportable#automatic?` — because without it every API-driven action was indistinguishable from Tramline's own automation. The *approver* is not plumbed through to Tramline: the approval happens here, and the Slack thread is where that fact lives.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ARCHIE_RELEASE_APPROVERS` | Slack user ids allowed to resolve these prompts. Unset → nobody. |
| `MCP_TRAMLINE_API_KEY` | Must carry Tramline's **`write`** scope, or every approved retry 403s. Was read-only before this feature. |
| `MCP_TRAMLINE_API_URL` | Unchanged. |

## The CLI/API path

`POST /tasks/:id/approve` accepts `type: 'tramline_action'` with `ref` set to the digest (echoed from the `approval:requested` event). A digest that doesn't match the pending slot returns `409` with `stale: true`. There is no approver allowlist on this route — reaching it already means operator access to the engine.

## Drift to watch

- **Classification vs. tool descriptions.** The tiers stated in `tramline-mcp`'s tool descriptions (`[Impact: …]`) exist so a caller can see blast radius without knowing Tramline's internals. They must agree with the sets in `tramline-guard.ts`, but they live in a different repository and nothing enforces the correspondence automatically. The MCP's own smoke test asserts that every action tool declares *some* tier; the mapping itself is reviewed by hand when either side changes.
- **`PreToolUse` firing for MCP tools.** The whole gate rests on the SDK delivering `mcp__*` calls to `PreToolUse` hooks. This is version-coupled to the Claude CLI, exactly like the egress allowlist (see [Security → Sandbox Bypass Prevention](security.md)). Treat an SDK bump as security-relevant and re-verify that a gated call is actually intercepted.
- **The two `sync_*` traps.** `sync_release_commits` and `sync_release_pull_requests` read like refreshes. The first fans out into Tramline's `ProcessCommits`, which pushes a version-bump commit, may apply the build queue, and opens backmerge PRs; the second can finalize a release outright. Both are gated, and their MCP descriptions were rewritten to say so. If they ever get reclassified, that is a mistake.

## Relevant source files

- `src/agents/tramline-guard.ts` — classification, digest, prompt rendering, target index, approver allowlist, both hook factories
- `src/agents/spawn.ts` — wires `createTramlineGuardHooks` into `PreToolUse` and `createTramlineContextHook` into `PostToolUse`, for every agent
- `src/tasks/task.ts` — `requestTramlineApproval`, `consumeTramlineApproval`, `handleTramlineActionApproval` / `…Denial`, `recordTramlineTargets`
- `src/types/task.ts` — `pending_tramline_action`, `approved_tramline_actions`, `tramline_targets`, `ApprovedTramlineAction`
- `src/connectors/slack/events.ts` — `registerTramlineActionHandlers` (approve/deny buttons + approver authorization)
- `src/connectors/api/routes.ts` — the CLI/HTTP resolution path
- `src/agents/__tests__/tramline-guard.test.ts` — classification, digest binding, render-refusal, index, allowlist fail-closed
