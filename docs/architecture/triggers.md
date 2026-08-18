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
2. Wire delivery — for a message-context fire, link the triggering thread as the default channel (no post); for a schedule fire, the spawned PM opens the destination itself.
3. Seed the PM with `AGENT_PROMPTS.triggered(...)` and let it do the work.

**Firing posts no preamble.** The spawned PM does the work and posts the result itself, so the first thing the channel sees is the actual output — not an "I was triggered" line.

## Persistent per-trigger directory

Each fire is a brand-new task with its own agent workspace, and no fire can reach another's. So a trigger whose job needs continuity — "summarise what changed since last time", "chase the thing you raised yesterday" — used to have no way to carry anything forward, and silently degraded into redoing the work and re-reporting it in full. Every trigger that actually fires now gets one directory that outlives a single fire, at `$ARCHIE_WORKDIR/triggers-data/<trigger-id>/`. A trigger that is never approved or never fires gets none, because creation happens at agent spawn.

**Created at agent spawn, not at fire.** The scheduler is untouched. `ensureTriggerDataDir` (`src/system/trigger-store.ts`) runs from the one block in `spawnAgent` that sits after all three per-track branches, so every agent on a trigger-fired task gets it — PM, repo agent and plugin agent alike. `mkdir` is recursive, which is what makes it idempotent: spawn re-runs once per agent, again on every wake of the task, and again after a restart.

**It refuses to create once the record is gone.** A task outlives the fire that created it — a user can keep replying in its thread, the PM can delegate, a restart re-spawns it — while `metadata.triggered_by` keeps naming a trigger that may since have been deleted. So creation checks that the trigger's record file still exists first, and returns null when it does not. Without that check the next spawn would recreate the directory straight after `deleteTrigger` removed it, resurrecting deleted content and orphaning it for good, because nothing scans `triggers-data/` for entries whose record has gone. The check is deliberately `existsSync` on the record path rather than `loadTrigger`, because `loadTrigger` also returns null for a `JSON.parse` failure and `saveTrigger` truncates before it writes — a spawn reading the record mid-write would otherwise conclude a live trigger had been deleted.

**Granted as a write path only.** The directory goes into the sandbox's `allowWritePaths` and deliberately *not* into `allowReadPaths`: bwrap processes mounts sequentially, so an `allowRead` entry lays a read-only bind over the writable one and silently downgrades it (`src/agents/sandbox.ts`). A writable bind already grants read, and the PreToolUse guard passes a path present only in `allowWritePaths`. Granting a path this way has two consequences worth knowing:

- **`Bash` reaches it fine, which took measuring.** `denyReadPaths` includes `$ARCHIE_WORKDIR`, so the obvious reading — and an earlier version of this section — was that the parent's `denyRead` destroys the child's grant. It does not. Measured under bwrap 0.11.0 with the production config: an agent granted this path write-only can `cat`, `ls` and write to it from `Bash`, and the writes persist to real disk. `denyRead` emits its `--tmpfs` **before** the `allowWrite --bind`, so the bind lands on top and survives; the parent stays opaque (it renders as a mode-700 tmpfs) while the granted subtree punches through. That is the reverse of what Known Limitation 1 in [security.md](security.md#known-sandbox-limitations) claims, and that entry is stale.
- **`assertReadable` had to widen.** It consulted `allowReadPaths` only, so `share_artifact`, `post_files_to_user` and the MCP file bridge would all have refused a file the agent had just legitimately written. It now accepts `allowWritePaths` entries too, matching the rule the sandbox hook already applies. A no-op for every other path, since `allowWritePaths` is a subset of `allowReadPaths` everywhere else.

**Not in `additionalDirectories`.** `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is on, so a `CLAUDE.md` in an additional directory is auto-loaded into the prompt — and this directory is agent-writable, so listing it there would let one agent inject a prompt into every later agent on the same trigger.

**The announcement names the contents.** One prompt block, appended after the per-track branches, gives the path and lists the directory's entries (names only, sorted, capped at 50). The listing is a convenience, not a workaround: the agent can `ls` the directory itself. It exists because `Glob` is absent from this runtime, so an agent reaching for the obvious listing tool gets `No such tool available: Glob` and has to recover — and one live fire, told by an earlier draft of the skill that the shell could not reach the directory either, gave up at that point and could only read a file whose exact name it had been told — the skill's own first step, look at what the last fire left, was unperformable. The block also points at the `trigger-task` skill for the conventions, and frames existing contents as data rather than instructions, since they were written by an earlier agent.

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
| `src/agents/trigger-data.ts` | The two pure pieces of the persistent directory: the write-only sandbox grant, and the prompt block that announces the path and lists its contents |
| `src/system/trigger-scheduler.ts` | In-memory index, 60s tick, cron math, `fireTrigger`, announcements |
| `src/system/trigger-visibility.ts` | Pure visibility decision (privacy injected) |
| `src/agents/tools.ts` | PM tools: `propose_trigger`, `list_triggers`, `update_trigger`, `delete_trigger` |
| `src/tasks/task.ts` | `handleTriggerApproval` / `handleTriggerDenial`, `linkSlackThread` |
| `src/connectors/slack/events.ts` | Approve/Deny buttons + channel-message dispatch hook |
| `src/connectors/api/routes.ts` | `/triggers` endpoints + the `trigger` approval branch |
| `skills/triggers/SKILL.md` | Engine-owned PM skill (the orchestration playbook), loaded via the `Skill` tool |
| `skills/trigger-task/SKILL.md` | Conventions for the per-trigger directory. Mounted on **all three** agent tracks, so it is written track-neutrally rather than in the PM's voice |
| `prompts/pm-agent.md` | Short always-present blurb so the PM knows triggers exist before loading the skill |
