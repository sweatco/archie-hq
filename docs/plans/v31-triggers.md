# Triggers — Implementation Plan

## Context

Archie is purely reactive: it acts only on an inbound Slack message or a GitHub webhook. The one piece of proactivity, the reminder scheduler (`src/system/reminder-scheduler.ts`), can only re-wake an *existing* task — it cannot start work on its own.

**Triggers** let a user say, in plain language, "do Y when X happens" and have Archie set up a persistent rule that spawns a fresh task when the condition fires. This is Archie's take on [Claude Code Routines](https://code.claude.com/docs/en/routines), bent to fit Archie's Slack-native, human-in-the-loop model.

Two trigger types ship in v1:
- **Schedule trigger** — fires on a cron cadence (recurring) or once at a future time. Connected to a **user** (delivers by DM) or a **channel** (posts a thread).
- **Channel-message trigger** — fires on a new **top-level** message in a bound channel that matches an optional filter. Connected to a **channel**.

GitHub-event triggers are a deliberate follow-up (the webhook plumbing in `src/connectors/github/` already exists).

The design bias is *reuse what's there*: the reminder scheduler's index-and-tick pattern, the Slack event handler, the edit-mode Approve/Deny button flow, and `postToUser`/`postInteractiveToUser`. The genuinely new surface is small.

## Core Idea

A trigger is a **first-class persisted object**, not task state. (A reminder lives inside a task's metadata because it belongs to one task; a schedule trigger outlives any task and spawns many, so it must be stored independently.)

- One JSON file per trigger under `${ARCHIE_WORKDIR}/triggers/`, with an in-memory index rebuilt at boot — same shape as `reminder-scheduler.ts`.
- A trigger = **N conditions + 1 action**. Any matching condition fires the action ("mixing" — e.g. nightly *and* on-demand share one rule).
- Creation is **propose-then-confirm**: the PM drafts the exact rule and posts Approve/Deny buttons; the trigger only goes live on Approve.
- A fired trigger spawns a **normal read-only task** bound to a communication channel. If that task needs to change code, it requests edit mode in-channel via the existing flow — no unattended writes.

## Data Model

New file `src/types/trigger.ts`:

```ts
interface Trigger {
  id: string;                    // "trg-YYYYMMDD-HHMM-random6"
  status: 'pending' | 'enabled' | 'paused';  // pending = proposed, not yet approved
  created_by: string;            // Slack user ID who requested it
  created_at: string;
  binding: TriggerBinding;
  conditions: TriggerCondition[];
  action: { prompt: string };    // the PM instruction to seed when fired
  last_fired_at?: string;
}

type TriggerBinding =
  | { type: 'channel'; channel_id: string; channel_name: string; privacy: 'public' | 'private' }
  | { type: 'user'; user_id: string };   // delivers via DM

type TriggerCondition =
  | { type: 'schedule'; cron: string; tz: string; next_run_at: string; one_off?: boolean }
  | { type: 'channel_message'; channel_id: string; match?: { contains?: string; from_user?: string } };
```

`privacy` is captured at creation time (via `conversations.info` → `is_private`) so visibility filtering never needs a live Slack lookup. `next_run_at` is the precomputed next fire time for a schedule condition (see Scheduler).

Storage helpers in a new `src/system/trigger-store.ts`: `saveTrigger`, `loadTrigger`, `listTriggers`, `deleteTrigger`, `triggersDir()` → `${ARCHIE_WORKDIR}/triggers/`. (Mirror `src/tasks/persistence.ts`.)

## Scheduler Module

New file `src/system/trigger-scheduler.ts` — a near-copy of `reminder-scheduler.ts`:

- In-memory index of enabled schedule conditions, keyed by trigger id.
- **On startup** (`initTriggerScheduler()`, called from `src/index.ts` after recovery): scan `${ARCHIE_WORKDIR}/triggers/*.json`, index `enabled` triggers with schedule conditions.
- **60-second `setInterval`** iterates the index; fires any condition whose `next_run_at <= now`.
- **Firing**: call `fireTrigger(trigger, { kind: 'schedule' })`, then recompute `next_run_at` from the cron (recurring) or set `status: 'paused'` and clear it (one-off — matches Claude's auto-disable). Persist.
- **Downtime catch-up**: on the first tick after boot, a schedule condition more than its own interval overdue fires **once** (not once per missed window), so a weekend offline doesn't dump a backlog.

Cron is computed with **`cron-parser`** (new dependency) using the stored `tz`. Natural-language intake ("every weekday at 9am") is translated to cron by the PM at creation via the existing `parse_datetime`/chrono-node tooling plus a small `parse_cron` helper; users never hand-write cron. Minimum interval is **1 hour** — shorter expressions are rejected at creation.

## Channel-Message Dispatch

One hook added to `handleSlackEvent` in `src/connectors/slack/events.ts` (after the existing `findTaskByThread` routing, ~line 376–498), reusing the self-message and external-user filters already there:

- Only **top-level** messages (`thread_ts` absent or equal to `ts`) are considered. Replies inside an existing Archie thread already route to their task and reactivate it — never a trigger concern.
- Skip if the message is an `app_mention` or DM (those create/route a direct task) — a channel trigger is for ambient channel activity, not messages aimed at Archie. Prevents double-firing.
- Consult the in-memory trigger index for `channel_message` triggers bound to `event.channel`; for each whose `match` passes, call `fireTrigger(trigger, { kind: 'message', text, ts })`.

## Firing → Task + Communication Channel

`fireTrigger(trigger, context)` in `trigger-scheduler.ts` (shared by both dispatch paths) reuses existing task plumbing end to end:

1. `Task.create()`.
2. **Establish the comms channel** from the binding:
   - `binding.type === 'user'` → open/reuse a DM (`conversations.open` → `D…`), link it as `default_channel`.
   - `binding.type === 'channel'`, message context → link the triggering message's thread.
   - `binding.type === 'channel'`, schedule context → post a fresh thread in the channel; that becomes `default_channel`.
3. Set `triggered_by: trigger.id` on `TaskMetadata` — marks the task trigger-originated, which gates the no-self-trigger rule and lets the PM explain why it woke up.
4. Seed the PM: `task.sendMessage(seed, 'pm-agent')` where `seed` = `action.prompt` + the triggering context (matched message text, or "scheduled run at <time>") + "deliver results to this channel." New prompt builder in `src/agents/prompts.ts` (`AGENT_PROMPTS.triggered(...)`).
5. Emit `trigger:fired` and update `last_fired_at`.

Everything downstream — agent spawning, delegation, edit-mode requests, `postToUser` — is unchanged.

## PM Tools

New tools in `createOrchestrationMcpServer()` (`src/agents/tools.ts`), following the existing factory pattern. All PM-only.

- **`propose_trigger(binding, conditions, action_prompt)`** — validates (interval ≥ 1h, caps not exceeded, `task.metadata.triggered_by` unset → triggered tasks cannot create triggers), writes a `status: 'pending'` trigger file, and posts **Approve / Deny buttons** to the user via `task.postInteractiveToUser(...)` with `action_id`s `approve_trigger` / `deny_trigger` and `value: trigger.id`. Mirrors `request_edit_mode` (`src/agents/tools.ts:463-531`). Unlike edit mode it does **not** pause the task — the conversation continues; approval is async.
- **`list_triggers(scope?)`** — `scope` defaults to the current channel/DM. Returns triggers visible from the current context (see Visibility). Supports listing for a specific channel and a broader "all public" listing.
- **`update_trigger(id, { status?, action_prompt?, conditions? })`** — pause/resume/edit. Re-validates and re-indexes.
- **`delete_trigger(id)`**.

`update_trigger`/`delete_trigger` first check the trigger is **visible** from the current context (the privacy rule below); anything visible is manageable (no owner-lock).

## Confirmation Flow

Reuses the edit-mode button mechanism exactly:

1. `propose_trigger` writes the `pending` trigger and posts Approve/Deny buttons.
2. New handlers in `src/connectors/slack/events.ts` next to `approve_edit_mode` (line 201) / `deny_edit_mode` (line 228):
   - **`approve_trigger`** → set `status: 'enabled'`, index it in the scheduler (compute `next_run_at` for schedule conditions), **announce in the bound channel** ("✅ Trigger enabled: …"), emit `trigger:created`.
   - **`deny_trigger`** → delete the pending file.
3. `postInteractiveToUser`'s `approvalType` union (`src/tasks/task.ts:472`) gains `'trigger'`.

The pending-file-then-flip approach means the proposed spec is carried in the trigger file (button `value` is just the id), so nothing large rides in the button payload.

## Visibility & Privacy

Visibility is scoped by the **tier of the space the request comes from** (the task's originating channel/DM). Because you can only ask from a space you're already in, membership is enforced implicitly — there's no cross-space lookup to abuse.

- **From a public channel:** see all **public-channel** triggers (`binding.privacy === 'public'`). Default `list_triggers` scope is *this channel*; a broader "all public" listing is allowed (public triggers are non-sensitive). Never any DM or private-channel trigger.
- **From a private channel:** see **this** private channel's triggers + all public-channel triggers. Never *other* private channels or DMs.
- **From a DM:** see **your own** DM triggers + all public-channel triggers. Never private channels or other DMs.
- **Hard invariant:** a private space's triggers (a private channel, any DM) are never visible from outside that exact space.

`list_triggers` enforces this by filtering trigger files against the originating context's tier/id — no Slack call needed (tier is stored on the binding).

## Announcements (no silent changes)

Every lifecycle change posts a short notice **to the channel where the trigger is bound** (via `postToUser` targeting the binding), even when the change was made from a DM:

- created/enabled, edited, paused/resumed, deleted, and **fired** (a one-line "triggered by …" when the spawned task first posts).

This is the transparency guarantee: you can manage a channel's trigger from afar, but the channel always sees that it happened.

## Protections & Limits

- **Propose-then-confirm** — no agent enables a trigger from a model decision alone.
- **Provenance gate** — `propose_trigger` refuses when `task.metadata.triggered_by` is set (triggered tasks can't create triggers → no amplification loops) and relies on the existing external/guest bail-out in `events.ts` so outside users can't create triggers or fire channel triggers.
- **Read-only by default** — a fired task is a normal task; writes/pushes still require in-the-moment edit-mode approval in-channel.
- **Limits** — interval ≥ 1h; per-user and per-channel active-trigger caps; per-account daily fired-run cap (in-memory counter, reset daily). Over a cap → reject creation / drop the fire and notify.
- **Kill switch** — `ARCHIE_TRIGGERS_ENABLED` env flag disables all firing and creation globally (mirrors Claude's org-level Routines toggle).

## Context Injection

In `src/agents/spawn.ts` (PM context assembly, ~line 165): when `task.metadata.triggered_by` is set, add a line noting the task was started by a trigger and why, so the PM frames its first message correctly.

## Other Small Changes

- `src/types/task.ts` — add optional `triggered_by?: string` to `TaskMetadata`.
- `src/system/event-bus.ts` — add `trigger:created` / `trigger:fired` / `trigger:paused` / `trigger:deleted` event types.
- `src/index.ts` — call `initTriggerScheduler()` after recovery (next to `initReminderScheduler()`).
- `src/connectors/slack/client.ts` — ensure a DM-open helper (`conversations.open`) and `conversations.info` (for `is_private`) are available; reuse the `tz` lookup added for reminders.
- `src/agents/prompts.ts` — `AGENT_PROMPTS.triggered(...)` seed prompt.
- `package.json` — add `cron-parser`.
- A PM skill `pm/skills/triggers/SKILL.md` in **archie-plugins** — intake (cadence/channel/DM, what to do, which repos), the propose-then-confirm protocol, the visibility/announcement rules, and delivery format. Teaches judgement, not tool mechanics, per the plugins CLAUDE.md.
- Docs: `docs/architecture/triggers.md` and a note in `docs/architecture/overview.md` that Archie is no longer purely reactive.

## Edge Cases

- **Archie restarts** — scheduler rebuilds the index from trigger files; overdue schedules fire once (catch-up guard).
- **Bound channel deleted / bot removed** — firing fails to post; mark the trigger `paused` and (best-effort) DM the creator.
- **Trigger fires while a prior fired task is still running** — each fire is an independent new task; no reuse (matches Claude's GitHub-event semantics).
- **Message both @mentions Archie and matches a channel trigger** — the direct task wins; the channel trigger is skipped (dispatch order above).
- **One-off schedule** — auto-`paused` after firing; re-enable by editing.
- **Creator leaves the workspace** — trigger keeps running (it's not owner-locked for execution); anyone in the bound space can pause/delete it.
- **Pending (unconfirmed) trigger never approved** — harmless; it's never indexed. A periodic sweep (or the boot scan) can garbage-collect stale `pending` files.
