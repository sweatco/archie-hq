# Operating initiative

The [architecture](../architecture/proactivity.md) describes the independent observation subsystem. Enable it with Node 24+, Slack configured, a verified internal human `ARCHIE_PROACTIVITY_OWNER`, and `ARCHIE_PROACTIVITY_MODE=shadow`. Keep knowledge-memory flags as required for knowledge memory; they do not control initiative. The first successful activation sets the forward watermark. There is no backfill or auto-joining, and passive collection excludes DMs, private channels and mail.

## Database upgrade and diagnostics

Use the same source or compiled build form as the running instance: use the form matching its executed implementation. For a local `tsx` runtime, replace `node dist/cli/initiative.js` in these commands with `node --import tsx src/cli/initiative.ts`.

Keep the existing `WORKDIR/initiative/state.sqlite` path. Stop Archie and take a SQLite-aware backup before upgrading; an ordinary copy while the WAL is active is not a complete backup. Startup upgrades published schema v4 through v9 transactionally, retaining source IDs, watermark, in-flight work, liabilities, deliveries, feedback, policies and proposals. Schema v8 adds card synchronization state and an indexed retry queue to existing handoffs; previously approved cards enter that queue once so their old Start actions can be removed. Schema v9 disables delivery by default independently of prior learning approvals and preserves inactive learning data and unresolved paid work. A previous learned policy is retained as `deferred_policy`; baseline extraction is refreshed while old outbox rows remain stored. A workspace/owner mismatch or newer schema fails closed. To run the upgrade explicitly after building:

```bash
node dist/cli/initiative.js <database> <team-id> migrate
node dist/cli/initiative.js <database> <team-id> explain <matter-id> matter.json
node dist/cli/initiative.js <database> <team-id> proposals proposals.json
```

Rejected command names, arities and invalid acknowledgement arguments are checked before opening the database. `proposals` and `explain` open read-only; they do not perform migrations or write schema. Output files are created with mode 600. They can contain public-source evidence and owner decision state, so use the workspace operator's access and do not post the files to another audience. The owner DM's `read_matter` tool supplies the explanation with live source authorization. It includes structured suppression/defer reasons, next due work, cost references, delivery states and related task handoffs without requiring a manual table join.

## Owner controls and task starts

Send these commands in the configured owner's verified DM. Other users and bot-authored messages cannot apply them.

| Command | Effect |
|---|---|
| `initiative status` | Delivery enablement, controls, coverage, allowance and unresolved provider attempts. |
| `initiative delivery on` / `off` | Explicitly enable or disable proactive delivery; sending also requires live mode and all source/audience/budget/interruption checks. |
| `initiative mute` / `unmute` | Block or permit new proactive delivery. |
| `initiative pause` / `resume` | Abort/defer background analysis and new delivery, or resume; intake and reconciliation continue. |
| `initiative stop` / `start` | Cancel pending analysis/delivery and advance its responsibility epoch, or seed work again. Existing normal tasks retain their own controls. |
| `initiative handled <matter>` | Resolve the followed matter. |
| `initiative later <matter>` | Snooze to the next weekday 09:00 Europe/Lisbon. |
| `initiative not useful <matter>` | Dismiss the intervention. |
| `initiative stop following <matter>` | Dismiss and stop following the source thread. |
| `initiative proposal <proposal>` | Inspect linked task, preparation/activation state, waiting reason and acknowledged outcome. |
| `initiative outcome <proposal> <implemented\|released\|rejected> <repository artifact URL> <acceptance result>` | Record the owner's explicit outcome evidence, separately from task execution status. |

After review, select live mode and send `initiative delivery on` from the configured owner DM. This is delivery enablement, independent of any learning evaluation. This change does not enable an installation automatically. Ordinary investigation can suggest scoped repository work without reflection; suggestions use the existing outbox and daily interruption slots. The same proposal version is not sent repeatedly. A cancelled proposal can be freshly revalidated and requeued only if it never received a send slot or timestamp; sent, sending, uncertain and approved cards cannot be replayed. Presentation keeps a bounded durable scan cursor so deferred or invalid history cannot starve newer suggestions. **Start task** is an owner-only button on a delivered proposal. The card states the repository, intended result, source links and the switch to ordinary task budgeting outside the $200/day background allowance before approval. The button authorizes that scoped task only; normal edit-mode, GitHub-write, merge and release gates remain.

One durable task identity survives double-clicks and crashes. `preparing` tasks are inert; the first metadata write already contains the complete fixed destination, approval correlation and untrusted brief. Recovery resumes transiently interrupted preparation, and recognizes a durably activated task even if its acknowledgement was lost. A source change during preparation makes the handoff stale and leaves the task inert. Inspect it, obtain a fresh proposal or use the ordinary mention workflow; stale authority is never automatically reactivated.

Approved task replies use the single owner-DM thread persisted during preparation. Their `post_to_user` tool accepts only a message; `post_to_channel` is withheld. Forged targets, another thread in the same DM and inconsistent or missing destination metadata fail closed, including after reload. Existing prepared tasks with a consistent persisted conversation use the same binding without adding a new destination field. Ordinary tasks keep their existing tool and targeting behavior. The initial `report_completion` cannot silently park an approved task until a PM reply has returned a Slack timestamp in that bound conversation. The host persists `owner_reply_delivered`; the completion call may itself supply the reply. Plain assistant text, failed/unconfirmed sends and system budget notices do not satisfy this prerequisite. Ordinary task silent completion, muted conversations and forced stops retain their existing behavior. No arbitrary assistant output is forwarded. Public evidence URLs never determine a reply destination. An explicit request for public outreach is incompatible with this task scope and is refused; it is not privately retargeted.

After durable approval the original card loses its Start action and shows **Starting…**; after confirmed activation it shows **Task started** and an **Open task** link to the owner conversation. Proposal text, source links and the normal-task budget explanation remain. These are handoff states, not claims that the feature shipped; use proposal inspection for subsequent runtime waits. Replayed callbacks do not start another task or post another confirmation reply. Unauthorized or initially stale actions do not alter a valid card.

Card edits run separately from task preparation/activation. A delayed pending edit is serialized before the final edit, and a durable 60-second card-write lease also protects recovery from overlapping edits. Each Slack edit is bounded to 15 seconds without automatic retries. Failure leaves the desired state discoverable in SQLite; minute recovery handles at most ten due unsynchronized cards using an index, with a 60-second retry delay. Successful old cards are not scanned or rewritten on every tick. A crash during an edit leaves its lease to expire; it never rolls back task approval or blocks task activation. If an old action remains visible during an outage, server-side idempotency still applies. Check `initiative proposal <id>` and restore Slack access rather than clearing the handoff or creating another task.

`completed` is a parked PM session, not a shipped feature. Clarification, edit/merge/tool approval, research budget and time budget waits remain distinguishable in proposal inspection. An `implemented` acknowledgement can later become `released`; the artifact URL and acceptance text are the owner's assertion, not an automatic artifact validator. Recording feedback or an outcome does not change Archie behavior in this release.

## Provider reconciliation

The background ledger reserves each paid attempt before dispatch, including explicit retries. Routine work stops admission at $150/day; priority work has the remaining $50 up to a hard $200/day ceiling, on Lisbon calendar days. Outstanding financial exposure carries into possible execution days. Budget exhaustion defers paid work; it does not pause or expire the service.

This release admits no new learning batches. Historical batches are still polled to settle existing responsibility. Lost create responses and process exits recover through persisted `custom_id` correlation with supported provider listing/result streams. `submitting`/`uncertain` can hold execution slots; `retrieving`/`retired` release logical slots only after provider-backed terminal evidence while retaining unresolved money. Status shows unresolved IDs, provider IDs where known, state and maximum liability. Listing may encounter other batches in the provider workspace; unmatched payloads are not saved. Ongoing unrelated batches or missing provider binding deliberately keep an ambiguous attempt conservative.

After a credential change, verify outside Archie that the configured endpoint/key addresses the original provider workspace, then bind the existing **local** batch ID. This is an operator assertion of provider identity, not a refund or retry:

```bash
node dist/cli/initiative.js <database> <team-id> bind-provider <local-batch-id>
node dist/cli/initiative.js <database> <team-id> reconcile-batch <provider-batch-id>
```

`reconcile-batch` retrieves an ended provider batch and correlates its individual results to existing local requests. It does not submit a new paid request. Discovery persists each page until its unattempted candidates are consumed. Unreadable/capped unrelated streams remain represented by a bounded retry-round record and cannot block later pages. Only authoritative individual outcomes or complete billable usage settle liability. Do not delete a stuck charge, refund it by age, or resubmit an unresolved request as new paid work. Results beyond provider retention may require external provider/accounting evidence; missing results remain an explicit unresolved limitation.

## External development workflow and deferred learning

```bash
node dist/cli/initiative.js <database> <team-id> ack <proposal> <repository-issue-URL> filed
```

Offline `ack` accepts only `filed` or `implementing`, optionally followed by a note. It records an issue created under the separate workflow's approvals; it cannot file the issue or declare a feature completed/rejected. Proposals retain their intent and cited evidence. Historical proposals created by reflection stay stored but cannot initiate new tasks in this release; already owner-approved handoffs still recover normally.

Reflection, episode capture, guidance changes, cohorts, replay, evaluations and their operator commands are deferred to the stacked self-evolution change. Existing data remains subject to source retention, while accounting recovery continues without applying late learning output. The [historical verification guide](initiative-verification.md) records its earlier patch; current checks and limits are recorded with the release-split receipt.

The optional stacked [self-evolution guide](../architecture/self-evolution.md) documents explicit opt-in and the evolution-only export/cohort/evaluate and owner policy commands. Those controls approve behavior changes and do not gate ordinary delivery. Disabled learning commands and malformed label files are rejected before writable opening. Startup checks current configuration before reusing approval, and invalid rollback selects baseline behavior without disabling delivery.
