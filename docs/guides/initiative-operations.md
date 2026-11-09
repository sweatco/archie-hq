# Operating initiative

Use Node 24+, configured Slack and `ARCHIE_PROACTIVITY_MODE=shadow` to collect and analyze without new proactive messages. Mode alone controls enablement: `off` skips the subsystem, `shadow` analyzes, and `live` permits eligible sends. No administrator identity, startup DM or delivery command is required. Knowledge-memory flags do not control observation. Collection starts at successful enablement, with no backfill, auto-joining, DM, private-channel or mailbox observation. See the [architecture](../architecture/proactivity.md).

## Storage and diagnostics

Startup creates `WORKDIR/initiative/state.sqlite` with schema 12. Restarts preserve its watermark, evidence, charges, deliveries and approved tasks. There are no upgrade migrations; older schemas and unknown nonempty databases are rejected unchanged. Keep archived test snapshots with their original verification artifacts. Wrong workspace or newer schema also fails.

Use SQLite-aware backups or stop Archie before copying the database; a live copy without its WAL is incomplete.

After building, use:

```bash
node dist/cli/initiative.js <database> <team-id> explain <matter-id> matter.json
node dist/cli/initiative.js <database> <team-id> proposals proposals.json
```

For a source runtime, substitute `node --import tsx src/cli/initiative.ts`. Command names and arguments are validated before opening state. `explain` and `proposals` open read-only and require a current schema; they never create or upgrade storage. Their mode-600 files can contain source evidence and private employee state. Keep them within the workspace operator's audience. For authorized current sources and decision reasons, use `read_matter` in the responsible employee's DM.

## Employee feedback and deployment modes

Employees send feedback and inspect their own proposals in their verified human DM. Other employees and bot messages cannot act on their matters or approvals.

Public nudges are plain source-thread replies with no recipient or buttons. Private feedback and Start task buttons are restricted to the saved responsible employee, with the same identity and source checks enforced on callbacks. Failed employee lookups block private help without invalidating valid public discussions.

| Command | Effect |
|---|---|
| `initiative handled <matter>` | Resolve a matter. |
| `initiative later <matter>` | Snooze to the next weekday 09:00 in Lisbon. |
| `initiative not useful <matter>` | Dismiss a matter. |
| `initiative stop following <matter>` | Dismiss that matter without suppressing other employees in the thread. |
| `initiative proposal <proposal>` | Inspect the linked task, source availability and task state. |

After review, configure live mode in the deployment to permit new proactive delivery. Changing the mode requires restarting Archie. Source, audience, budget and interruption checks still apply. Sending is limited to one weekday digest and two other interventions per destination per Lisbon day, during weekday 09:00–18:00. There is no automatic pause or expiry.


Shadow continues valid existing private-card approvals, approved/prepared task recovery and their card updates. Off skips initiative recovery; already activated ordinary tasks retain their normal lifecycle and controls.

Deadlines use the source’s local date, time and timezone, resolved by host code. Incomplete, invalid, skipped or repeated local times stay unknown and receive ordinary checks; they do not acquire a guessed instant. An unknown deadline does not mean the matter is resolved.

Task suggestions name the repository, intended result, sources and normal-task budget before offering **Start task**. Only the saved responsible employee can start them. Rephrasing an unchanged suggestion reuses its first scope and identity. Fresh human work-thread context or different work requires a new candidate and approval. One approved task identity survives repeated clicks and crashes. Preparation stays inert until the final source check; changed sources require a fresh proposal or an ordinary mention. Approved task replies stay in their saved private employee thread. A confirmed initial PM reply is required before silent completion. Edit-mode and external-action approvals remain in force; the task uses ordinary budgeting outside the $200 background ceiling.

The card becomes **Starting…**, then **Task started · Open task**. Edits retry independently of activation, at most ten due cards per minute, with a 60-second retry delay and a 15-second Slack edit timeout. If an old Start action remains visible during an outage, the server still reuses the original approval. Inspect the linked task and restore access; after channel access loss, allow normal extraction to revalidate the matter. Do not clear its handoff to force another start. Proposal inspection uses the task's existing status and pending approvals; it does not track a separate waiting reason. A parked or waiting task is not proof that a feature shipped. This release adds no external filing or outcome-writing commands.

## Background spending

Each background attempt reserves its maximum cost before dispatch. Routine work can use $150/day; priority work has the remaining $50 up to $200, by Lisbon calendar day. Missing usage remains reserved across possible execution days. Exhaustion defers work without stopping collection. Ordinary approved tasks have separate budgets.

This base sends direct requests only. Unknown usage remains reserved because an interrupted request may have executed. Do not refund a charge by age or treat missing usage as zero. Persistent uncertainty may need external provider/accounting evidence.

Reflection, training episodes, guidance, cohorts, replay and evaluations belong to the deferred self-evolution change and have no tables in this base. That future change needs its own storage integration. See [verification and limits](initiative-verification.md).
