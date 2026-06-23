# Proposal: Triggers

> **Status:** Not implemented — design only

## Summary

A **trigger** is a saved, persisted rule that fires a new Archie task when a condition is met: a clock reaches a time (schedule), or a message lands in a channel (channel message). The user asks for it in plain language ("every weekday at 9am post a PR digest here", "when someone posts in #support, triage it"), the PM proposes the exact rule, and **the trigger only becomes active after the user explicitly confirms it**. When it fires, it spawns a fresh task bound to a communication channel (a DM or a channel thread) and seeds the PM with the stored instruction plus the triggering context.

This is Archie's take on [Claude Code Routines](https://code.claude.com/docs/en/routines) — adapted to Archie's Slack-native, PM-orchestrated, human-in-the-loop model. The deliberate design bias is **dumb and simple**: reuse the patterns that already exist (the reminder scheduler, the approval flow, the Slack event handler, `post_to_user`) rather than build new infrastructure.

## Motivation

Archie is currently **reactive**: it only acts when a human messages it (Slack) or a webhook arrives (GitHub). Every useful unattended workflow — morning digests, recurring audits, "watch this channel and triage" — is impossible today. The one exception, the reminder scheduler (`src/system/reminder-scheduler.ts`), can only re-wake an *existing* task; it cannot start work on its own.

Triggers close that gap with a small, well-guarded amount of proactivity:

- **Schedules** — recurring or one-off work tied to a person ("remind me", "every Monday summarize…").
- **Channel watching** — react to activity in a channel ("when a bug is posted in #qa-reports, triage it").
- **Composable workflows** — one rule can carry several conditions (nightly *and* on-demand), the same way a Claude routine combines schedule + API + GitHub triggers.

The hard part is not the firing mechanism — Archie already has a working scheduler and a working Slack event pipeline. The hard part is **trust**: a thing that can spin up agents on its own must never be something an agent can set up by itself, must respect channel/DM privacy, and must never quietly act beyond reading and reporting. That is where most of this proposal's weight sits.

## What we learned from Claude Code Routines

| Claude Routines | What we borrow | What we change for Archie |
| --- | --- | --- |
| Routine = saved prompt + repos + connectors + triggers | A trigger stores a prompt (the **action**) and one or more **conditions** | Triggers are Slack-first, not repo-first; the action is a PM instruction, not a raw Claude session |
| Trigger types: Schedule, API, GitHub | Start with **Schedule** + **Channel message**; GitHub is a natural later addition | No public API/webhook endpoint — Archie has no per-user auth surface for that. The "API trigger" equivalent is simply a Slack message |
| One routine can combine triggers | Keep this: one trigger = N conditions, 1 action | — |
| `/schedule` creates conversationally | Keep this: the PM creates triggers conversationally via a PM skill | The PM **proposes**, the user **confirms** — creation is never silent |
| Routines run autonomously, **no approval prompts mid-run** | — | **Reversed.** A triggered task is read-only and must ask for edit mode in-channel like any other task. Unattended ≠ unsupervised |
| Routines belong to your account; actions appear "as you" | Triggers are **owned** by their Slack creator; only the owner / channel members can see or manage them | — |
| Min interval 1 hour; per-account daily run cap | Keep both as cheap loop-protection | — |
| One-off schedule auto-disables after firing | Keep | — |

The single most important divergence: **Claude routines are explicitly "no approval prompts during a run."** Archie's whole safety model is human-in-the-loop, so triggered tasks keep the read-only-by-default posture. A trigger can wake Archie up and let it *look and report*; it cannot let Archie *change things* without a human saying yes in the moment.

## Design

### The core object

A trigger is a first-class persisted object — **not** task state. (Reminders live inside a task's metadata because a reminder belongs to one task. A schedule trigger outlives any task and spawns many, so it must be stored independently.)

Store one JSON file per trigger under the workdir, with an in-memory index rebuilt at boot — exactly mirroring `reminder-scheduler.ts`:

```
${ARCHIE_WORKDIR}/triggers/<trigger-id>.json
```

```jsonc
{
  "id": "trg-20260623-1430-a3f9k2",
  "enabled": true,
  "created_by": "U_SLACK_USERID",      // owner — the human who confirmed it
  "created_at": "2026-06-23T14:30:00Z",

  // What this trigger is attached to — drives where results are delivered
  // and who is allowed to see/manage it.
  "binding": {
    "type": "channel",                 // "channel" | "user"
    "channel_id": "C_SUPPORT",
    "channel_name": "#support"
  },

  // One or more conditions. ANY matching condition fires the action.
  "conditions": [
    { "type": "schedule", "cron": "0 9 * * 1-5", "tz": "Europe/London" },
    { "type": "channel_message", "channel_id": "C_SUPPORT",
      "match": { "contains": "bug", "from_external": false } }
  ],

  // What to do when fired.
  "action": {
    "prompt": "Read the new messages, triage as a bug report, and post a summary here.",
    "deliver_to": "binding"            // post results to the bound channel/DM
  },

  "last_fired_at": "2026-06-23T09:00:12Z"
}
```

### Trigger types (v1)

Two types, each "connected to something" as the request framed it:

1. **Schedule trigger — connected to a user (or a channel).**
   Fires at a cron time. Recurring (`hourly`/`daily`/`weekdays`/`weekly` presets, or a raw cron expression) or one-off. Bound to a **user** → delivers by DM. Bound to a **channel** → posts to a thread in that channel. Reuses the reminder scheduler's index-and-tick pattern wholesale.

2. **Channel-message trigger — connected to a channel.**
   Fires when a new top-level message in the bound channel matches an optional filter (`contains` / `from` / `not from external`). Hooks into the existing Slack event handler (`src/connectors/slack/events.ts`) right after the current task-routing step.

> **GitHub-event trigger** (release/PR events) is a clean future addition — Archie already ingests GitHub webhooks (`src/connectors/github/`) — but is out of scope for v1 to keep the surface small.

### Mixing triggers

"Mixing" = one trigger object carries **multiple conditions** sharing **one action** (the Claude-routine model). Example: a `#releases` digest that runs nightly *and* whenever someone posts "ship it" in the channel. This is free — the dispatcher just checks each condition independently against the same record.

We deliberately **do not** build trigger-chaining infrastructure (trigger A's output feeds trigger B). Chaining emerges naturally — a task could create another trigger — but that path is closed in v1 by the protection rules below (triggered tasks cannot create triggers). This kills runaway amplification with one dumb rule instead of a dependency graph.

### How a trigger fires

`fireTrigger(trigger, context)` reuses existing task plumbing end to end:

1. **`Task.create()`** — a fresh task, same as a Slack message would create.
2. **Establish the communication channel** from the binding:
   - `binding.type === "user"` → open (or reuse) a DM with that user and link it as `default_channel`. This is the "establish one" case — there's no inbound thread, so Archie proactively opens the DM. `post_to_user` already supports a `new_dm` target.
   - `binding.type === "channel"` → for a channel-message trigger, link the triggering message's thread; for a schedule trigger, open a new thread in the channel. Either way it becomes `default_channel`.
3. **Flag provenance** in task metadata: `triggered_by: <trigger-id>`. This marks the task as trigger-originated, which (a) lets the PM explain why it woke up, and (b) enforces the read-only / no-self-trigger rules.
4. **Seed the PM** via `task.sendMessage(seed, 'pm-agent')` where `seed` = the stored action prompt + the triggering context (the matched message text, or "scheduled run at <time>") + "deliver results to the bound channel."

Everything downstream — agent spawning, delegation, `post_to_user` — is unchanged.

### Firing mechanism

- **Schedule conditions** → a new `trigger-scheduler.ts` that is a near-copy of `reminder-scheduler.ts`: scan `${ARCHIE_WORKDIR}/triggers/*.json` at boot, index enabled schedule conditions, tick every 60s, fire due ones, compute next run (one-off conditions disable themselves after firing, matching Claude's behavior). Overdue conditions from downtime fire once on boot — and a "missed by more than N hours" guard skips stale catch-ups so a weekend of downtime doesn't dump a backlog.
- **Channel-message conditions** → one check added to `handleSlackEvent`. After the existing thread→task routing, consult the in-memory trigger index for channel-message triggers bound to this channel; if a new top-level message matches the filter and is not from the bot or an external user, fire. (External-user and self-message filtering already exist in `events.ts` and are reused, not reinvented.)

### Core Rules

- **A trigger is proposed by the PM and activated only by explicit user confirmation.** The PM never writes an enabled trigger from a model decision alone.
- **A trigger is owned by the Slack user who confirmed it.** Ownership drives visibility and management rights.
- **A triggered task is read-only by default**, exactly like any other task. To change code or push, it must request edit mode in its channel and get a human yes — the same approval flow that exists today. No unattended writes.
- **Triggered tasks cannot create, edit, or delete triggers.** Only a task started by a direct human message can. This is the loop-breaker.
- **A trigger sees only its bound scope.** A channel trigger reads only its channel; a user trigger delivers only to that user's DM. No cross-channel visibility.
- **Limits:** minimum schedule interval 1 hour; a per-user and per-channel cap on active triggers; a per-account daily fired-run cap (mirrors Claude). Over the cap → drop and notify the owner, don't queue indefinitely.

### Workflows

**Create.** User: "Archie, every weekday at 9am post a summary of new PRs in this channel." → PM loads the `triggers` PM skill, fills in the gaps (which repos? this channel or your DM?), then **proposes the exact rule back and asks for confirmation** ("I'll set up: *weekdays 09:00 Europe/London → post a new-PR digest to #eng*. Confirm?"). On a yes (reply or ✅ reaction, reusing the existing approval mechanism), the PM writes the enabled trigger. On anything else, nothing is saved.

**Fire → work → deliver.** At 09:00 the scheduler creates a task, opens/links #eng, seeds the PM with the stored prompt + "scheduled run." The PM delegates as normal and posts the digest to #eng. Read-only throughout; if the work needed an edit it would ask first.

**List.**
- In a **DM**: "list my triggers" → triggers where `created_by == you` (including channel-bound ones you created and your DM schedules).
- In a **channel**: "what's set up here?" → triggers bound to this channel, visible to channel members.
- DM-bound triggers are **never** listed into a channel (privacy).

**Manage.** "Pause the 9am digest" / "delete it" → PM resolves the trigger and toggles `enabled` / deletes the file — **only if** the requester is the owner or (for channel triggers) a member of the bound channel.

### Permission Model

- **Creation gate:** the create-trigger tool is PM-only and refuses unless the request traces to a real inbound message from an internal user in the current task, *and* the user has confirmed the proposed rule. A PR body or external message saying "set up a trigger" can't satisfy either condition — this is the prompt-injection defense (consistent with `docs/architecture/security.md` and the v9 injection-defense work).
- **Ownership & visibility:** `created_by` gates list/update/delete. Channel-bound triggers are visible to channel members; user-bound triggers only to the owner in DM.
- **Action scope:** a triggered task can read, research, and report. It **cannot** push code, merge, or take outward actions without the standard in-the-moment human approval. A trigger never silently merges a PR.
- **External users:** cannot create triggers; their messages don't fire channel triggers (reuses the existing external/guest bail-out in `events.ts`).
- **Kill switch:** an env flag to disable all triggers globally (mirrors Claude's org-level Routines toggle), plus per-trigger `enabled`.

### Privacy notes

- A channel-message trigger is effectively "Archie is watching this channel." That should be **visible to the channel**: announce it when created and surface it in the channel's trigger list, so members aren't silently observed.
- Schedule triggers bound to a user are private to that user and deliver only by DM.
- Trigger files contain Slack IDs and a prompt — no message content is persisted in the trigger itself; the triggering message is read at fire time and lives only in the spawned task's normal storage.

## Implementation Notes

The firing and delivery infrastructure largely **already exists**; the new surface is small:

1. **Trigger registry + scheduler** — `src/system/trigger-scheduler.ts`, a near-copy of `reminder-scheduler.ts` (`src/system/reminder-scheduler.ts:33-149`): boot-time `rebuildFromDisk`, 60s tick, `fireTrigger`. Storage under `${ARCHIE_WORKDIR}/triggers/` (add a path helper alongside `src/tasks/persistence.ts`).
2. **Channel-message hook** — one matching step in `handleSlackEvent` (`src/connectors/slack/events.ts:376-498`), after the existing `findTaskByThread` routing, reusing the self-message and external-user filters already there.
3. **`fireTrigger`** — `Task.create()` + channel binding via the existing `post_to_user` DM/thread targets (`src/tasks/task.ts:327-390`) + `task.sendMessage(seed, 'pm-agent')`. Add `triggered_by` to `TaskMetadata` (`src/types/task.ts:204-233`).
4. **PM tools** — `create_trigger`, `list_triggers`, `update_trigger`, `delete_trigger` in `src/agents/tools.ts`, all PM-only, with the provenance/ownership checks above. Reuse the approval-event pattern (`approval:requested` / `approval:resolved`) for the confirmation step.
5. **PM skill** — `pm/skills/triggers/SKILL.md` in `archie-plugins`: intake (what cadence/channel/DM, what to do, which repos), the **propose-then-confirm** protocol, the listing/management rules, and the delivery format. Teaches judgement, not tool mechanics, per the plugins CLAUDE.md.
6. **Event types** — add `trigger:created` / `trigger:fired` / `trigger:deleted` to `src/system/event-bus.ts` for observability and the CLI stream.
7. **Docs** — on implementation, add an architecture doc (`docs/architecture/triggers.md`) and a plan entry, and note the proactivity change in `docs/architecture/overview.md` (Archie is no longer purely reactive).

**Open questions for review:**

- **Schedule binding default** — when a user says "remind me" in a channel, does the trigger bind to them (DM delivery) or to the channel? Proposed default: a personal-sounding request in a channel binds to the **user/DM**; "post here every…" binds to the **channel**. The PM disambiguates during intake.
- **Channel-message firing vs. existing tasks** — should a channel trigger fire on a message that's already a reply inside an Archie-owned thread? Proposed: **no** — fire only on new top-level channel messages, to avoid double-handling.
- **Cron vs. presets** — expose raw cron to users, or only presets + natural language ("every weekday 9am") that the PM translates? Proposed: natural-language intake, store cron; presets cover the common cases, raw cron is an power-user escape hatch.
- **Catch-up policy** — exact "too stale to fire" window after downtime (proposed: skip schedule fires missed by more than the interval, or a flat few hours).
