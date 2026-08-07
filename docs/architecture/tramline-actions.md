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
| **auto** | 1 | Straight through: `poll_workflow_run_status` only. |
| **gated** | 25 | Denied until a human approves this exact call — and refused outright if the action has no registered consequence description, if its target is unlabelled, or if its *state* makes it equivalent to a never-listed action. |
| **never** | 10 | Denied always. No approval unlocks them. |

Reads are allow-listed rather than derived, so **a Tramline tool added later defaults to gated** rather than silently arriving open. And because `ACTION_DESCRIPTIONS` is itself an allowlist, a gated action nobody has written a consequence sentence for is *refused*, not rendered as a bare method name — "defaults to gated" therefore means "defaults to refused until someone reviews it".

`auto` holds one member, and its docstring deliberately does not claim the tool is side-effect-free: `poll_workflow_run_status` can attach a build and trigger submissions. It is ungated because that is the same progression Tramline's own poller performs unprompted on a run that is already in flight. The two tools that used to sit beside it were moved out after reading the Ruby: `fetch_workflow_run_status` resurrects a run Tramline had marked **failed** and can cascade into starting a production release, and `sync_submission_from_store` can create a rollout with automatic progression enabled.

### Closed under effect, not name

The never-list is the part most likely to look over-long. Each entry is there because of what it *does*, and several are there because they reached another entry's code path: `enable_automatic_rollout` schedules a job that increases the rollout and re-schedules itself until 100%; `update_submission_build` re-prepares the store version and force-pushes its metadata, exactly like `prepare_submission`; `submit_for_review` is denied because its only exit (`cancel_submission_review`) is denied, and an in-progress Apple review is what blocks the *next* submission. A gate that reasons about tool names is trivially laundered by a differently-named tool, and the first version of this list was.

Two actions are refused by **state** rather than by name, in `stateRefusal`: `increase_rollout` at the final stage (it completes the rollout at 100%) and `start_rollout` on a non-staged rollout (`start_release!` skips the stages and releases to everyone immediately). Both read their state from the label index, and both refuse when the relevant field is not visible rather than guessing permissively.

The full list: `fully_release_rollout`, `enable_automatic_rollout`, `halt_rollout`, `fully_release_previous_rollout`, `prepare_submission`, `update_submission_build`, `submit_for_review`, `cancel_submission_review`, `start_release`, `stop_release`.

The agent's job for these is to say what it thinks should happen and let a human do it in Tramline — where the rollout percentages, the health metrics, or App Store Connect are on screen while they decide. They are also absent from the agent's tool list in `archie-plugins`; the set here is the second layer, and holds even if an agent is misconfigured with the tools.

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

**Bound to the exact call.** The approval is keyed on `sha256(action + canonicalized arguments)`, truncated to 16 hex chars. Approving "retry submission A" cannot be spent on submission B, cannot be spent on a different tool against the same target, and cannot be spent twice (grants are deduped by digest, and the spend is flushed durably rather than debounced — losing that write would leave a used token spendable again). Argument order doesn't affect the digest; `undefined` values are dropped.

**Rendered by us, not by the agent.** The Slack prompt is built from the real arguments and Tramline's own read data — never from the agent's summary of its intent. An agent that has misdiagnosed still shows the approver a correctly-labelled button.

Argument *values* are the one part the agent controls, so they are neutralized before rendering: newlines collapsed, mrkdwn and Block Kit sigils stripped, length capped, wrapped in a code span. Without that, a string argument can append its own lines to the message — `custom_source_branch: "main\n*Note:* pre-agreed, safe to approve"` renders as an extra instruction to the approver, which is precisely the property this section claims to have.

## Naming the target

Action tools address records by UUID, and Tramline has no `GET` endpoint for a submission, rollout, workflow run, or platform run — only `get_release`, whose payload nests all of them. So a `PostToolUse` hook (`createTramlineContextHook`) walks every Tramline read response and indexes each id it finds against a human label:

```
4f3a1c2e-… → "253.0.0 IOS · store submission · (failed)"
```

The index lives in `TaskMetadata.tramline_targets`, capped at `TARGET_INDEX_LIMIT` (120) with oldest-first eviction, and survives the park/reload cycle that approval requires.

`KIND_BY_KEY` and the version extraction are keyed on the **actual serializer output** of `GET /api/v2/releases/:id`, not on Tramline's domain model. The first version was written from the domain model, shared almost no keys with the API, and produced prompts in which a cross-platform release's two failed RC runs rendered identically — unanswerable, on the one flow this feature exists for. The unit tests missed it because their fixture was built to match the implementation, so the fixture is now **generated from the serializers** (`__tests__/fixtures/tramline-release-payload.json`) and a test asserts that no two records of the same kind share a label. Context (version + platform) is inherited downward and never replaced, since a build carries its own `version_name` and letting it overwrite the platform run's context is what dropped the platform.

Release-level actions accept `release_id` as a UUID **or a slug**, so the release's slug is indexed under the same label — otherwise addressing a release by slug skipped the label requirement entirely.

**A gated call whose target has no label is denied, not posted.** You cannot act on a release record this task has not read. That is a deliberate safety property rather than a workaround for the missing endpoints: approving an opaque UUID means trusting the agent's word for what it points at. The denial says to call `get_release` first, so it costs one extra call, not a loop.

## One at a time

`pending_tramline_action` is a single slot. A second gated call while one is outstanding is refused, not queued — a stack of release buttons is something a human learns to clear rather than read.

There is no supersede path for a *live* request — superseding would let an agent swap the action out from under a human mid-way through reading it. Instead the slot ages out: a request older than `PENDING_APPROVAL_TTL_MS` (1h) is discarded and replaced, and a click on a prompt older than that resolves to a stale no-op with a finding rather than minting a fresh grant. Without that the slot was cleared only by a resolution, so one unclicked prompt blocked every later action for the rest of the task's life, and a button found days later still executed against current state.

## Who may approve

`ARCHIE_RELEASE_APPROVERS` — comma-separated Slack user ids.

**Unset means nobody can approve — and the guard refuses a gated call outright rather than posting one.** Posting a button nobody can press *and* parking the task on it would leave a dead thread and be strictly worse than the read-only status quo. With the variable unset the agent reads, reports what it would have done, and humans act, which is what it did before this feature.

This gate is the only one that authorizes the clicker. `approve_edit_mode` and `approve_merge` accept a click from anyone who can see the message (they resolve the user's identity only for attribution, and skip external users solely to keep their name out of git history). These buttons move a live release, so the click itself is checked. An unauthorized click leaves the prompt live and explains itself ephemerally — a misdirected click is not an incident worth broadcasting.

External/guest users are refused outright.

## Attribution

Two records, deliberately in different places.

**In Archie**, `knowledge.log` gets a finding at each step: requested, approved by *name*, denied, expired unspent, and — as a `completion` finding — actually *spent*, so the trail does not stop at "approved" without saying whether the action ran. The Slack message itself is updated in place to `✅ Tramline action approved by @user`, so the thread is the primary human-readable audit trail.

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
- **`PreToolUse` firing for MCP tools.** The whole gate rests on the SDK delivering `mcp__*` calls to `PreToolUse` hooks, and on the *shape* of `tool_input`/`tool_response` for those calls. This is version-coupled to the Claude CLI, exactly like the egress allowlist (see [Security → Sandbox Bypass Prevention](security.md)), and the repo's answer to that class of risk is a live tripwire (`tools/e2e/egress-check.ts`), not unit tests. This gate does not have one yet — that is the largest outstanding gap. Treat an SDK bump as security-relevant and re-verify that a gated call is actually intercepted. Note the repo disagrees with itself about the response shape (`createResearchPostToolHook` assumes a bare array, this module assumed an envelope), so `extractPayload` now accepts every plausible shape rather than betting on one.
- **The `/api` approve route has no approver check, and the router has no authentication.** `POST /tasks/:id/approve` with `type: 'tramline_action'` deliberately skips the allowlist on the grounds that reaching the engine's HTTP API means operator access — but `/api/events/stream` publishes the digest in its `approval:requested` event, so anyone who can reach the port can resolve a release action. This is pre-existing for `edit_mode`/`merge` and is now extended to release actions; it needs either a shared secret on this route or an asserted ingress restriction.
- **The server key is a hardcoded guess.** `TOOL_PREFIX` is `mcp__tramline__`, but the server name lives in `archie-plugins/.mcp.json` — a different repo, which hot-reloads. Rename it there and the gate silently no-ops.
- **Plugins hot-reload; the engine does not.** `Task.get` → `syncPlugins()` does `git reset --hard origin/main` on every task load, so a plugins change removing names from `disallowedTools` goes live within minutes, while this gate ships in a deployed image. The safe order is therefore *deploy the engine, verify, then merge the plugins change, then issue the write key* — merging the engine PR first is not the load-bearing step.
- **The two `sync_*` traps.** `sync_release_commits` and `sync_release_pull_requests` read like refreshes. The first fans out into Tramline's `ProcessCommits`, which pushes a version-bump commit, may apply the build queue, and opens backmerge PRs; the second can finalize a release outright. Both are gated, and their MCP descriptions were rewritten to say so. If they ever get reclassified, that is a mistake.

## Relevant source files

- `src/agents/tramline-guard.ts` — classification, digest, prompt rendering, target index, approver allowlist, both hook factories
- `src/agents/spawn.ts` — wires `createTramlineGuardHooks` into `PreToolUse` and `createTramlineContextHook` into `PostToolUse`, for every agent
- `src/tasks/task.ts` — `requestTramlineApproval`, `consumeTramlineApproval`, `handleTramlineActionApproval` / `…Denial`, `recordTramlineTargets`
- `src/types/task.ts` — `pending_tramline_action`, `approved_tramline_actions`, `tramline_targets`, `ApprovedTramlineAction`
- `src/connectors/slack/events.ts` — `registerTramlineActionHandlers` (approve/deny buttons + approver authorization)
- `src/connectors/api/routes.ts` — the CLI/HTTP resolution path
- `src/agents/__tests__/tramline-guard.test.ts` — classification, digest binding, render-refusal, index, allowlist fail-closed
