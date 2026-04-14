# Agent Reminders — Implementation Plan

## Context

Archie is purely reactive. We want agents to set their own reminders — "remind me at X to do Y" — like an employee. No cron, no new task states, no new persistence files. The agent decides when and why.

## Core Idea

Three PM tools + a lightweight in-memory scheduler. No task lifecycle changes. Reminder data lives in task metadata.

- **`parse_datetime(expression)`** — natural language → ISO 8601 (powered by chrono-node)
- **`set_reminder(datetime, reason)`** — set/replace the next reminder. `datetime` is ISO 8601.
- **`cancel_reminder()`** — clear a pending reminder before it fires (e.g., issue resolved early)

The agent says `parse_datetime("next Monday at 9am")` → gets back `2026-04-20T09:00:00+03:00` → passes it to `set_reminder`. No date math by the LLM.

## Metadata

New optional nested field on `TaskMetadata`:

```
reminder?: { trigger_at: string; reason: string }
```

`undefined` when no reminder is pending. Persisted via existing `task.debouncedSave()`.

## Timezone

Slack's `users.info` API returns `tz` (e.g. `"Europe/Moscow"`). Extend `getUserInfo()` in `src/connectors/slack/client.ts` to return `tz`. Resolve the timezone from the Slack user who triggered the task. Store it on task metadata so `parse_datetime` can use it as the reference timezone for chrono-node. "9am" means 9am in that user's local time.

## `parse_datetime` Tool

Uses `chrono-node` to parse natural language date expressions:
- `"in 2 hours"`, `"tomorrow at 10am"`, `"next Monday at 9am"`, `"April 20 at 14:00"`

Returns the ISO 8601 string. Uses current time + task's timezone as chrono reference. The agent calls this before `set_reminder` to get the exact ISO value.

## Scheduler Module

New file: `src/system/reminder-scheduler.ts`

- In-memory `Map<taskId, { trigger_at, reason }>` — the runtime index
- **On startup**: grep metadata files for `"trigger_at"`, build the map
- **5-minute `setInterval`** iterates the map, fires due entries
- **Firing sequence**:
  1. Remove from in-memory map
  2. Clear `metadata.reminder` + flush save (agent must see clean state when it wakes)
  3. Reactivate task: `task.sendMessage(reminderPrompt)` — the prompt includes the reason, so the agent knows why it was woken even though metadata is cleared
  
  If crash between steps 2 and 3 — reminder is lost. This is a very small window and acceptable. The task still exists; a Slack message or user action can wake it.

- **On tool call**: tools update both `task.metadata.reminder` and the in-memory map

## Tools Registration

Three new tools in `createPMAgentMcpServer()`, following existing factory pattern.

`parse_datetime`: resolve natural language → ISO using chrono-node with task's timezone

`set_reminder`: validate ISO is future (max 30 days), update map + metadata, log to knowledge.log, post to Slack

`cancel_reminder`: remove from map, clear metadata field. For when the agent decides a pending reminder is no longer needed before it fires.

## Context Injection

In `spawn.ts` (~line 165), add to PM context:
- **Pending reminder** (if set): `Pending reminder: 2026-04-20T09:00:00+03:00 — Follow up if no reply`

## Other Small Changes

- `src/agents/prompts.ts` — new prompt for reminder wake-ups
- `src/types/task.ts` — add optional `reminder` and `timezone` to `TaskMetadata`
- `src/index.ts` — call `initReminderScheduler()` after recovery
- `src/connectors/slack/client.ts` — extend `getUserInfo()` to return `tz`
- `package.json` — add `chrono-node` dependency

## Edge Cases

- **Task completed/stopped when reminder fires**: `sendMessage()` → `activate()` brings it back
- **Slack message before reminder fires**: task wakes normally, PM sees pending reminder in context, decides what to do
- **Archie restarts**: scheduler rebuilds map from metadata, overdue reminders fire on first tick
- **Agent sets reminder on active task**: fine — fires later, task gets a message
- **chrono-node can't parse expression**: tool returns an error, agent retries with different wording
