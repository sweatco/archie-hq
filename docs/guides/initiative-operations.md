# Operating initiative

Use Node 24+, configured Slack, a human `ARCHIE_PROACTIVITY_OWNER` and `ARCHIE_PROACTIVITY_MODE=shadow` to collect and analyze without sending. Knowledge-memory flags do not control observation. Collection starts at successful enablement, with no backfill, auto-joining, DM, private-channel or mailbox observation. See the [architecture](../architecture/proactivity.md).

## Storage and diagnostics

Startup creates `WORKDIR/initiative/state.sqlite` with schema 11. Restarts preserve its watermark, evidence, controls, charges and approved tasks. Old experimental and optional-learner databases are not supported or migrated; attempting to open one leaves it unchanged. Keep historical test snapshots with their original verification artifacts. Do not replace an existing file just to bypass a schema error. Wrong workspace, wrong owner or newer schema also fails.

Use SQLite-aware backups or stop Archie before copying the database; a live copy without its WAL is incomplete.

After building, use:

```bash
node dist/cli/initiative.js <database> <team-id> explain <matter-id> matter.json
node dist/cli/initiative.js <database> <team-id> proposals proposals.json
```

For a source runtime, substitute `node --import tsx src/cli/initiative.ts`. Command names and arguments are validated before opening state. `explain` and `proposals` open read-only and require a current schema; they never create or upgrade storage. Their mode-600 files can contain source evidence and owner state. Keep them within the workspace operator's audience. For authorized current sources and decision reasons, use `read_matter` in the owner DM.

## Owner controls

Send commands in the configured owner's verified DM. Other users and bot messages cannot operate them.

| Command | Effect |
|---|---|
| `initiative status` | Show delivery, controls, coverage, allowance and unsettled requests. |
| `initiative delivery on` / `off` | Enable or disable delivery; live mode and source, audience, budget and interruption checks still apply. |
| `initiative mute` / `unmute` | Block or permit proactive delivery. |
| `initiative pause` / `resume` | Abort/defer analysis and delivery, or resume. |
| `initiative stop` / `start` | Cancel pending analysis and delivery, or seed work again. Intake and existing charge reservations remain. |
| `initiative handled <matter>` | Resolve a matter. |
| `initiative later <matter>` | Snooze to the next weekday 09:00 in Lisbon. |
| `initiative not useful <matter>` | Dismiss a matter. |
| `initiative stop following <matter>` | Dismiss and stop following its thread. |
| `initiative proposal <proposal>` | Inspect the linked task, source availability and waiting reason. |

After review, select live mode and send `initiative delivery on`. This enables delivery without a learning evaluation; it does not enable an installation automatically. Sending is limited to one weekday digest and two other interventions per Lisbon day, during weekday 09:00–18:00. There is no automatic pause or expiry.

Deadlines use the source’s local date, time and timezone, resolved by host code. Incomplete, invalid, skipped or repeated local times stay unknown and receive ordinary checks; they do not acquire a guessed instant. An unknown deadline does not mean the matter is resolved.

Task suggestions name the repository, intended result, sources and normal-task budget before offering **Start task**. Only the owner can start them. Rephrasing an unchanged suggestion reuses its first scope and identity. Fresh human work-thread context or different work requires a new candidate and approval. One approved task identity survives repeated clicks and crashes. Preparation stays inert until the final source check; changed sources require a fresh proposal or an ordinary mention. Approved task replies stay in their saved private owner thread. A confirmed initial PM reply is required before silent completion. Edit-mode and external-action approvals remain in force; the task uses ordinary budgeting outside the $200 background ceiling.

The card becomes **Starting…**, then **Task started · Open task**. Edits retry independently of activation, at most ten due cards per minute, with a 60-second retry delay and a 15-second Slack edit timeout. If an old Start action remains visible during an outage, the server still reuses the original approval. Inspect the linked task and restore access and allow normal extraction to revalidate the matter; do not clear its handoff to force another start. A parked or waiting task is not proof that a feature shipped. This release adds no external filing or outcome-writing commands.

## Background spending

Each background attempt reserves its maximum cost before dispatch. Routine work can use $150/day; priority work has the remaining $50 up to $200, by Lisbon calendar day. Missing usage remains reserved across possible execution days. Exhaustion defers work without stopping collection. Ordinary approved tasks have separate budgets.

This base sends direct requests only. Unknown usage remains reserved because an interrupted request may have executed. Do not refund a charge by age or treat missing usage as zero. Persistent uncertainty may need external provider/accounting evidence. Legacy batch discovery, credential rebinding and recovery commands are removed.

Reflection, training episodes, guidance, cohorts, replay and evaluations belong to the deferred self-evolution change and have no tables in this base. That future change needs its own storage integration. See [verification and limits](initiative-verification.md).
