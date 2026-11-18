# Incoming events

**Proposed · Reviewed 2026-11-18 · Implementation has not started.**

An employee can ask Archie in Slack, “When meeting data arrives, summarize it here.” They approve the routine, connect the sender and see what happened after each delivery. One **input** can feed several routines, proactivity, or both.

Build a shared receiver for generic JSON webhooks and MCP Events webhook subscriptions. Reuse Archie's Express server, Slack Bolt, trigger scheduler, Tasks and proactivity. The first release runs in one workspace on persistent disk. Provider-specific integrations, including GitHub, are outside this release.

## What the employee sees in Slack

1. **Review and enable.** Show the source, account, filters, routine instructions, responsible people and allowed destinations. The owner approves the input's scope. A new routine uses the existing trigger approval. Existing schedules and message triggers work independently.
2. **Connect and test.** Show the generated URL, auth method and masked key. **Check connection** checks setup without starting a model. **Run with sample** starts a real, budgeted run with fresh data.
3. **Inspect and manage.** **Inputs** lists visible inputs, including shared and proactivity-only ones. Show owner, consumers, health and last activity. **History** links receipts to tasks and decisions within the viewer's source permissions.

Open the Bolt view within three seconds and load provider details afterward. Recheck the actor, workspace, conversation and revision on each action. Only the owner or recovery operator can change connection settings, transfer ownership or reveal a key in a private view. Use the existing encrypted vault. [Trigger permissions](../architecture/triggers.md) · [Vault](../../src/system/secrets-vault.ts) · [Slack modals](https://docs.slack.dev/surfaces/modals/)

Pausing an input ignores new arrivals and cancels its unstarted work. Pausing one routine affects only that routine. Resume takes new events. Prompt edits apply to future receipts. Revocation takes effect locally before the next disclosure, including in an active task. Replace bearer keys immediately. For a planned signed-key rotation, allow up to five minutes of overlap.

## From delivery to outcome

1. **Receive.** Deployment supplies `ARCHIE_PUBLIC_URL`, already used by the OAuth CLI. Archie generates `POST /webhooks/incoming/:inputId`. Publish that route through existing HTTPS ingress and keep the operator API private. Use route-local `express.raw` with a size limit and inflation disabled. Verify the configured bearer token or Standard Webhooks signature before parsing valid UTF-8 JSON. [HTTP server](../../src/index.ts) · [Raw route example](../../src/connectors/github/events.ts) · [Operator API boundary](../architecture/tool-approvals.md)
2. **Match and acknowledge.** Match event kind or simple field checks (equals, one of, exists). Atomically commit the receipt and one handoff per selected consumer before returning `202`. Key receipts by input, binding and the sender's stable ID. Use signed `webhook-id` for generic signed events, optional `Idempotency-Key` for bearer delivery, and the subscription plus `eventId` for MCP. With no sender key, each delivery is new. Compare digests of stable event content, excluding delivery headers and the MCP cursor. Check existing receipts before charging storage. Return `200` for a matching retry or ignored event, `409` for a conflicting reuse, `429` when full and `503` when storage is unavailable.
3. **Run.** Add an `incoming_event` condition to the existing Trigger. Only attach or change that connection within the input's source and audience grant. For event routines, serialize receipt snapshots with edits and pause. Enabled routine edits currently use atomic saves without a shared snapshot lock. Reserve a Task ID before preparation. Have the scheduler report the Task or skip reason and recover any previously admitted run before charging another slot. Share durable Task creation and activation with the existing approval path while preserving its DM-thread requirement. Event routines can open a thread in their bound channel. [Trigger store](../../src/system/trigger-store.ts) · [Scheduler](../../src/system/trigger-scheduler.ts) · [Task preparation](../../src/tasks/task.ts)
4. **Discard the body.** As soon as every selected consumer has saved its necessary evidence or its handoff is skipped, cancelled or closed as failed, delete the inbox body in the same transaction as the last update. Model completion can come later. Filtered and paused events retain no body. Keep receipt keys or digests, timestamps, outcomes and references for 30 days to explain what happened and recognize retries. Consumer evidence follows existing Task and proactivity retention. Telemetry contains counts, timing and failure categories. Exclude raw bodies, credentials and sensitive headers from logs, event streams and debug output. [Task persistence](../../src/tasks/persistence.ts)

Use Node 24 SQLite in `WORKDIR/incoming/state.sqlite`, outside task mounts. Keep input settings, vault references, receipts, handoffs, MCP grants/cursors and configuration history there. Routine definitions stay in the trigger store. Activate reviewed setup last and resume interrupted setup safely. Initialize storage before listening. After Task recovery, start a single worker using Archie's SQLite transaction and lease patterns. Check the current lease on writes. [Proactivity store](../../src/proactivity/store.ts)

**Starting limits.** Allow 1 MiB and 10 seconds per request, 30 authenticated requests per minute per input, and 100 MiB per input or 1 GiB per workspace for waiting bodies. Use Express middleware and deployment limits where available. Try incomplete preparation up to five times in an hour and show failures in history. Close unresolved handoffs within seven days. Share the scheduler's current in-process allowance of 200 automated runs per UTC day. A full allowance skips the run.

## MCP subscriptions

- **Discover.** Use the existing root `.mcp.json` loader for operator-approved HTTPS Streamable HTTP services. Use the server's existing Archie metadata to configure which owners, event scopes and audiences may use a shared account. An owner may narrow that grant for an input. An explicit authorization header wins. Otherwise use Archie's token refresh. The existing spawn helper checks its vault record first, so the background client must resolve the header before invoking refresh. [Plugin loader](../../src/system/plugin-loader.ts) · [OAuth resolution](../../src/system/oauth/inject.ts)
- **Negotiate.** Use the released v2 client's automatic negotiation and custom method APIs. Detect top-level `capabilities.events` on legacy initialize or modern discovery, or prefer the advertised modern `io.modelcontextprotocol/events` extension with its per-call capability and complete result envelope. Use a narrow public transport adapter only where the SDK drops a capability. Validate advertised schemas with the SDK, bound complexity and disable remote references. [OpenAI profile](https://developers.openai.com/plugins/build/mcp-events) · [Pinned extension contract](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/4165cc2e580afa795842002f631edbbe17c63757/seps/3415-events-extension.md)
- **Connect.** Once the route is listening, vault a new 32-byte signing secret and persist its reference with the callback before subscribing. Answer the signed JSON challenge. Hold early occurrences until the grant and subscription ID match. Verification and termination controls do not create handoffs.
- **Recover or disconnect.** Retry, renew and unsubscribe with the original principal, callback URL, event name and canonical arguments. Request one hour and renew before `refreshBefore`. Commit receipts with opaque cursors and serialize updates with renewals. After an interruption, recover from the saved cursor for up to seven days where supported and report gaps. Explicit resume starts from now. Pause or deletion wins over a late grant. Keep cleanup pending until confirmed or expired. A replacement gets a distinct binding.

## Proactivity

Add an incoming-event source adapter alongside Slack threads. Use it for imports, access checks, citations, recall and **Start task**. Group by stable provider entity ID and preserve occurrence time. Recheck freshness, source access and permitted audience before disclosure. For push-only sources, cite what the event reported at its timestamp. Withhold actions that require current state when it cannot be verified. Only an explicitly mapped, allowed internal recipient can receive private outreach. The payload cannot choose a destination, authorize tools or expand file or memory access. Withhold tools whose effects cannot be scoped. [Access checks](../../src/proactivity/access.ts) · [Recall](../../src/proactivity/recall.ts) · [Task handoff](../../src/proactivity/handoff.ts)

Reuse existing analysis, budgets, feedback and delivery. **Off** skips proactive handoffs without a backlog. **Shadow** analyzes without sends. **Live** applies normal delivery checks. Suppress overlapping outreach while a routine handles the same entity and reassess its outcome. Commit `incoming:<receipt-id>` with the evidence, then acknowledge the inbox handoff. A retry after either commit must be safe. [Proactivity architecture](../architecture/proactivity.md) · [Schema migration](../../src/proactivity/persistence/schema.ts)

## Milestones and issues

Published on 2026-11-18 under [Feature #400 — Run routines and proactivity from incoming events](https://github.com/sweatco/archie-hq/issues/400). The three milestones below describe the completion criteria. Owners and dates are open.

<details>
<summary>Parent feature. Run routines and proactivity from incoming events</summary>

**Objective.** Let an employee connect a generic webhook or MCP Events subscription in Slack and use the same input for a saved routine, proactivity or both.

**Acceptance criteria**

- [ ] An employee can review a routine, connect and test its source, inspect the outcome, then pause or revoke it in Slack.
- [ ] A redelivered event with a stable key starts one Task per matching routine, and the inbox discards its body after the last handoff.
- [ ] A relevant event can produce sourced help in an allowed conversation. Irrelevant events stay quiet and ambiguous ownership does not cause a DM.

**Context.** The unified plan at `docs/plans/20261116-incoming-events-shared-receiver.md` owns the design.

**Next step and dependencies.** Start the generic receiver and the MCP compatibility check independently.

</details>

### Incoming events: a webhook runs a routine in Slack

An employee connects a generic sender in Slack, sees one Task in the approved conversation and can inspect, pause and resume the routine.

[Milestone 6](https://github.com/sweatco/archie-hq/milestone/6) · Tasks [#401](https://github.com/sweatco/archie-hq/issues/401), [#402](https://github.com/sweatco/archie-hq/issues/402), [#403](https://github.com/sweatco/archie-hq/issues/403)

<details>
<summary>Task 1. Receive and deduplicate generic webhooks</summary>

**Objective.** Accept a JSON webhook on one public route and hand matching work to a durable inbox before replying.

**Acceptance criteria**

- [ ] A correctly signed request or valid bearer request returns `202` after commit. Invalid authentication, malformed JSON, invalid UTF-8 and an oversized body start no work.
- [ ] Retries with the same key return the same receipt even when the inbox is full. Changed event content under the same key is a visible conflict. Filtered and paused events retain no body.
- [ ] Restart after commit and start a competing worker. Only the current lease holder may finish a handoff. When the last handoff ends, delete the payload in the same transaction.
- [ ] The public callback works through ingress and the operator API stays private. Logs and event streams contain neither a test secret nor a raw-body marker.

**Context.** Reuse the shared Express app, route-local raw parsing, Standard Webhooks and Archie's SQLite transaction and worker patterns. Generic bearer deliveries without a key are separate events.

**Next step and dependencies.** No prerequisite. Start with a signed request against the mounted route and a commit/retry test.

</details>

<details>
<summary>Task 2. Run a saved event routine once per matching receipt</summary>

**Objective.** Turn each approved routine handoff into one ordinary Archie Task in its bound conversation.

**Acceptance criteria**

- [ ] Take a consistent snapshot of the routine at receipt time. A later prompt edit applies to future receipts. Pause, deletion or revoked access stops unstarted work. After access is revoked during a run, its next post, file share and memory write must respect the new scope.
- [ ] Interrupt before preparation, after preparation and after activation. Recovery reuses the reserved Task and does not take another run slot for work already admitted.
- [ ] A channel-bound Task opens its own thread. DM-only proactive approvals and existing schedule and message tests still pass. A skipped or uncertain run has a reason in history.

**Context.** Extend the trigger condition and firing result. Share Task preparation and activation internals. Preserve the scheduler’s existing daily allowance and the separate DM approval contract.

**Next step and dependencies.** Depends on task 1. Trace one receipt through the scheduler, durable preparation and recovery.

</details>

<details>
<summary>Task 3. Connect, test and manage an event input in Slack</summary>

**Objective.** Let an employee create a webhook routine in conversation, review it, connect a sender and inspect its result.

**Acceptance criteria**

- [ ] Review shows the source, filters, instructions and audience. A user can enable the routine, check the connection without a run, and run a clearly marked sample.
- [ ] History distinguishes received, skipped, handed off and delivered. Inventory includes shared and proactivity-only inputs. A routine pause leaves other consumers active.
- [ ] Only the owner or recovery operator can reveal or rotate a key or transfer input ownership. Stale controls, source revocation and changing a routine’s input cannot disclose private data or broaden its grant.

**Context.** Use Bolt views, the existing vault and trigger approval.

**Next step and dependencies.** Depends on task 2. Walk the review → connect → sample → history → pause/resume flow with a development sender.

</details>

### Incoming events: Archie subscribes to an MCP event

An employee selects an advertised MCP event in Slack. Signed delivery, renewal, recovery and revocation work with a real publisher.

[Milestone 7](https://github.com/sweatco/archie-hq/milestone/7) · Tasks [#404](https://github.com/sweatco/archie-hq/issues/404), [#405](https://github.com/sweatco/archie-hq/issues/405)

<details>
<summary>Task 4. Discover MCP Events on configured servers</summary>

**Objective.** Show which events a permitted employee can subscribe to on a configured integration account.

**Acceptance criteria**

- [ ] Fixtures cover top-level Events over legacy initialize and modern discovery, plus the modern extension profile. Prefer the extension if both are present.
- [ ] An explicit authorization header succeeds even when a stored OAuth record is stale. Without an explicit header, use the existing refresh path. Distinguish unsupported, unauthorized and unreachable.
- [ ] Validate event arguments and payload schemas with the released SDK validator. The existing v1 tool clients still work.

**Context.** Use the root `.mcp.json` loader and pinned v2 client. Keep any discovery adapter confined to the capability field the SDK strips.

**Next step and dependencies.** No prerequisite. Exercise both released-client negotiation paths before building the Slack selector.

</details>

<details>
<summary>Task 5. Manage signed MCP webhook subscriptions</summary>

**Objective.** Let a user select an MCP event in Slack and keep the subscription working across renewal, restart and pause.

**Acceptance criteria**

- [ ] A real publisher’s signed challenge succeeds before the grant arrives. Early events run only after the grant matches. Challenge and termination controls never run a routine.
- [ ] Retry a lost grant, renew a short grant and recover from the last committed cursor after a restart. An explicit resume after pause starts with new events. Repeat deliveries produce one receipt. Show truncated or unavailable coverage.
- [ ] Pausing or replacing an input prevents stale grants from enabling it. Local revocation works during an outage and remote cleanup can finish later.

**Context.** Use the existing receiver and input panels. Persist the secret reference, callback and binding before the first subscribe call.

**Next step and dependencies.** Depends on tasks 3 and 4. Complete one subscribe → deliver → renew → unsubscribe cycle with a development publisher.

</details>

### Incoming events: reviewed proactive follow-up

A shared input can produce useful, sourced help or a deliberate no-send. Routine output, privacy, restart and restore have been verified in the full Slack flow.

[Milestone 8](https://github.com/sweatco/archie-hq/milestone/8) · Tasks [#406](https://github.com/sweatco/archie-hq/issues/406), [#407](https://github.com/sweatco/archie-hq/issues/407)

<details>
<summary>Task 6. Feed incoming evidence into Archie's proactivity</summary>

**Objective.** Let one input feed a routine and proactivity while preserving source access, ownership and current Slack behavior.

**Acceptance criteria**

- [ ] Migrate a representative schema-12 database. Preserve Slack evidence IDs, budgets, feedback, approvals, leases and unresolved sends.
- [ ] Crash between the evidence commit and inbox acknowledgment. The receipt imports once and the raw body disappears after both consumers finish. Off skips new evidence, shadow analyzes without sending, and live respects existing budgets.
- [ ] Use source-aware citations and audience checks for recall, output and Start task. Unknown owners get no DM. While a routine handles the same entity, suppress overlapping outreach and reassess its result.

**Context.** Extend the existing source-access, recall, handoff and delivery paths. Keep the incoming inbox usable with proactivity disabled.

**Next step and dependencies.** Depends on task 2. Run a migration fixture and import the same receipt twice before exercising delivery.

</details>

<details>
<summary>Task 7. Verify incoming event outcomes and recovery end to end</summary>

**Objective.** Show that a real user can connect a source and get useful, correctly scoped help, and that interruption or rollback is recoverable.

**Acceptance criteria**

- [ ] Run `npm run check` on Node 24. Use an isolated E2E workdir, real Slack panels, a signed generic sender and an MCP publisher. Record revisions, receipt IDs and resulting Tasks or decisions.
- [ ] Review an accurate meeting summary, an explicit report that the transcript is missing, a useful incident response and a deliberate no-send. Ambiguous ownership and instructions in an event cannot change the audience or permissions.
- [ ] Restore a payload-free backup with its matching binary. Verify permissions, paused inputs and uncertain sends before enabling workers. Record observed results and the user’s acceptance.

**Context.** Use the repository E2E harness and the unified plan’s rollout checks. The generic meeting example exercises delivery.

**Next step and dependencies.** Depends on tasks 5 and 6. Prepare the test workspace and expected results, then run both sources through the real Slack flow.

</details>

## Rollout and acceptance

Start disabled. Test migration and restore on a copy, then enable one input and routine. Review shadow decisions before live outreach. Monitor waiting handoffs, expired grants and delivery failures. The kill switch stops admission and workers while allowing local revocation.

For a planned restore point, pause admission, drain outstanding handoffs, stop writers and export a clean SQLite snapshot with no raw inbox bodies or WAL files. Back it up with the matching trigger, Task, proactivity and vault state. Restore paused with the matching binary and reconcile later receipts, revocations and uncertain sends before resuming. Record the verified result and user acceptance here. [Deployment backups](../guides/deployment.md) · [E2E harness](../../.claude/skills/archie-e2e/SKILL.md) · [Code review](../guides/coding-guidelines.md) · [PM routine](../guides/project-management.md)

## Research behind the choices

Research on 2026-11-16 examined Archie revision `465a9cb2`, upstream code and published packages. A local v1.30.0 schema probe confirmed that top-level `events` is dropped. The 2026-11-18 review checked the HTTP, trigger, Task, OAuth and proactivity paths at `bdc01098`, verified both pinned npm releases and compared the work with open GitHub tracking. Live interoperability, crash recovery and output quality still need implementation evidence.

| Source | What Archie can reuse |
|---|---|
| Hermes | Named routes on one receiver. Its ordinary agent runs have durable admission, but delivery paths differ and its implementation depends on the Python gateway and session runtime. [Receiver](https://github.com/NousResearch/hermes-agent/blob/43dc9a0a2848e8ddec2e57c578f49199cb0a8bba/gateway/platforms/webhook.py) · [Durable ingress](https://github.com/NousResearch/hermes-agent/blob/43dc9a0a2848e8ddec2e57c578f49199cb0a8bba/gateway/platforms/webhook_ingress.py) |
| OpenClaw and Pi | OpenClaw separates receipt from reaction. Its helpers depend on its gateway and scheduler. Pi's extension bus runs in-process and its experimental durable harness adds a runtime while leaving authentication to the host. Keep Archie's own dispatch and Task recovery. [OpenClaw SDK](https://github.com/openclaw/openclaw/blob/89d07fe54e1f304bfc3f6f5b04bd6d1b2463be85/src/plugin-sdk/webhook-ingress.ts) · [Pi SDK](https://github.com/earendil-works/pi/blob/a9878e136f5576c2ffd00c6ff054c9cd07a4b277/packages/coding-agent/docs/sdk.md) · [Pi durable harness](https://github.com/earendil-works/pi/blob/a9878e136f5576c2ffd00c6ff054c9cd07a4b277/packages/durable/README.md) |
| Grok Bot | The supplied examples and published docs support conversational setup, review, connection details and history. Implement that experience with Slack Bolt. [Grok routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) |
| Released libraries | Declare `standardwebhooks@1.1.1` directly for signature and timestamp verification. The release decodes buffers as UTF-8. Archie already locks an older transitive version. Pin `@modelcontextprotocol/client@2.4.0` for negotiation and custom requests alongside Archie's existing v1 SDK. The inspected extension proposal was open and its repository experimental, so test the pinned contract against a publisher. [Signing package](https://www.npmjs.com/package/standardwebhooks) · [MCP client](https://www.npmjs.com/package/@modelcontextprotocol/client/v/2.4.0) · [SDK negotiation](https://github.com/modelcontextprotocol/typescript-sdk/blob/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c/docs/migration/support-2026-07-28.md) · [Custom methods](https://github.com/modelcontextprotocol/typescript-sdk/blob/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c/docs/advanced/custom-methods.md) · [SEP status](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415) · [Extension sketch](https://github.com/modelcontextprotocol/ext-events/blob/47d95c979faa73427e1f6e0ac0c1347559d8ea37/docs/design-sketch-proposal.md) |
