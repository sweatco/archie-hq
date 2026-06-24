/**
 * Trigger Scheduler
 *
 * In-memory index of enabled triggers, backed by the trigger store on disk.
 * A 60s interval checks schedule conditions and fires due ones. Channel-message
 * triggers are fired by the Slack dispatch hook (see connectors/slack/events.ts),
 * which queries this module's index by channel.
 *
 * Mirrors reminder-scheduler.ts's index-and-tick pattern. The only genuinely new
 * piece is recurrence math, offloaded to `croner` (DST-correct, zero deps).
 */

import { Cron } from 'croner';
import { Task } from '../tasks/task.js';
import type { Trigger, TriggerBinding } from '../types/trigger.js';
import { listTriggers, saveTrigger, setTriggerStatus } from './trigger-store.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';
import { emitEvent } from './event-bus.js';
import { logger } from './logger.js';
import { openDMChannel, postSlackMessage } from '../connectors/slack/client.js';

// ---- Limits / config ----

/** Recurring schedule triggers must fire no more often than once per hour. */
export const MIN_RECURRING_INTERVAL_MS = 60 * 60_000;
/** Per-account cap on fired runs per calendar day (runaway-loop backstop). */
const DAILY_FIRE_CAP = 200;
/** Caps on concurrently-enabled triggers. */
export const MAX_TRIGGERS_PER_USER = 20;
export const MAX_TRIGGERS_PER_CHANNEL = 20;

/** Global kill switch — set ARCHIE_TRIGGERS_ENABLED=false (or 0) to disable. */
export function triggersEnabled(): boolean {
  const v = process.env.ARCHIE_TRIGGERS_ENABLED;
  return v !== 'false' && v !== '0';
}

// ---- In-memory index (enabled triggers only) ----

const enabledTriggers = new Map<string, Trigger>();
let schedulerTimer: ReturnType<typeof setInterval> | undefined;

// ---- Daily fire cap (reset on date change) ----

let fireDay = '';
let fireCount = 0;
function withinDailyCap(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== fireDay) {
    fireDay = today;
    fireCount = 0;
  }
  if (fireCount >= DAILY_FIRE_CAP) return false;
  fireCount++;
  return true;
}

// ---- Cron helpers (exported for tools + tests) ----

/** Next fire instant for a cron expression in a timezone, after `from` (default now). */
export function computeNextRun(cron: string, tz: string, from?: Date): Date | null {
  try {
    return new Cron(cron, { timezone: tz }).nextRun(from ?? new Date());
  } catch (err) {
    logger.warn('trigger-scheduler', `Invalid cron "${cron}" (${tz}): ${err}`);
    return null;
  }
}

/**
 * Validate that a recurring cron fires no more often than once per hour.
 * Returns `{ ok }` or `{ ok: false, error }`. Checks the gap between the next
 * two occurrences — the tightest cadence the expression produces.
 */
export function validateRecurringInterval(cron: string, tz: string): { ok: true } | { ok: false; error: string } {
  let runs: Date[];
  try {
    runs = new Cron(cron, { timezone: tz }).nextRuns(2);
  } catch (err) {
    return { ok: false, error: `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (runs.length < 2) {
    return { ok: false, error: 'Cron expression does not produce a recurring schedule.' };
  }
  const gap = runs[1].getTime() - runs[0].getTime();
  if (gap < MIN_RECURRING_INTERVAL_MS) {
    return { ok: false, error: 'Recurring triggers must fire at most once per hour.' };
  }
  return { ok: true };
}

// ---- Public API ----

/**
 * Initialize the trigger scheduler. Rebuilds the in-memory index from disk,
 * then starts a 60s tick (plus an immediate check to fire overdue schedules
 * after downtime). No-op firing if the kill switch is off, but the index is
 * still built so list/management endpoints stay consistent.
 */
export async function initTriggerScheduler(): Promise<void> {
  await rebuildFromDisk();
  const count = enabledTriggers.size;
  if (count > 0) {
    logger.system(`Trigger scheduler: loaded ${count} enabled trigger(s)`);
  }
  if (!triggersEnabled()) {
    logger.system('Trigger scheduler: firing disabled (ARCHIE_TRIGGERS_ENABLED=false)');
    return;
  }
  schedulerTimer = setInterval(() => {
    checkDue().catch((err) => logger.error('trigger-scheduler', 'Error checking due triggers', err));
  }, 60_000);
  checkDue().catch((err) => logger.error('trigger-scheduler', 'Error on initial trigger check', err));
}

/** Rebuild the in-memory index from disk (enabled triggers only). */
async function rebuildFromDisk(): Promise<void> {
  enabledTriggers.clear();
  try {
    for (const trigger of await listTriggers()) {
      if (trigger.status === 'enabled') indexTrigger(trigger);
    }
  } catch (err) {
    logger.error('trigger-scheduler', 'Failed to rebuild triggers from disk', err);
  }
}

/**
 * Add (or refresh) an enabled trigger in the index. For recurring schedule
 * conditions whose `next_run_at` is missing or already past (e.g. created then
 * approved later), advance it to the next future occurrence.
 */
export function indexTrigger(trigger: Trigger): void {
  if (trigger.status !== 'enabled') {
    enabledTriggers.delete(trigger.id);
    return;
  }
  const now = Date.now();
  for (const cond of trigger.conditions) {
    if (cond.type !== 'schedule' || !cond.cron) continue;
    const due = cond.next_run_at ? new Date(cond.next_run_at).getTime() : 0;
    if (!cond.next_run_at || due <= now) {
      const next = computeNextRun(cond.cron, cond.tz);
      if (next) cond.next_run_at = next.toISOString();
    }
  }
  enabledTriggers.set(trigger.id, trigger);
}

/** Remove a trigger from the index. */
export function deindexTrigger(id: string): void {
  enabledTriggers.delete(id);
}

/** All enabled channel-message triggers bound to / watching a given channel. */
export function getChannelMessageTriggers(channelId: string): Trigger[] {
  const out: Trigger[] = [];
  for (const trigger of enabledTriggers.values()) {
    if (trigger.conditions.some((c) => c.type === 'channel_message' && c.channel_id === channelId)) {
      out.push(trigger);
    }
  }
  return out;
}

// ---- Schedule firing ----

interface FireContext {
  kind: 'schedule' | 'message';
  /** For message context: the triggering message text. */
  text?: string;
  /** For message context: the thread to reply in + its channel. */
  channelId?: string;
  channelName?: string;
  threadId?: string;
}

/** Check for due schedule conditions and fire them. */
async function checkDue(): Promise<void> {
  if (!triggersEnabled()) return;
  const now = Date.now();

  for (const trigger of [...enabledTriggers.values()]) {
    for (const cond of trigger.conditions) {
      if (cond.type !== 'schedule' || !cond.next_run_at) continue;
      if (new Date(cond.next_run_at).getTime() > now) continue;

      try {
        await fireTrigger(trigger, { kind: 'schedule' });
      } catch (err) {
        logger.error('trigger-scheduler', `Failed to fire trigger ${trigger.id}`, err);
      }

      if (cond.cron) {
        // Recurring: advance to the next future run. computeNextRun(now) skips
        // any windows missed during downtime — one fire, not one-per-window.
        const next = computeNextRun(cond.cron, cond.tz);
        cond.next_run_at = next ? next.toISOString() : cond.next_run_at;
        await saveTrigger(trigger);
      } else {
        // One-off: auto-pause after firing once.
        trigger.status = 'paused';
        await saveTrigger(trigger);
        deindexTrigger(trigger.id);
        emitEvent('trigger:paused', trigger.id, { reason: 'one-off fired' });
        break;
      }
    }
  }
}

/**
 * Fire a trigger: spawn a fresh read-only task, wire its delivery channel, and
 * seed the PM with the action prompt. Shared by the scheduler (schedule context)
 * and the Slack dispatch hook (message context).
 *
 * Firing posts no preamble — the spawned PM does the work and posts the result
 * itself, so the first message the channel sees is the actual output.
 */
export async function fireTrigger(trigger: Trigger, context: FireContext): Promise<void> {
  if (!triggersEnabled()) return;
  if (!withinDailyCap()) {
    logger.warn('trigger-scheduler', `Daily fire cap (${DAILY_FIRE_CAP}) reached — dropping trigger ${trigger.id}`);
    await notifyCreator(trigger, `⚠️ A trigger you set up couldn't run — Archie hit its daily limit of automated runs. It will resume tomorrow.`);
    return;
  }

  const task = await Task.create();
  task.metadata.triggered_by = trigger.id;

  // Wire delivery. message context → reply in the triggering thread (linked as
  // default, no post). schedule context → the PM opens the destination itself.
  let delivery: string;
  if (context.kind === 'message' && context.channelId && context.threadId) {
    task.linkSlackThread(context.channelId, context.threadId, context.channelName ?? context.channelId);
    delivery = 'Post your reply in your default channel — the thread where the triggering message was posted.';
  } else if (trigger.binding.type === 'user') {
    delivery = `Deliver the result as a direct message to the user (Slack user ID ${trigger.binding.user_id}).`;
  } else {
    delivery = `Deliver the result by starting a new thread in the channel #${trigger.binding.channel_name} (Slack channel ID ${trigger.binding.channel_id}).`;
  }
  task.debouncedSave();

  const reason = context.kind === 'message'
    ? `a new message in #${context.channelName ?? context.channelId ?? 'a channel'} matched your filter`
    : 'a scheduled run';
  const seed = `${trigger.action.prompt}\n\n${delivery}`;

  logger.system(`Trigger ${trigger.id} fired (${context.kind}) → task ${task.taskId}`);
  await task.sendMessage(AGENT_PROMPTS.triggered(seed, reason), 'pm-agent');

  trigger.last_fired_at = new Date().toISOString();
  await saveTrigger(trigger);
  emitEvent('trigger:fired', task.taskId, { trigger_id: trigger.id });
}

// ---- Announcements (config changes only — never firing) ----

type TriggerChange = 'enabled' | 'edited' | 'paused' | 'resumed' | 'deleted';

/**
 * Post a one-line notice to the channel a trigger is bound to whenever its
 * configuration changes. This is the transparency guarantee: a trigger can be
 * managed from a DM, but its bound channel always sees the change. Best-effort —
 * a failed post is logged, not thrown.
 */
export async function announceTriggerChange(trigger: Trigger, change: TriggerChange): Promise<void> {
  const verb: Record<TriggerChange, string> = {
    enabled: 'set up',
    edited: 'updated',
    paused: 'paused',
    resumed: 'resumed',
    deleted: 'removed',
  };
  const summary = describeTrigger(trigger);
  const text = `🔔 Trigger ${verb[change]}: ${summary}`;
  try {
    await postToBinding(trigger.binding, text);
  } catch (err) {
    logger.warn('trigger-scheduler', `Failed to announce ${change} for ${trigger.id}`, err);
  }
}

/** Human-readable one-liner describing what a trigger does. */
export function describeTrigger(trigger: Trigger): string {
  const parts = trigger.conditions.map((c) => {
    if (c.type === 'schedule') {
      return c.cron ? `on schedule (${c.cron}, ${c.tz})` : `once at ${c.next_run_at}`;
    }
    const filters: string[] = [];
    if (c.match?.contains) filters.push(`containing "${c.match.contains}"`);
    if (c.match?.from_user) filters.push(`from a specific user`);
    return `on a new message${filters.length ? ' ' + filters.join(' ') : ''}`;
  });
  return `${parts.join(' or ')} → ${trigger.action.prompt}`;
}

/** Post a plain message to a trigger's binding (channel thread or user DM). */
async function postToBinding(binding: TriggerBinding, text: string): Promise<void> {
  if (binding.type === 'user') {
    const dm = await openDMChannel(binding.user_id);
    await postSlackMessage({ channel: dm, text });
  } else {
    await postSlackMessage({ channel: binding.channel_id, text });
  }
}

/** Best-effort DM to a trigger's creator (used for cap/failure notices). */
async function notifyCreator(trigger: Trigger, text: string): Promise<void> {
  try {
    const dm = await openDMChannel(trigger.created_by);
    await postSlackMessage({ channel: dm, text });
  } catch (err) {
    logger.warn('trigger-scheduler', `Failed to notify creator of ${trigger.id}`, err);
  }
}
