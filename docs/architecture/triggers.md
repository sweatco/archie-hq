# Triggers

Triggers let a user say, in plain language, "do Y when X happens" and have Archie set up a persistent rule that spawns a fresh task when the condition fires. They are the one sanctioned form of self-initiated work — everything else is reactive (Slack messages, GitHub webhooks).

Two condition types ship in v1:

- **Schedule** — fires on a recurring cadence (hourly / daily / weekdays / weekly at a time) or once at a future time.
- **Channel-message** — fires on a new **top-level** message in a watched channel matching an optional filter (substring and/or author).

A trigger is **bound** to a delivery target: a **channel** (results posted as a thread) or a **user** (results delivered by DM).

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

Storage: one JSON file per trigger under `$ARCHIE_WORKDIR/triggers/` (`src/system/trigger-store.ts`).

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

### Firing

`fireTrigger(trigger, context)` (`src/system/trigger-scheduler.ts`) is shared by the scheduler (schedule context) and the Slack dispatch hook (message context):

1. Create a fresh task; set `metadata.triggered_by = trigger.id`.
2. Wire delivery — for a message-context fire, link the triggering thread as the default channel (no post); for a schedule fire, the spawned PM opens the destination itself.
3. Seed the PM with `AGENT_PROMPTS.triggered(...)` and let it do the work.

**Firing posts no preamble.** The spawned PM does the work and posts the result itself, so the first thing the channel sees is the actual output — not an "I was triggered" line.

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
- **Provenance gate** — `propose_trigger` refuses when `metadata.triggered_by` is set, so a triggered task can't create more triggers (no amplification loops).
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
| `src/system/trigger-store.ts` | One-JSON-file-per-trigger persistence |
| `src/system/trigger-scheduler.ts` | In-memory index, 60s tick, cron math, `fireTrigger`, announcements |
| `src/system/trigger-visibility.ts` | Pure visibility decision (privacy injected) |
| `src/agents/tools.ts` | PM tools: `propose_trigger`, `list_triggers`, `update_trigger`, `delete_trigger` |
| `src/tasks/task.ts` | `handleTriggerApproval` / `handleTriggerDenial`, `linkSlackThread` |
| `src/connectors/slack/events.ts` | Approve/Deny buttons + channel-message dispatch hook |
| `src/connectors/api/routes.ts` | `/triggers` endpoints + the `trigger` approval branch |
| `skills/triggers/SKILL.md` | Engine-owned PM skill (the orchestration playbook), loaded via the `Skill` tool |
| `prompts/pm-agent.md` | Short always-present blurb so the PM knows triggers exist before loading the skill |
