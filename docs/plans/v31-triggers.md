# Triggers — Implementation Plan

## Context

Archie is purely reactive: it acts only on an inbound Slack message or a GitHub webhook. The one piece of proactivity — the reminder scheduler (`src/system/reminder-scheduler.ts`) — can only re-wake an *existing* task; it cannot start work on its own.

**Triggers** let a user say, in plain language, "do Y when X happens" and have Archie set up a persistent rule that spawns a fresh task when the condition fires. Two types ship in v1:

- **Schedule trigger** — fires on a recurring cadence (hourly / daily / weekdays / weekly at a time) or once at a future time. Bound to a **user** (delivers by DM) or a **channel** (posts a thread).
- **Channel-message trigger** — fires on a new **top-level** message in a bound channel matching an optional filter. Bound to a **channel**.

GitHub-event triggers are a deliberate follow-up (webhook plumbing in `src/connectors/github/` already exists).

**Design bias: reuse, dumb-simple, no new scheduling engine.** The firing engine is the reminder scheduler's index-and-tick pattern (the only added dependency is `croner`, a tiny zero-dep cron parser, used solely to compute next-run times). Creation reuses the edit-mode Approve/Deny button flow. Channel binding reuses `postToUser` targets. Fired tasks are ordinary read-only tasks. The only genuinely new surface is a small trigger store, a scheduler clone, four PM tools, two Slack action handlers, and one dispatch hook.

### Scheduling: cron, kept internal

Schedule triggers store an absolute `next_run_at` ISO timestamp — exactly like `reminder.trigger_at` — so the 60s tick is unchanged. After a recurring fire we recompute `next_run_at` with a **cron** library (`croner` — zero runtime deps, built-in IANA timezone + DST handling) via a single `.nextRun()` call. Cron is **never user-facing**: the PM translates natural language → a cron expression at creation, validates the ≥1h floor (reject if two successive fires are < 1h apart), and renders cron → prose ("weekdays at 9am") for `list_triggers`. One-off schedules bypass cron entirely — a single stored `next_run_at` (parsed via the existing `parse_datetime`/`chrono-node` path) that fires once and auto-pauses.

Rationale: DST-correct recurrence math is the one genuinely subtle part here, and offloading it to a tested library is the dumb-simple choice. A hand-rolled recurrence helper would take on the same DST problem in custom code while being less flexible — a worse trade. `croner` keeps the dependency footprint trivial.

## Data Model

**New file `src/types/trigger.ts`:**

```ts
interface Trigger {
  id: string;                                  // "trg-YYYYMMDD-HHMM-random6"
  status: 'pending' | 'enabled' | 'paused';   // pending = proposed, awaiting Approve
  created_by: string;                          // Slack user ID who requested it
  created_at: string;
  binding: TriggerBinding;
  conditions: TriggerCondition[];              // N conditions, any match fires (mixing)
  action: { prompt: string };                  // PM instruction seeded when fired
  last_fired_at?: string;
}

type TriggerBinding =
  | { type: 'channel'; channel_id: string; channel_name: string } // privacy resolved live, not stored
  | { type: 'user'; user_id: string };         // delivers via DM

type TriggerCondition =
  | { type: 'schedule'; tz: string; next_run_at: string; cron?: string } // recurring if cron set; one-off if absent
  | { type: 'channel_message'; channel_id: string; match?: { contains?: string; from_user?: string } };
```

`next_run_at` is the precomputed next fire instant. **Channel privacy is deliberately NOT stored on the trigger** — it is resolved live at list time (see Visibility), because a channel can be converted public↔private after the trigger is created and a stale cached value would leak a now-private channel's triggers into public contexts.

**New file `src/system/trigger-store.ts`** — mirrors `src/tasks/persistence.ts` path/load/save helpers. Add `TRIGGERS_DIR = join(WORKDIR, 'triggers')` to `src/system/workdir.ts` (alongside `SESSIONS_DIR`, `src/system/workdir.ts:26-36`). Functions: `saveTrigger`, `loadTrigger`, `listTriggers`, `deleteTrigger`, `enableProposedTrigger(id, approverId)`. One JSON file per trigger.

## Scheduler Module

**New file `src/system/trigger-scheduler.ts`** — a near-copy of `reminder-scheduler.ts:33-149`:

- In-memory index of `enabled` triggers that have a schedule condition.
- `initTriggerScheduler()`: `rebuildFromDisk()` scans `${TRIGGERS_DIR}/*.json`, then `setInterval(checkDue, 60_000)` + an immediate `checkDue()` to fire overdue runs after downtime.
- `checkDue()`: for each schedule condition with `next_run_at <= now`, call `fireTrigger(...)`; then, if `cron` is set, recompute `next_run_at = new Cron(cron, { timezone: tz }).nextRun()` (recurring); if `cron` is absent, set the trigger `status: 'paused'` (one-off auto-disable). Persist.
- **Downtime catch-up guard:** a run more than one full interval overdue fires once, not once per missed window.
- Next-run computation is a single `croner` call — no hand-rolled date math. The ≥1h floor is validated at creation by checking two successive `nextRun()` values are ≥ 1h apart.

**`fireTrigger(trigger, context)`** (shared by scheduler and the message dispatch hook):

1. `const task = await Task.create()` (`src/tasks/task.ts:124-161`).
2. Establish the comms channel via `postToUser` (`src/tasks/task.ts:327-390`, `PostTarget` at `:16-23`), which auto-registers the channel through `registerSlackChannel` (`:600-613`) and promotes it to `default_channel`:
   - `binding.type === 'user'` → `task.postToUser(seed, 'system', { new_dm: user_id })`.
   - `binding.type === 'channel'` + message context → reuse the triggering thread (`{ channel: <key> }` or register the message thread).
   - `binding.type === 'channel'` + schedule context → `{ new_thread: channel_id }`.
3. Set `task.metadata.triggered_by = trigger.id`.
4. `task.sendMessage(AGENT_PROMPTS.triggered(reason, context), 'pm-agent')` (`src/tasks/task.ts:201-211`) — activates the task and spawns the PM.
5. `emitEvent('trigger:fired', ...)` (for observability/logs only — not a Slack message), set `last_fired_at`, persist. The task itself posts its actual result to the channel when the work is done; there is no separate "I was triggered" preamble.

## Channel-Message Dispatch

One hook in `handleSlackEvent` (`src/connectors/slack/events.ts`), placed right after `findTaskByThread(threadId)` (~`:452`) and gated so it only handles ambient channel chatter:

```
if (!taskId && event.type === 'message' && !event.channel.startsWith('D') && !isThreadReply) { ...check trigger index... }
```

- Reuses existing self-message filtering (`routeSlackEvent`, `:360-370`) and external/guest filtering (`isExternalUser`, `:393-404`).
- Skips `app_mention`/DM (those create a direct task) so a message aimed at Archie never double-fires a channel trigger.
- For each `channel_message` trigger bound to `event.channel` whose `match` passes, call `fireTrigger(trigger, { kind: 'message', text, ts })`.

## PM Tools

Four PM-only tools added to `createOrchestrationMcpServer()` (`src/agents/tools.ts:1556-1568`), modeled on `createSetReminderTool` (`:1478-1506`) and `createRequestEditModeTool` (`:463-531`):

- **`propose_trigger(binding, conditions, action_prompt)`** — validates (schedule interval ≥ 1h; per-user & per-channel active-trigger caps via counting trigger files; **refuses if `task.metadata.triggered_by` is set** → triggered tasks cannot create triggers), writes a `status:'pending'` trigger, stores its id on `task.metadata.pending_trigger_id`, then calls `task.postInteractiveToUser(text, blocks, 'trigger')` — which renders Approve/Deny buttons in Slack (`action_id`s `approve_trigger`/`deny_trigger`, `value: trigger.id`) and the same `[y]/[n]` prompt in the CLI. Does **not** pause the task.
- **`list_triggers()`** — no params. Returns **everything visible from the current context** (per the Visibility rules below). The PM filters/narrows conversationally from there ("which ones are in this channel", "just the schedules") — no scope argument needed.
- **`update_trigger(id, { status?, action_prompt?, conditions? })`** — pause/resume/edit; re-validates, re-indexes the scheduler, announces.
- **`delete_trigger(id)`** — removes the file, de-indexes, announces.

`update_trigger`/`delete_trigger` first assert the trigger is visible from the current context (privacy rule); anything visible is manageable (no owner-lock).

## Confirmation Flow

Reuses the edit-mode approval mechanism exactly — and that mechanism is **already channel-agnostic**, so the gate works identically in Slack and in the CLI with no special-casing. `postInteractiveToUser` (`src/tasks/task.ts:472`) always `emitEvent('approval:requested', ...)`; Slack renders Approve/Deny buttons, the CLI's `TaskDetail` renders the same request as `⏳ … [y] approve / [n] deny` and POSTs to `/tasks/:id/approve` (`routes.ts:216-253`). Both front-ends converge on the same task-level handlers.

- Extend the `approvalType` union (`src/tasks/task.ts:472`) and the CLI's matching type (`src/cli/components/TaskDetail.tsx:105-120`) to `'edit_mode' | 'research_budget' | 'trigger'`.
- Add task methods `handleTriggerApproval()` / `handleTriggerDenial()` next to `handleEditModeApproval()` (`src/tasks/task.ts:885-913`). Approval sets the proposed trigger `status:'enabled'`, indexes the scheduler (computing `next_run_at`), announces to the bound channel, emits `trigger:created`; denial deletes the pending file. Because the CLI `/approve` body is only `{ type, approve }` (no id), `propose_trigger` stashes the proposed id on `task.metadata.pending_trigger_id`, and the handler reads it from there — exactly how the edit-mode handler reads task state.
- **Both entry points call those methods:** the Slack `approve_trigger`/`deny_trigger` Bolt action handlers (added next to `approve_edit_mode`, `src/connectors/slack/events.ts:201-251`) `ack()` + `updateMessage(...)` to swap the buttons, then call the task method; the `/tasks/:id/approve` endpoint gains a `type === 'trigger'` branch that calls the same method. The Slack button still carries `trigger.id` in `value` for its own `updateMessage`, but the enable/deny logic lives in the shared task method.

## Visibility & Privacy

Scoped by the **tier of the space the request comes from** (the task's originating channel/DM). You can only ask from a space you're already in, so membership is enforced implicitly.

- **From a public channel:** see all **public-channel** triggers. Never any DM or private-channel trigger.
- **From a private channel:** see this private channel's triggers + all public-channel triggers. Never *other* private channels or DMs.
- **From a DM:** see your own DM triggers + all public-channel triggers. Never private channels or other DMs.
- **Hard invariant:** a private space's triggers are never visible from outside that exact space.

**Privacy is resolved live, not cached.** `list_triggers` enumerates trigger files, then for each candidate channel trigger resolves the channel's *current* public/private state via `conversations.info` (extended `getChannelInfo`), memoized per call so each distinct channel is looked up at most once. This is correct across a public↔private conversion — a channel that became private immediately drops out of public/DM listings even though the trigger was created while it was public. Listing is infrequent (a user explicitly asks), so the extra Slack lookups are not a hot path.

## Announcements (no silent changes)

A **configuration change** — created/enabled, edited, paused/resumed, deleted — posts a one-line notice to the channel where the trigger is bound (via `postToUser` targeting the binding), even when the change was made from a DM. This is the transparency guarantee: you can manage a channel's trigger from afar, but the channel always sees that its configuration changed.

**Firing is not a config change and is not announced.** When a trigger fires, the spawned task simply does its work and posts its result to the bound channel like any task — no "I was triggered" preamble (that would be noise, especially for a message-triggered task already replying in-thread).

## CLI & API surface

Triggers must be fully usable from the operator CLI, not only Slack — both the **list view** ("see what triggers exist, and which channel each is bound to") and the **approval gate** ("approve/deny a proposed trigger without Slack"). The CLI is an HTTP client of the local API (`src/connectors/api/routes.ts`, `src/cli/api.ts`), which already lists tasks (with their bound `channel_name` and reminders) at `GET /tasks` (`routes.ts:69-117`) and renders them in `src/cli/components/TaskList.tsx`.

- **Approval, not bypass.** The same propose-then-confirm gate runs on the CLI — there is no operator bypass. Creation via natural language to the PM proposes the trigger; the proposal surfaces in the CLI as `[y] approve / [n] deny` (see Confirmation Flow, which already routes through the channel-agnostic `approval:requested` → `/tasks/:id/approve` path). Approving from the CLI is exactly equivalent to clicking Approve in Slack. The bound Slack channel still gets the config-change announcement.
- **List view connected to channels.** Add `GET /triggers` (returning each trigger with its resolved bound `channel_name`/DM, status, schedule prose, and `last_fired_at`), mirroring the `/tasks` shape, plus a `TriggerList` CLI component mirroring `TaskList.tsx` — so the operator sees every trigger and which channel it's wired to, the same way the task list shows `#channel` / `cli` / `DM with …`.
- **Lifecycle endpoints** — `PATCH /triggers/:id` (pause/resume/edit) and `DELETE /triggers/:id`, both flowing through `trigger-store.ts` and (un)indexing the scheduler, so CLI and Slack act on one source of truth.
- **CLI visibility = operator trust level.** The per-Slack-context privacy rules below are an end-user concept for the Slack `list_triggers` tool. The operator CLI already sees all tasks/sessions (including DMs), so the CLI `/triggers` list shows all triggers regardless of binding privacy — consistent with the existing CLI task list.

## Protections & Limits

- **Propose-then-confirm** — no agent enables a trigger from a model decision alone.
- **Provenance gate** — `propose_trigger` refuses when `triggered_by` is set (no amplification loops) and relies on the existing external/guest bail-out (`events.ts:393-404`) so outsiders can't create triggers or fire channel triggers.
- **Read-only by default** — a fired task is an ordinary task; any write/push still requires in-the-moment edit-mode approval in-channel (`request_edit_mode`).
- **Limits** — the **≥1h floor applies ONLY to *recurring* schedule triggers** (the runaway-loop risk). It does **not** apply to one-off schedule triggers, and it has **nothing to do with reminders**. Plus per-user & per-channel active-trigger caps; per-account daily fired-run cap (in-memory counter in the scheduler, reset daily). Over a cap → reject creation / drop the fire and notify.
- **Kill switch** — `ARCHIE_TRIGGERS_ENABLED` env flag disables all firing and creation globally.

### Triggers vs. reminders (no interference)

Reminders are a separate, untouched feature: `set_reminder`/`parse_datetime` wake the **current** task later (`reminder-scheduler.ts`). Triggers spawn a **new** task on a saved rule. They share only the index-and-tick *pattern*, not state or limits. So **"remind me in 5 minutes to do X" keeps working exactly as today** — it's a one-off reminder on the live task, not a recurring trigger, so the 1h floor never touches it. The two schedulers run side by side.

## Other Small Changes

- `src/types/task.ts:204-233` — add `triggered_by?: string` and `pending_trigger_id?: string` to `TaskMetadata`.
- `src/connectors/api/routes.ts:216-253` — add a `type === 'trigger'` branch to `POST /tasks/:id/approve` that calls `task.handleTriggerApproval()`/`handleTriggerDenial()`, so the CLI's `[y]/[n]` enables/denies a proposed trigger exactly like the Slack button.
- `src/cli/components/TaskDetail.tsx:105-120` — widen the rendered `approvalType` union to include `'trigger'`.
- `src/agents/spawn.ts:261-304` — when `metadata.triggered_by` is set, push a context line (next to the existing `reminder` line at ~`:280`) so the PM frames its first message correctly.
- `src/agents/prompts.ts:9-32` — add `triggered: (reason, context) => ...` to `AGENT_PROMPTS`.
- `src/system/event-bus.ts:10-23` — add `trigger:created | trigger:fired | trigger:paused | trigger:deleted` to `EventType`.
- `src/index.ts:240-242` — call `initTriggerScheduler()` right after `initReminderScheduler()` (after recovery, before opening webhooks).
- `src/connectors/slack/client.ts` — extend `getChannelInfo` (`:1029-1050`) to also return `isPrivate`/`isIm` (already on the raw `conversations.info` response) for live privacy resolution in `list_triggers`; reuse `openDMChannel` (`:1431`) and `getUserInfo().tz` (`:889-928`).
- `src/connectors/api/routes.ts` + `src/cli/api.ts` + `src/cli/components/TriggerList.tsx` — `GET /triggers` (+ `PATCH`/`DELETE`) endpoints and a CLI trigger-list view showing each trigger's bound channel, mirroring `TaskList.tsx` (see CLI & API surface).
- PM skill `skills/triggers/SKILL.md` in **archie-hq** (engine-owned, alongside `self-awareness` — triggers are a core engine capability, not a domain plugin) — intake (cadence/channel/DM, what to do), the propose-then-confirm protocol, visibility/announcement rules, delivery format. Plus a short always-present blurb in `prompts/pm-agent.md` so the PM knows triggers exist before loading the skill.
- Docs: add `docs/architecture/triggers.md` and note in `docs/architecture/overview.md` that Archie is no longer purely reactive.
- `package.json` — add `croner` (zero-dependency cron parser with built-in tz/DST). `chrono-node` is already present for one-off parsing.

## Edge Cases

- **Restart** — scheduler rebuilds from trigger files; overdue schedules fire once (catch-up guard).
- **Bound channel deleted / bot removed** — firing fails to post; mark trigger `paused`, best-effort DM the creator.
- **Concurrent fires** — each fire is an independent new task; no reuse.
- **Message both @mentions Archie and matches a channel trigger** — direct task wins; channel trigger skipped (dispatch gating).
- **One-off schedule** — auto-`paused` after firing; re-enable by editing.
- **Creator leaves workspace** — trigger keeps running; anyone in the bound space can pause/delete it.
- **Stale `pending` triggers** (proposed, never approved) — never indexed; GC'd on the boot scan.

## Verification

1. **Typecheck/build:** `npm run typecheck` && `npm run build`.
2. **Unit tests:** add tests for next-run computation (`croner` `.nextRun()` across hourly/daily/weekly cron + a DST boundary in a non-UTC tz), the ≥1h-floor validator (reject `* * * * *`), and `list_triggers` visibility filtering (public-from-public, private-isolation, DM-isolation). Run `npm test`.
3. **End-to-end (local dev, `npm run dev`):**
   - **Schedule:** ask the PM in a DM "every minute, post hi here" (temporarily relax the 1h floor in dev), Approve → confirm a new task spawns each interval and posts to the DM; confirm the bound channel got the **enable** announcement and that firing produces **only** the task's own post (no "I was triggered" line).
   - **One-off:** "in 2 minutes summarize X" → fires once, trigger flips to `paused`.
   - **Reminder coexistence:** in the same session, "remind me in 5 minutes to check the build" → confirm the reminder fires on the *current* task at 5 min and is unaffected by the trigger 1h floor.
   - **Channel-message:** create a trigger watching a test channel for `contains: "bug"`; post a top-level "found a bug" → confirm a task spawns in that thread; post a reply inside an existing Archie thread → confirm it does *not* double-fire.
   - **Confirmation gate:** propose a trigger, click Deny → confirm the pending file is deleted and nothing fires.
   - **Provenance:** from inside a triggered task, ask the PM to create a trigger → confirm `propose_trigger` refuses.
   - **Visibility + privacy change:** from a public channel ask "list triggers" → see public ones only; from a DM → see your DM + public, never another private space. Then convert the bound channel to private and re-list from a DM → confirm that trigger disappears from the listing (live resolution).
   - **CLI:** from a CLI task, ask the PM to set up a trigger → confirm the proposal renders as `[y] approve / [n] deny`, pressing `y` enables it and announces in the bound channel (no Slack needed); then open the CLI trigger-list view → confirm every trigger shows with its bound channel, and pause/delete from the CLI works.
   - **Kill switch:** set `ARCHIE_TRIGGERS_ENABLED=false`, restart → confirm nothing fires and creation is refused.
4. **Restart recovery:** create an enabled schedule trigger, restart the app, confirm it reloads and still fires.
