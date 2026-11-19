# Incoming events

**Proposed · Reviewed 2026-11-18 · Implementation has not started.**

An employee can ask Archie in Slack, “When meeting data arrives, summarize it here.” They review the exact instructions, connect the sender and inspect the result. A single **input** can feed one or more saved routines, proactivity, or both. A routine runs the approved instructions. Proactivity decides whether the evidence warrants reaching out.

## Scope and design choices

| Decision | Why |
|---|---|
| Receive generic JSON webhooks and MCP Events webhook subscriptions on one Express route. | Both need sender verification, duplicate detection and a durable receipt. Deployment already supplies Archie's public HTTPS base URL. |
| Store event routines as existing Triggers with an `incoming_event` condition. Fire ordinary Archie Tasks. | The trigger store, approval flow, scheduler budget, Task recovery and Slack destinations already exist. Scheduled and message triggers operate independently. |
| Give incoming events their own SQLite inbox. Feed accepted evidence into existing proactivity. | A sender can receive an acknowledgment before a model runs. Routines still work when proactivity is off. |
| Run one dispatcher in one Node 24 workspace on persistent disk. Use released libraries for signatures and MCP. | The first release can run inside Archie’s existing deployment. It needs neither a separate broker nor a second agent runtime. |

Deferred work includes GitHub-specific handling, provider relays, MCP polling or streaming, multi-host dispatch, arbitrary transformations, a workflow editor, on-call scheduling and automatic cross-provider correlation.

## Requirements in Slack

1. **Review and enable.** Conversation tools draft the input and routine. **Review routine** shows the source account, event filters, project or service context, exact instructions, responsible people and allowed destinations. The owner approves the input’s scope. A new routine uses Archie’s existing trigger approval. Matching events then run under that grant.
2. **Connect and test.** Show the callback URL, authentication method and masked key. For a generic webhook, the owner copies the connection details to the sender. For MCP, Archie registers the callback. A generic input waits for its first event. An MCP input waits for a verified grant. **Check connection** starts no model. **Run with sample** starts a marked, budgeted run with fresh data.
3. **Inspect.** **Inputs** lists visible inputs, including shared and proactivity-only ones. Paginate by conversation and show purpose, owner, consumers, destination scope, health and last activity. **History** distinguishes receipt, filtering, handoff, delivery, failure and unknown delivery outcome. A viewer needs source access to follow a Task or decision link.

Open Bolt views within three seconds and load slow provider details afterward. Tools and callbacks share lifecycle operations. Check the actor, workspace, conversation, input revision and view hash on each action. Public cards show metadata. Private-channel details stay in the originating channel, and DM details stay with the owner. [Trigger permissions](../architecture/triggers.md) · [Slack modals](https://docs.slack.dev/surfaces/modals/)

| Action | Rule |
|---|---|
| Edit or transfer | Ordinary prompt edits follow existing trigger rules and apply to future receipts. Only the owner or recovery operator can change connection settings or transfer ownership to another internal employee. Narrower access applies before the next disclosure, including in an active Task. |
| Pause or resume | Pausing an input cancels all its unstarted work and ignores new arrivals. Pausing a routine affects only that consumer. Explicit resume starts with the next event. Use a fresh sample to test an edit. History has no payload archive for manual replay. |
| Delete | Show the affected consumers before deleting an input. Revoke locally first and keep any remote cleanup pending until confirmed or expired. Deleting a routine leaves its shared input available. |
| Reveal or rotate a key | Generate keys on the host and store them in the encrypted vault. Reveal only in an authorized private view. Keep keys out of model context, URLs, action values and logs. Replace bearer keys immediately. Allow up to five minutes of overlap for planned signing-key rotation. Emergency revocation invalidates both keys. [Vault](../../src/system/secrets-vault.ts) |

## How a delivery becomes work

For a signed `meeting.ended` event, a sender retry should lead to one receipt and one summary Task in the approved private channel. If proactivity also consumes the event, delete the inbox body once both consumers have durably saved the evidence they need. The summary can finish later. If the transcript is missing, the routine says it is unavailable.

**Receive.** Build `POST /webhooks/incoming/:inputId` from deployment’s `ARCHIE_PUBLIC_URL`, already used by the OAuth CLI. Expose the callback through existing HTTPS ingress and keep the operator API private. Use route-local `express.raw` with inflation disabled and a size limit. Enforce the input’s configured authentication scheme. Compare bearer tokens in constant time or verify the Standard Webhooks signature and timestamp against the original body. Reject invalid UTF-8 before parsing a JSON object. [HTTP server](../../src/index.ts) · [Raw route example](../../src/connectors/github/events.ts) · [Operator API boundary](../architecture/tool-approvals.md)

**Match and acknowledge.** Validate the source schema. Match event kind or a bounded JSON Pointer check for equality, membership or presence. No model runs on the request path. In one transaction, write a receipt and one handoff per matching consumer. Capture the approved input revision, routine instructions and destination at receipt time.

| Sender result | Meaning |
|---|---|
| `202` | New matched event committed to the inbox. |
| `200` | Matching retry or deliberately ignored delivery. Filtered and paused events retain no body. |
| `409` | Same event key with changed content. Compare stable content, excluding delivery headers and the MCP cursor. |
| `400/413/415`, `401`, `404/410` | Invalid content, failed authentication or unavailable input, respectively. No Task starts. |
| `429` or `503` | Intake limit reached, or storage unavailable or shutting down. Recognize accepted retries before charging inbox storage. |

Scope duplicate detection to the input and source binding. Generic signed senders use `webhook-id`. Bearer senders may provide `Idempotency-Key`. Each unkeyed bearer delivery is new. MCP uses the subscription binding and occurrence `eventId`. A routine edit leaves that identity intact.

**Run and recover.** Serialize snapshots of event routines with edits and pauses. Existing per-trigger locking covers pending changes, so extend it to the event routines’ live edits. Check the input grant when attaching a routine and again at dispatch. Reserve a Task ID and save its brief and minimum evidence before activation. Add a trigger-specific `Task.prepareTriggered` entry point that shares creation and activation with `Task.prepare` and preserves the existing DM-thread approval rule. Channel-bound Tasks open their own thread. [Trigger store](../../src/system/trigger-store.ts) · [Task preparation](../../src/tasks/task.ts)

Extend `fireTrigger` to return the Task or the reason it skipped a run. On retry, reopen the reserved Task only for the same origin and recover any prior admission before consuming another run slot. After activation, Task recovery owns execution. An unknown external send remains uncertain for review. Reuse `prepareTriggerDelivery` and `prepareMemoryDelivery` to enforce the approved destination for replies, file sharing and memory writes. Ordinary tool and edit approvals still apply. Withhold tools whose effects cannot be scoped. [Scheduler](../../src/system/trigger-scheduler.ts)

### Storage, retention and limits

Keep routine definitions and input bindings in the trigger JSON store. Put the receiver, dispatcher and MCP adapter in `src/incoming/`. Use `WORKDIR/incoming/state.sqlite` outside task mounts, with WAL, full synchronization, foreign keys and transactions.

| Inbox record | Contents |
|---|---|
| Input | Owner, source account, context, filters, approved revision, responsibility mappings, allowed audience, proactivity setting and vault reference. |
| Receipt | Input revision, binding, stable event key and digest, source entity, occurrence and receipt times, temporary payload and outcome. |
| Handoff | One row per receipt and consumer, with its instruction and destination snapshot, attempts, lease, reserved Task or import ID and outcome reference. |
| MCP subscription | Account and profile, event name, canonical arguments, callback, grant and expiry, opaque cursor, renewal and cleanup state. |
| Configuration audit | Actor, action, revision and safe change summary. |

Save new setup as pending and activate it last, after review. An input moves from draft through provisioning to enabled. Track paused or deleting state separately from connection health, such as expired credentials or cleanup pending. Initialize storage before listening and start the dispatcher after Task recovery. Use Archie’s transaction and lease patterns. A worker may finish a handoff only while it owns the current lease. [Proactivity store](../../src/proactivity/store.ts)

**Payload disposal is immediate after handoff.** Delete the raw inbox body in the same transaction that closes the final handoff, whether accepted, skipped, cancelled or terminally failed. Tasks and proactivity retain only the evidence each needs under their own policies. Keep the raw envelope and secrets out of Task briefs, `knowledge.log`, `events.jsonl`, SSE and debug logs. Retain safe timestamps, status, references and duplicate keys or digests so users can inspect failures and senders can retry. Telemetry records counts, timings and failure categories. [Task persistence](../../src/tasks/persistence.ts)

Event Tasks use the scheduler’s existing shared allowance of **200 automated runs per UTC day**. At the cap, record the skip in history. The single inbox worker does not impose a new limit on simultaneous Tasks.

| Proposed operating default | Purpose |
|---|---|
| 1 MiB per request, 10 seconds to read, 30 authenticated requests per minute per input | Bound intake. Use existing ingress protection for unauthenticated traffic. |
| 100 MiB per input, 1 GiB per workspace | Bound bodies waiting for handoff. |
| Five preparation attempts in one hour with backoff | Recover incomplete handoffs safely and then surface failure. |
| Seven days for unresolved handoffs, 30 days for receipt and duplicate metadata | Expire abandoned work and bound history. The seven-day window applies only while a handoff is unfinished. |

## MCP subscription contract

- **Discover.** Use one background client per operator-approved HTTPS Streamable HTTP server from the root `.mcp.json`. Configure allowed owners, event scopes and audiences in Archie’s server metadata. The credential belongs to the integration account. An input owner can narrow that grant. Use an explicit authorization header first, otherwise refresh the integration account’s vault credentials before each operation. Reconnect after credential or configuration changes. Stdio and legacy SSE-only servers are outside this release. [Plugin loader](../../src/system/plugin-loader.ts) · [OAuth resolution](../../src/system/oauth/inject.ts)
- **Negotiate.** Use the released v2 client with automatic version negotiation. Detect top-level `capabilities.events` on legacy initialize or modern discovery. Intercept the correlated initialize or discovery response in the transport’s forwarding callback before SDK parsing drops the field. The released modern discovery probe bypasses a preattached listener. Prefer the modern 2026-07-28 `io.modelcontextprotocol/events` extension when advertised, send its per-call capability and require a complete result envelope. Use public custom-method APIs. Clear transport observations on reconnect. Report missing capability, failed authentication and network failure distinctly. [OpenAI profile](https://developers.openai.com/plugins/build/mcp-events) · [Pinned extension contract](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/4165cc2e580afa795842002f631edbbe17c63757/seps/3415-events-extension.md)
- **Connect.** Page through `events/list` and validate arguments and event payloads with the SDK’s bounded schema validator, with remote references disabled. Once the receiver is listening, save the callback, approved intent and vault reference for a new `whsec_` secret made from 32 random bytes encoded in base64. Then call `events/subscribe`. Verify every callback, echo the signed JSON challenge and hold early occurrences until the provisional subscription ID matches the returned grant.
- **Renew and recover.** Retry, renew and unsubscribe with the original principal, callback URL, event name and canonical arguments. Request one hour and renew before the returned `refreshBefore`. Proposed defaults are a five-minute catalog cache with manual refresh and renewal at 80% of the grant with jittered retry backoff. Cap the renewal safety margin at the smaller of 10% of the grant and 60 seconds. Commit each receipt and its cursor together. Serialize cursor updates with renewals in arrival order. Cursors are opaque. After interruption, recover up to seven days where supported. Expose a gap for null cursors or truncated coverage.
- **Disconnect.** Termination stops renewal. Record unknown authenticated controls in history. Controls never launch work. Pause and delete revoke locally, stop renewal and request `events/unsubscribe`. Late grants cannot re-enable the input. A replacement gets its own binding. Verify late callbacks against their original binding and show pending cleanup until confirmed or expired.

## Proactivity and audience

Represent evidence as `slack_thread` or `incoming_event`. The source adapter loads snapshots, supplies citations and rechecks access for analysis, recall, delivery and **Start task**. Group by a stable provider entity ID when available. Otherwise keep occurrences separate. Preserve occurrence time and coverage. Conflicting updates leave the current state uncertain. For push-only sources, cite what the event reported at its timestamp and withhold actions that require unverified current state. [Access checks](../../src/proactivity/access.ts) · [Recall](../../src/proactivity/recall.ts)

An incident may identify its responsible employee through a configured service owner or verified identity mapping. Private outreach requires an allowed internal recipient who can access every contributing source. Unknown ownership yields no guessed DM. **Start task** requires the recipient’s approval. Suppress overlapping outreach while a routine handles the same entity, then reassess using its outcome. [Task handoff](../../src/proactivity/handoff.ts)

Reuse existing analysis, budgets, feedback and delivery. **Off** creates no proactive backlog. **Shadow** analyzes without sending. **Live** applies existing delivery checks. Commit `incoming:<receipt-id>` with the evidence and jobs in the proactivity database before marking the inbox handoff complete. A crash between the commits must produce one import. [Proactivity architecture](../architecture/proactivity.md) · [Schema migration](../../src/proactivity/persistence/schema.ts)

## Implementation and acceptance

1. **Prove a generic webhook routine in Slack.** Qualify the signing library with valid, altered, expired and invalidly encoded requests. Connect the receiver, trigger handoff and Bolt panels. Walk through review, enable, sample, history, pause and resume. Interrupt before receipt commit, after Task preparation and after activation. Redelivery with a stable ID must yield one Task in the approved destination and reuse its admission. Verify full storage, competing workers, forwarded or stale controls, and revocation during a post, file share or memory write. Existing schedule and message trigger tests must pass.
2. **Add MCP subscriptions.** Discovery can be tested alongside the generic receiver. Exercise both transport paths for the top-level profile and the modern extension with the pinned client. Once the public callback and panels work, test challenge-before-grant, a lost response, short grants, expired OAuth with and without an explicit header, cursor gaps, rotation, and late responses after pause or replacement. Use a real publisher for a full subscribe, deliver, renew and unsubscribe cycle.
3. **Feed one input to a routine and proactivity.** This depends on durable handoff and routine identity. Migrate schema 12 to 13 in one transaction. Give snapshots, revisions, observations and matters a source kind and key. Preserve Slack IDs, budgets, feedback, approvals, leases and pending or uncertain sends. On a migrated copy, interrupt after the proactive evidence commit. Verify one import, one routine Task and immediate body deletion after both consumers accept. Reject wrong-workspace and newer databases without modifying them.
4. **Review actual output.** Run `npm run check` on Node 24. Use real Slack panels, a signed generic sender and an MCP publisher with an isolated E2E workdir and subscriptions. A complete transcript produces an accurate summary in the approved channel. A missing transcript is reported as missing. A relevant incident produces useful, sourced help. An irrelevant incident stays quiet. Test conflicting ownership, mixed private/public evidence and an event asking Archie to post elsewhere. Use a unique raw-body marker and dummy key to verify telemetry and backup disposal. [E2E harness](../../.claude/skills/archie-e2e/SKILL.md)

## Rollout and recovery

Start disabled. Test migration and restore on a copy, enable one input and routine, then review shadow decisions before enabling live outreach. Monitor waiting handoffs, expiry, renewal failures, delivery failures and output quality. The kill switch stops admission and workers while allowing local revocation and later cleanup.

For a restore point, stop admission, drain handoffs, stop writers and export a clean SQLite snapshot without raw bodies or WAL files. Back it up with the matching trigger, Task, proactivity and vault state. Disable inputs whose keys cannot be recovered. Restore paused with the matching binary. Reconcile later receipts, revocations and uncertain sends before resuming. A schema downgrade requires the pre-migration backup and matching earlier binary.

Record the tested code and configuration revisions, receipt and Task or decision IDs, observed outputs and failures here. Update the owning architecture and operations docs at implementation. Maintainer review covers persistence and authorization. User acceptance covers usefulness, audience and side effects. [Deployment backups](../guides/deployment.md) · [Code review](../guides/coding-guidelines.md) · [PM routine](../guides/project-management.md)

## Research behind the choices

Research on 2026-11-16 examined Archie revision `465a9cb2`, upstream code and published packages. A local v1.30.0 schema probe confirmed that top-level `events` is dropped. The 2026-11-18 review checked the HTTP, trigger, Task, OAuth and proactivity paths at `bdc01098` and verified both pinned npm releases. Live interoperability, crash recovery and output quality still need implementation evidence.

| Source | What Archie can reuse |
|---|---|
| Hermes | Named routes on one receiver. Its ordinary agent runs have durable admission, but delivery paths differ and its implementation depends on the Python gateway and session runtime. [Receiver](https://github.com/NousResearch/hermes-agent/blob/43dc9a0a2848e8ddec2e57c578f49199cb0a8bba/gateway/platforms/webhook.py) · [Durable ingress](https://github.com/NousResearch/hermes-agent/blob/43dc9a0a2848e8ddec2e57c578f49199cb0a8bba/gateway/platforms/webhook_ingress.py) |
| OpenClaw and Pi | OpenClaw separates receipt from reaction. Its helpers depend on its gateway and scheduler. Pi's extension bus runs in-process and its experimental durable harness adds a runtime while leaving authentication to the host. Keep Archie's own dispatch and Task recovery. [OpenClaw SDK](https://github.com/openclaw/openclaw/blob/89d07fe54e1f304bfc3f6f5b04bd6d1b2463be85/src/plugin-sdk/webhook-ingress.ts) · [Pi SDK](https://github.com/earendil-works/pi/blob/a9878e136f5576c2ffd00c6ff054c9cd07a4b277/packages/coding-agent/docs/sdk.md) · [Pi durable harness](https://github.com/earendil-works/pi/blob/a9878e136f5576c2ffd00c6ff054c9cd07a4b277/packages/durable/README.md) |
| Grok Bot | The supplied examples and published docs support conversational setup, review, connection details and history. Implement that experience with Slack Bolt. [Grok routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) |
| Released libraries | Declare `standardwebhooks@1.1.1` directly for signature and timestamp verification. The release decodes buffers as UTF-8. Archie already locks an older transitive version. Use `@modelcontextprotocol/client@2.4.0` for negotiation and custom requests alongside Archie's existing v1 SDK. Preserve both packages’ license notices. The inspected extension proposal was open and its repository experimental, so test the pinned contract against a publisher. [Signing package](https://www.npmjs.com/package/standardwebhooks) · [MCP client](https://www.npmjs.com/package/@modelcontextprotocol/client/v/2.4.0) · [SDK negotiation](https://github.com/modelcontextprotocol/typescript-sdk/blob/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c/docs/migration/support-2026-07-28.md) · [Custom methods](https://github.com/modelcontextprotocol/typescript-sdk/blob/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c/docs/advanced/custom-methods.md) · [SEP status](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415) · [Extension sketch](https://github.com/modelcontextprotocol/ext-events/blob/47d95c979faa73427e1f6e0ac0c1347559d8ea37/docs/design-sketch-proposal.md) |
