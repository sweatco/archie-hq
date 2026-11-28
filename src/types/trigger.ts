/**
 * Trigger type definitions
 *
 * A Trigger is a persistent "do Y when X happens" rule that spawns a fresh task
 * when its condition fires. Three condition types exist:
 *   - `schedule` — fires on a recurring cron cadence or once at a future time
 *   - `channel_message` — fires on a new top-level message in a bound channel
 *   - `incoming_event` — fires on an event received by an input
 *
 * Triggers are stored one JSON file per trigger under TRIGGERS_DIR (see
 * trigger-store.ts) and indexed in-memory by the trigger scheduler.
 */

import type { InputAuth, PointerCheck } from '../incoming/types.js';

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
 *
 * A `user` binding's `channel_id`/`channel_name` are the DM it was set up in, taken from that conversation and never from the model.
 */
export type TriggerBinding =
  | { type: 'channel'; channel_id: string; channel_name: string }
  | { type: 'user'; user_id: string; channel_id: string; channel_name: string };

/**
 * A condition that fires the trigger.
 *  - `schedule` — recurring when `cron` is set (next_run_at recomputed after each
 *    fire), one-off when `cron` is absent (auto-pauses after firing once).
 *  - `channel_message` — a new top-level message in `channel_id` matching the
 *    optional `match` filter.
 *  - `incoming_event` — an event received by input `input_id` that passes every
 *    check in `filter`. A trigger holds event conditions alone, never beside the other
 *    two types, and receives events only while it is linked to the input.
 *  - `new_input_event` — on a proposal only: an event condition whose input does not
 *    exist yet. Approval creates the input and turns this into `incoming_event`.
 */
export type TriggerCondition =
  | { type: 'schedule'; tz: string; next_run_at: string; cron?: string }
  | {
      type: 'channel_message';
      channel_id: string;
      match?: { contains?: string; from_user?: string };
    }
  | { type: 'incoming_event'; input_id: string; filter?: PointerCheck[] }
  | {
      type: 'new_input_event';
      purpose: string;
      auth: InputAuth;
      filter?: PointerCheck[];
    };

export interface Trigger {
  /** "trg-YYYYMMDD-HHMM-random6" */
  id: string;
  /** pending = proposed, awaiting approval; enabled = live; paused = inactive */
  status: TriggerStatus;
  /** Slack user ID who requested it */
  created_by: string;
  created_at: string;
  /** Last edit while pending; the boot-scan GC measures the pending TTL from it. */
  updated_at?: string;
  /** Task that proposed it; scopes management while pending. Absent on older proposals. */
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
  /** Where the newest review card of an event routine's proposal was posted, so an edit can retire it. Cleared at approval. */
  review_card?: SlackMessageRef;
}

/** One Slack message: the conversation it is in and its timestamp. */
export interface SlackMessageRef {
  channel_id: string;
  ts: string;
}
