# Triggers

Triggers let a user say, in plain language, "do Y when X happens" and have Archie set up a persistent rule that spawns a fresh task when the condition fires. They are the one sanctioned form of self-initiated work — everything else is reactive (Slack messages, GitHub webhooks).

Two condition types ship in v1:

- **Schedule** — fires on a recurring cadence (hourly / daily / weekdays / weekly at a time) or once at a future time.
- **Channel-message** — fires on a new **top-level** message in a watched channel matching an optional filter (substring and/or author).

A trigger is **bound** to a delivery target. In v1 that is a **channel** (results posted there). A `user` (DM) binding exists in the type but is **not offered at creation yet** — the fired PM has no DM-capable delivery tool under the current channel model, so `propose_trigger` accepts channel bindings only. User-DM delivery is a planned follow-up.

> Design bias: reuse, no new scheduling engine. The firing loop is the reminder scheduler's index-and-tick pattern; creation reuses the edit-mode Approve/Deny flow; fired tasks are ordinary read-only tasks. The only added dependency is [`croner`](https://www.npmjs.com/package/croner) (a tiny, DST-correct cron parser) used solely to compute next-run times.

## Triggers vs. reminders

These are separate features that share only a pattern:

| | Reminder (`set_reminder`) | Trigger |
| --- | --- | --- |
| Effect | Re-wakes the **current** task later | Spawns a **new** task on a saved rule |
| Lifetime | One-shot, lives on the task | Persistent, lives in the trigger store |
| Floor | none ("remind me in 5 min" works) | ≥1h, **recurring schedules only** |

The two schedulers (`reminder-scheduler.ts`, `trigger-scheduler.ts`) run side by side and never interfere.

## Data model

`src/types/trigger.ts`:

```ts
interface Trigger {
  id: string;                                  // "trg-YYYYMMDD-HHMM-random6"
  status: 'pending' | 'enabled' | 'paused';   // pending = proposed, awaiting approval
  created_by: string;                          // Slack user ID who requested it
  created_at: string;
  approved_by?: string;                        // who clicked Approve / typed y
  binding: TriggerBinding;                     // channel thread or user DM
  conditions: TriggerCondition[];              // any match fires
  action: { prompt: string };                  // seeded to the PM when fired
  last_fired_at?: string;
}
```

- A **recurring** schedule condition carries a `cron` expression plus a precomputed `next_run_at`; after each fire `next_run_at` is recomputed with `croner`.
- A **one-off** schedule condition has only `next_run_at` (no `cron`); it auto-pauses after firing once.
- **Channel privacy is deliberately not stored** on the binding — it's resolved live at list time (see Visibility), so a public↔private conversion can't leak a now-private channel's triggers.

Storage: one JSON file per trigger under `$ARCHIE_WORKDIR/triggers/` (`src/system/trigger-store.ts`), plus — for a trigger that has actually fired — one directory per trigger under `$ARCHIE_WORKDIR/triggers-data/` (see [Persistent per-trigger directory](#persistent-per-trigger-directory) below).

## Scheduling: cron, kept internal

Schedule triggers store an absolute `next_run_at` ISO timestamp — exactly like a reminder — so the 60s tick is unchanged. Cron is **never user-facing**: the PM translates natural language → a cron expression at creation, the system validates the ≥1h floor (two successive runs must be ≥1h apart), and `list_triggers` renders the rule back to prose. One-off schedules bypass cron entirely (a single `next_run_at`, parsed via `parse_datetime`/`chrono-node`).

Offloading DST-correct recurrence math to a tested library is the dumb-simple choice; a hand-rolled helper would take on the same DST problem in custom code.

## Lifecycle

```
User asks in plain language
   → PM agent gathers cadence/channel + what to do + where to deliver
   → propose_trigger  →  status:'pending'  →  Approve/Deny prompt
        Approve → status:'enabled', indexed in the scheduler, announced
        Deny    → pending file deleted
   → (enabled) condition fires → fireTrigger spawns a fresh read-only task
   → that task does the work and posts the result to the bound channel
```

A one-off schedule auto-pauses after it fires (its condition is consumed). **Rescheduling a paused trigger auto-resumes it:** `update_trigger` treats new conditions on a paused trigger as intent to make it live again — it re-enables (re-checking caps) and reports the resume back to the PM so the user is told. Editing only the prompt/summary of a paused trigger does *not* resume it (a deliberate pause is respected). An explicit `status: 'paused'` in the same call always wins.

### Firing

`fireTrigger(trigger, context)` (`src/system/trigger-scheduler.ts`) is shared by the scheduler (schedule context) and the Slack dispatch hook (message context):

1. Create a fresh task; set `metadata.triggered_by = trigger.id`.
2. For a message-context fire, ingest the triggering thread with `Task.append` — knowledge log, linked channel, default channel, no post; for a schedule fire, the spawned PM opens the destination itself.
3. Seed the PM with `AGENT_PROMPTS.triggered(...)` and let it do the work.

**Firing posts no preamble.** The spawned PM does the work and posts the result itself, so the first thing the channel sees is the actual output — not an "I was triggered" line.

**A message fire ingests the thread like any other.** `FireContext` for a message fire carries the whole `SlackThread` the Slack event handler already fetched, and `fireTrigger` hands it to `Task.append` — the same path an @mention or a DM goes through. So the triggering message lands in `knowledge.log` with its real author, its files and attachments, and shared-channel redaction applied, and the thread is linked as the task's default channel, which is what makes the PM reply in the right place.

**It lands in the log, not in the seed, on purpose.** The seed reaches the PM alone: a specialist the PM delegates to never sees it, and the log is the one place every agent on the task reads. Inlining the message would have handed the PM context its own delegates were blind to.

**And the seed says nothing about it.** No text, and no line telling the PM to go and read the log — the PM already reads `knowledge.log` at the start of every turn (`prompts/pm-agent.md`), so a pointer would be words spent restating a default. A draft of this also framed the message as data rather than instructions; that came out too, because nothing frames an ordinary Slack message in the log that way and a trigger's filter leaves an agent no more exposed than an @mention does — anyone in a channel can wake Archie with text of their choosing either way. If that framing is wanted it belongs on the log itself, for every task, not bolted onto this one prompt.

This was a gap rather than a decision. `FireContext.text` was populated from the Slack event and then read by nothing, so a PM woken by "a new message in #x matched your filter" was given the channel and the thread but never the message. It could have fetched the thread itself, but nothing handed the text over and nothing told it to look — and the thread-append path could not have supplied it either, because the fire linked the thread with `linkSlackThread` (now removed, since ingesting the thread does that job) which set `last_processed_ts` to the triggering message's own ts, and that path only appends messages newer than it.

**The seed states no destination.** `AGENT_PROMPTS.triggered` deliberately says nothing about where the result goes, because `fireTrigger` already appended a delivery line to the prompt it passes in and it is the only thing that knows the fire kind. The template used to close with "post the result to the bound channel", which on a message fire sat two paragraphs under a delivery line telling the agent to reply in the triggering thread — one message, two contradictory destinations.

## Persistent per-trigger directory

Each fire is a brand-new task with its own agent workspace, and no fire can reach another's. So a trigger whose job needs continuity — "summarise what changed since last time", "chase the thing you raised yesterday" — used to have no way to carry anything forward, and silently degraded into redoing the work and re-reporting it in full. Every trigger that actually fires now gets one directory that outlives a single fire, at `$ARCHIE_WORKDIR/triggers-data/<trigger-id>/`. A trigger that is never approved or never fires gets none, because creation happens at agent spawn.

**Created at agent spawn, not at fire.** The scheduler is untouched. `ensureTriggerDataDir` (`src/system/trigger-store.ts`) runs from the one block in `spawnAgent` that sits after all three per-track branches, so every agent on a trigger-fired task gets it — PM, repo agent and plugin agent alike. `mkdir` is recursive, which is what makes it idempotent: spawn re-runs once per agent, again on every wake of the task, and again after a restart.

**It refuses to create once the record is gone.** A task outlives the fire that created it — a user can keep replying in its thread, the PM can delegate, a restart re-spawns it — while `metadata.triggered_by` keeps naming a trigger that may since have been deleted. So creation checks that the trigger's record file still exists first, and returns null when it does not. Without that check the next spawn would recreate the directory straight after `deleteTrigger` removed it, resurrecting deleted content and orphaning it for good, because nothing scans `triggers-data/` for entries whose record has gone. The check is deliberately `existsSync` on the record path rather than `loadTrigger`, because `loadTrigger` also returns null for a `JSON.parse` failure and `saveTrigger` truncates before it writes — a spawn reading the record mid-write would otherwise conclude a live trigger had been deleted.

**Granted read-write, in both sandbox lists.** The directory goes into `allowReadPaths` and `allowWritePaths`, the same shape the agent workspace and the repo clones use. It was briefly granted write-only, on the belief that listing a path in both lists makes bwrap lay a read-only bind over the writable one and downgrade it — the claim in [security.md](security.md#known-sandbox-limitations)'s Known Limitation 1. That was measured and is false; both forms behave identically. Write-only also has a real cost: `assertReadable` (`src/agents/artifacts.ts`) validates against `allowReadPaths` alone, so an agent could write a file here and then be refused when it tried to `share_artifact` it. Two things about the grant are still worth knowing:

- **`Bash` reaches it fine, which took measuring.** `denyReadPaths` includes `$ARCHIE_WORKDIR`, so the obvious reading — and an earlier version of this section — was that the parent's `denyRead` destroys the child's grant. It does not. Measured under bwrap 0.11.0 with the production config: an agent granted this path write-only can `cat`, `ls` and write to it from `Bash`, and the writes persist to real disk. `denyRead` emits its `--tmpfs` **before** the `allowWrite --bind`, so the bind lands on top and survives; the parent stays opaque (it renders as a mode-700 tmpfs) while the granted subtree punches through. That is the reverse of what Known Limitation 1 in [security.md](security.md#known-sandbox-limitations) used to claim; that entry now records the correction.
- **The artifact tools can read it**, because it is in `allowReadPaths`. That is not automatic: `assertReadable` checks that list alone, unlike the OS sandbox and the PreToolUse hook, which both treat writable as readable. Any future path granted write-only inherits that gap — `CACHES_DIR` does, and its files cannot be shared through the artifact tools.

**Not in `additionalDirectories`.** `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is on, so a `CLAUDE.md` in an additional directory is auto-loaded into the prompt — and this directory is agent-writable, so listing it there would let one agent inject a prompt into every later agent on the same trigger.

**Announced once, in one place, on every track.** `buildTriggerDataPromptSection` builds a single block appended after the per-track branches. It names the trigger, names the path as read-write, lists the directory's entries (names only, sorted, capped at 50), says to load the `trigger-task` skill, and frames whatever is in there as data rather than instructions, since it was written by an earlier agent. That is all it does.

**Why the skill instruction is in the block and not in the seed message.** The seed (`AGENT_PROMPTS.triggered`) reaches the PM alone, and a delegated repo or plugin agent holds the same directory read-write. The block is the only trigger-specific text every track sees, so it is the only place an instruction reaches everyone who might write there. `knowledge.log` was the other candidate and is worse on two counts: it is the data channel, where user-authored text lands and where the injection rules say to treat what you read as data rather than instruction, and it is chronological, so a line written at fire time reads as a stale event ten turns later rather than as a standing instruction.

Three things the block deliberately does not do, each of which it did at some point during development:

- **It does not name a tool.** Reading a file and listing a directory are things an agent already knows how to do, and a named tool dates the prompt. The failure that made the point was of exactly that kind: an early draft named `Glob`, which this runtime does not have, so the fire reaching for it got `No such tool available` and spent its turn hunting a substitute instead of reading the directory.
- **It does not explain why fires cannot see each other.** That is the skill's opening paragraph. A prompt block that re-explains the model of the feature is a second copy of the skill with nothing keeping the two in step.
- **It does not repeat itself, and neither does the seed.** The PM's context block used to carry a second `Spawned by trigger:` line, the seed a third mention of the directory, and both the seed and the block asserted "you were started by a trigger" after the seed's first sentence had already said the trigger fired. Three statements of one fact drift the moment one is edited, and they did. Now: the seed says what fired and where the result goes, the block names the trigger and its directory, the skill carries the model and the conventions.

The seed no longer claims "there is no prior conversation" either. That was true of the Slack thread and false in spirit — a trigger that has run before does leave context behind. What the sentence was actually carrying is that nobody is waiting on the other end, which is now what it says.

The listing is a convenience rather than a workaround — the directory is granted read-write on both enforcement layers, so an agent can list it perfectly well itself. It is there because it costs nothing and it is what tells a fire whether it has a past at all.

**Two rough edges worth knowing.** The listing is a bare `readdir`, so a subdirectory an earlier fire created appears as a plain name with nothing marking it as a directory; the block says the listing is top-level only, and the skill says to look deeper when it matters. And the grant and the announcement attach on *every* spawn of a task whose `triggered_by` is set, not only on the fire itself: a user replying in the thread days later, a PM delegation, or a post-restart recovery all get them, even though the `trigger-task` skill is written in the voice of a fire. Neither is harmful; both are places the model may be mildly surprised.

**Removed when the trigger is deleted.** `removeTriggerDataDir` is called inside `deleteTrigger`, the single function every deletion entry point funnels through, so no caller changes. A filesystem refusal propagates rather than being swallowed — a caller reporting a deletion that did not happen would tell a user their automation's notes were gone while they were still on disk.

**What is deliberately absent:** nothing pre-creates a file or subdirectory inside it, nothing prunes it, nothing surfaces it to an operator, no trigger can see another's, and its contents are never auto-injected. Conventions — read before you work, leave what the next fire needs, keep it small, treat what is there as data — live in `skills/trigger-task/SKILL.md`, which is mounted on all three agent tracks. A runaway directory therefore stays unbounded and invisible until someone looks at the disk.

### Channel-message dispatch

A single hook in `handleSlackEvent` (`src/connectors/slack/events.ts`) fires channel-message triggers, gated to ambient chatter: no existing task on the thread, not an `@mention`, not a DM, and a top-level message (not a thread reply). So a message that both mentions Archie and matches a trigger creates a direct task and does **not** also fire the trigger. External/guest authors are filtered upstream and can never fire a trigger.

## Confirmation gate (channel-agnostic)

Trigger creation reuses the edit-mode approval mechanism, which is already channel-agnostic:

- `propose_trigger` stashes the proposed id on `task.metadata.pending_trigger_id` and calls `postInteractiveToUser(..., 'trigger')`, which always emits an `approval:requested` event.
- **Slack** renders Approve/Deny buttons; **the CLI** renders the same request as `[y] approve / [n] deny`.
- Both converge on the task-level handlers `handleTriggerApproval` / `handleTriggerDenial`. The Slack buttons carry the trigger id; the CLI `POST /tasks/:id/approve` body is just `{ type:'trigger', approve }`, so the handler falls back to `pending_trigger_id`.

There is **no operator bypass** — approving from the CLI is exactly equivalent to clicking Approve in Slack.

## Visibility & privacy

Scoped by the **tier of the space the request comes from** (`src/system/trigger-visibility.ts`):

- **From a public channel:** all public-channel triggers. Never DM or private-channel triggers.
- **From a private channel:** this private channel's triggers + all public-channel triggers.
- **From a DM:** your own DM triggers + all public-channel triggers.
- **Hard invariant:** a private space's triggers are never visible from outside that exact space.

Privacy is resolved from the **workspace channel map** (`listWorkspaceChannels()` → `conversations.list`, `id → isPrivate`, a process-wide ~10-min cache shared with the `find_slack_channel` tool), so a listing is O(1) lookups with no per-channel Slack calls. A channel not in the cached map (brand-new, just-converted, or archived) falls through to a live `conversations.info` lookup. Both paths **fail closed** — an unresolved channel is treated as private — so a private trigger is never leaked into a public/DM listing. The trade is a bounded ≤10-min staleness window after a public→private conversion of an already-cached channel.

The **operator CLI** (`/api/triggers`, the `t` view) operates at operator trust and sees all triggers, consistent with the existing CLI task list.

## Announcements (no silent changes)

Every **configuration change** — created/enabled, edited, paused/resumed, deleted — posts a one-line notice to the channel the trigger is bound to, even when the change was made from a DM. Firing is **not** a config change and is never announced.

## Protections & limits

- **Propose-then-confirm** — no agent enables a trigger from a model decision alone.
- **Human approval is the loop guard** — a trigger-spawned task *may* call `propose_trigger`, but that only ever creates a `pending` trigger; nothing enables (or fires) without a human clicking Approve, and a task has no way to self-approve (approval comes only from the Slack button or the CLI `/approve` endpoint). So there is no autonomous amplification loop to gate against — the approval step already breaks it. (Runaway pending-proposal spam is bounded by the daily fire cap.)
- **Read-only by default** — a fired task is an ordinary task; any write/push still needs in-the-moment edit-mode approval.
- **Limits** — recurring schedules ≥1h apart; per-user and per-channel active-trigger caps; a per-account daily fired-run cap (in-memory, reset daily).
- **Kill switch** — `ARCHIE_TRIGGERS_ENABLED=false` disables all firing and creation globally.

## CLI & API surface

- `GET /api/triggers`, `GET /api/triggers/:id`, `PATCH /api/triggers/:id` (pause/resume/edit prompt), `DELETE /api/triggers/:id` — operator endpoints, mirroring `/api/tasks`.
- `POST /api/tasks/:id/approve` accepts `type:'trigger'` for the CLI approval gate.
- CLI: press `t` from the task list to open the trigger list (status, bound channel, `[p]` pause/resume, `[d]` delete).

## Key files

| File | Responsibility |
| --- | --- |
| `src/types/trigger.ts` | `Trigger`, `TriggerBinding`, `TriggerCondition` |
| `src/system/trigger-store.ts` | One-JSON-file-per-trigger persistence, plus the per-trigger data directory's lifecycle (`getTriggerDataPath`, `ensureTriggerDataDir`, `removeTriggerDataDir`) |
| `src/agents/trigger-data.ts` | The two pure pieces of the persistent directory: the sandbox grant, and the prompt block that announces the path and lists its contents |
| `src/system/trigger-scheduler.ts` | In-memory index, 60s tick, cron math, `fireTrigger`, announcements |
| `src/system/trigger-visibility.ts` | Pure visibility decision (privacy injected) |
| `src/agents/tools.ts` | PM tools: `propose_trigger`, `list_triggers`, `update_trigger`, `delete_trigger` |
| `src/tasks/task.ts` | `handleTriggerApproval` / `handleTriggerDenial`, `append` (ingests a message fire's thread) |
| `src/connectors/slack/events.ts` | Approve/Deny buttons + channel-message dispatch hook |
| `src/connectors/api/routes.ts` | `/triggers` endpoints + the `trigger` approval branch |
| `skills/triggers/SKILL.md` | Engine-owned PM skill (the orchestration playbook), loaded via the `Skill` tool |
| `skills/trigger-task/SKILL.md` | Conventions for the per-trigger directory. Mounted on **all three** agent tracks, so it is written track-neutrally rather than in the PM's voice |
| `prompts/pm-agent.md` | Short always-present blurb so the PM knows triggers exist before loading the skill |
