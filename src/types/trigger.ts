/**
 * Trigger type definitions
 *
 * A Trigger is a persistent "do Y when X happens" rule that spawns a fresh task
 * when its condition fires. Two condition types ship in v1:
 *   - `schedule` — fires on a recurring cron cadence or once at a future time
 *   - `channel_message` — fires on a new top-level message in a bound channel
 *
 * Triggers are stored one JSON file per trigger under TRIGGERS_DIR (see
 * trigger-store.ts) and indexed in-memory by the trigger scheduler.
 */

export type TriggerStatus = 'pending' | 'enabled' | 'paused';

/**
 * Where a fired trigger delivers its work.
 *  - `channel` — posts a thread in the bound Slack channel
 *  - `user` — delivers by DM to the user
 *
 * Channel privacy (public/private) is deliberately NOT stored here — it is
 * resolved live at list time (see list_triggers), because a channel can be
 * converted public↔private after the trigger was created and a stale cached
 * value would leak a now-private channel's triggers into public contexts.
 */
export type TriggerBinding =
  | { type: 'channel'; channel_id: string; channel_name: string }
  | { type: 'user'; user_id: string };

/**
 * A condition that fires the trigger.
 *  - `schedule` — recurring when `cron` is set (next_run_at recomputed after each
 *    fire), one-off when `cron` is absent (auto-pauses after firing once).
 *  - `channel_message` — a new top-level message in `channel_id` matching the
 *    optional `match` filter.
 */
export type TriggerCondition =
  | { type: 'schedule'; tz: string; next_run_at: string; cron?: string }
  | { type: 'channel_message'; channel_id: string; match?: { contains?: string; from_user?: string } };

export interface Trigger {
  /** "trg-YYYYMMDD-HHMM-random6" */
  id: string;
  /** pending = proposed, awaiting approval; enabled = live; paused = inactive */
  status: TriggerStatus;
  /** Slack user ID who requested it */
  created_by: string;
  created_at: string;
  /**
   * Last time a still-`pending` proposal was edited. The boot-scan GC measures
   * the pending TTL from this when set (see `rebuildFromDisk`), so revising a
   * proposal renews its lifetime instead of leaving it to be reaped on the
   * original clock mid-conversation.
   */
  updated_at?: string;
  /**
   * Task that proposed this trigger. While `pending`, management is scoped to
   * this task: a proposal is an in-flight part of one conversation, not shared
   * state. Without it, `triggerVisibleFrom` alone both over- and under-permits —
   * a DM-created proposal bound to a private channel becomes invisible to the very
   * DM that made it, while a public-bound one is editable (and approvable) from
   * any other conversation. Absent on triggers proposed before this field existed;
   * those fall back to binding visibility.
   */
  proposed_in_task?: string;
  /** Slack user ID who approved it (set when status flips pending → enabled) */
  approved_by?: string;
  binding: TriggerBinding;
  /** N conditions — any match fires the trigger */
  conditions: TriggerCondition[];
  /** PM instruction seeded into the spawned task when fired (internal — not shown to users). */
  action: { prompt: string };
  /**
   * Short, user-facing one-liner describing what the trigger does (e.g. "Daily
   * summary of #bot-test"). Shown in approval prompts, announcements, and
   * listings instead of the verbose internal `action.prompt`. Set by the PM at
   * creation; falls back to a shortened `action.prompt` when absent.
   */
  summary?: string;
  last_fired_at?: string;
}
