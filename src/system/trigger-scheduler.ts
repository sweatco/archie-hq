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
import type { Trigger, TriggerBinding, TriggerCondition } from '../types/trigger.js';
import { listTriggers, saveTrigger, deleteTrigger } from './trigger-store.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';
import { emitEvent } from './event-bus.js';
import { logger } from './logger.js';
import { postSlackMessage, isChannelReachable } from '../connectors/slack/client.js';

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
    // Sample several upcoming runs and check the TIGHTEST gap, not just the
    // first — a schedule like "0 9,9:30 …" can have a wide first gap but a
    // sub-hour gap later in its cycle.
    runs = new Cron(cron, { timezone: tz }).nextRuns(6);
  } catch (err) {
    return { ok: false, error: `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (runs.length < 2) {
    return { ok: false, error: 'Cron expression does not produce a recurring schedule.' };
  }
  let minGap = Infinity;
  for (let i = 1; i < runs.length; i++) {
    minGap = Math.min(minGap, runs[i].getTime() - runs[i - 1].getTime());
  }
  if (minGap < MIN_RECURRING_INTERVAL_MS) {
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

/** Pending proposals older than this are GC'd on the boot scan. */
const PENDING_TTL_MS = 24 * 60 * 60_000;

/**
 * Rebuild the in-memory index from disk (enabled triggers only). Also GC's
 * stale `pending` proposals — a proposal that was never approved/denied (e.g.
 * the process restarted before the user acted) would otherwise leave an inert
 * file forever. Pending triggers are never indexed regardless, so this is pure
 * cleanup.
 */
async function rebuildFromDisk(): Promise<void> {
  enabledTriggers.clear();
  try {
    const now = Date.now();
    for (const trigger of await listTriggers()) {
      if (trigger.status === 'enabled') {
        indexTrigger(trigger);
      } else if (trigger.status === 'pending' && now - new Date(trigger.created_at).getTime() > PENDING_TTL_MS) {
        await deleteTrigger(trigger.id);
        logger.system(`Trigger ${trigger.id}: GC'd stale pending proposal`);
      }
    }
  } catch (err) {
    logger.error('trigger-scheduler', 'Failed to rebuild triggers from disk', err);
  }
}

/**
 * Add (or refresh) an enabled trigger in the index. Computes an initial
 * `next_run_at` only for a recurring condition that is MISSING one (e.g. a
 * legacy record). A *past* `next_run_at` is deliberately left untouched so the
 * next `checkDue` fires the missed window once before advancing — this is what
 * makes boot catch-up work (M1): `checkDue` runs right after `rebuildFromDisk`,
 * sees the overdue condition, fires it a single time, then advances past all
 * missed windows via `computeNextRun(now)`.
 */
export function indexTrigger(trigger: Trigger): void {
  if (trigger.status !== 'enabled') {
    enabledTriggers.delete(trigger.id);
    return;
  }
  for (const cond of trigger.conditions) {
    if (cond.type === 'schedule' && cond.cron && !cond.next_run_at) {
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

/**
 * Pure planning step for a single tick: given a trigger and the current instant,
 * decide what changes. Returns how many schedule conditions are due, the
 * post-fire condition set, and whether the trigger stays enabled. No I/O, so the
 * catch-up (M1) and per-condition (M2) rules are unit-testable.
 *
 * Rules:
 * - A due recurring condition is advanced to its next future run
 *   (`computeNextRun(now)` skips every window missed during downtime → one
 *   catch-up fire, not one per missed window).
 * - A due one-off condition is dropped (fires once, then gone) — WITHOUT
 *   disturbing sibling conditions (M2: a mixed one-off + recurring trigger keeps
 *   its recurring schedule).
 * - The trigger stays active while any schedule condition still has a
 *   `next_run_at` or any `channel_message` condition remains; otherwise it's
 *   spent and should be paused.
 */
export function planTick(
  trigger: Trigger,
  now: Date,
): { dueCount: number; nextConditions: TriggerCondition[]; stillActive: boolean } {
  const nowMs = now.getTime();
  let dueCount = 0;
  const nextConditions: TriggerCondition[] = [];
  for (const cond of trigger.conditions) {
    const isDueSchedule =
      cond.type === 'schedule' && !!cond.next_run_at && new Date(cond.next_run_at).getTime() <= nowMs;
    if (!isDueSchedule) {
      nextConditions.push(cond);
      continue;
    }
    dueCount++;
    if (cond.type === 'schedule' && cond.cron) {
      const next = computeNextRun(cond.cron, cond.tz, now);
      if (next) nextConditions.push({ ...cond, next_run_at: next.toISOString() });
      // else: cron became uncomputable → drop this condition (don't re-fire forever)
    }
    // one-off due → dropped (not pushed)
  }
  const stillActive = nextConditions.some(
    (c) => (c.type === 'schedule' && !!c.next_run_at) || c.type === 'channel_message',
  );
  return { dueCount, nextConditions, stillActive };
}

/**
 * Pure decision for how an `update_trigger` call should change a trigger's
 * enabled/paused state. Kept separate from the cap check (which is I/O) so the
 * intent rules are unit-testable.
 *
 * - Explicit `status` wins.
 * - Otherwise, giving a *paused* trigger new conditions auto-resumes it — the
 *   user is rescheduling something that had stopped (e.g. a fired one-off) and
 *   clearly wants it live again. Editing only the prompt/summary of a paused
 *   trigger does NOT resume it (a deliberate pause is respected).
 *
 * `target` is the resulting status ('unchanged' = leave as-is); `statusChange`
 * is what to announce; `autoResume` flags an implicit resume so the caller can
 * tell the user.
 */
export function planStatusChange(input: {
  currentStatus: 'enabled' | 'paused';
  hasNewConditions: boolean;
  requestedStatus?: 'enabled' | 'paused';
}): { target: 'enabled' | 'paused' | 'unchanged'; statusChange: 'resumed' | 'paused' | null; autoResume: boolean } {
  const explicitPause = input.requestedStatus === 'paused';
  const autoResume = input.hasNewConditions && input.currentStatus === 'paused' && !explicitPause;
  const wantEnable = input.requestedStatus === 'enabled' || autoResume;

  if (wantEnable && input.currentStatus !== 'enabled') {
    return { target: 'enabled', statusChange: 'resumed', autoResume };
  }
  if (explicitPause && input.currentStatus !== 'paused') {
    return { target: 'paused', statusChange: 'paused', autoResume: false };
  }
  return { target: 'unchanged', statusChange: null, autoResume: false };
}

// Re-entrancy guard: a tick that runs longer than the 60s interval must not
// overlap the next one (which could double-fire a not-yet-advanced condition).
let ticking = false;

/** Check for due schedule conditions and fire them (at most once per trigger per tick). */
async function checkDue(): Promise<void> {
  if (!triggersEnabled() || ticking) return;
  ticking = true;
  try {
    const now = new Date();
    for (const trigger of [...enabledTriggers.values()]) {
      try {
        await tickTrigger(trigger, now);
      } catch (err) {
        // Isolate failures so one trigger's error (e.g. a disk write) doesn't
        // skip the rest of this tick.
        logger.error('trigger-scheduler', `Failed to tick trigger ${trigger.id}`, err);
      }
    }
  } finally {
    ticking = false;
  }
}

/** Fire a single trigger once if any of its schedule conditions are due, then
 * advance/expire those conditions and (de)persist. */
async function tickTrigger(trigger: Trigger, now: Date): Promise<void> {
  const plan = planTick(trigger, now);
  if (plan.dueCount === 0) return;

  // Fire ONCE for the trigger this tick, even when several conditions coincide
  // (M2: "any match fires the trigger" — not one task per condition).
  await fireTrigger(trigger, { kind: 'schedule' });

  // fireTrigger may have paused + deindexed the trigger (daily cap, unreachable
  // channel). If so, leave its conditions alone.
  if (!enabledTriggers.has(trigger.id)) return;

  trigger.conditions = plan.nextConditions;
  if (plan.stillActive) {
    await saveTrigger(trigger);
    enabledTriggers.set(trigger.id, trigger);
  } else {
    trigger.status = 'paused';
    await saveTrigger(trigger);
    deindexTrigger(trigger.id);
    emitEvent('trigger:paused', trigger.id, { reason: 'all schedule conditions fired' });
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

  // Pre-flight for a channel-bound schedule fire: if the bound channel was
  // deleted or archived (or the bot removed and it archived), pause the trigger
  // and DM the creator instead of spawning a task that would post into the void.
  // Message-context fires skip this — we just received a message there, so it's
  // live — and DMs can't be deleted. Checked BEFORE the daily cap so a bail here
  // doesn't consume a cap slot (L2).
  if (context.kind !== 'message' && trigger.binding.type === 'channel') {
    if (!(await isChannelReachable(trigger.binding.channel_id))) {
      logger.warn('trigger-scheduler', `Trigger ${trigger.id} bound channel ${trigger.binding.channel_id} unreachable — pausing`);
      trigger.status = 'paused';
      await saveTrigger(trigger);
      deindexTrigger(trigger.id);
      emitEvent('trigger:paused', trigger.id, { reason: 'bound channel unreachable' });
      await notifyCreator(trigger, `⚠️ A trigger you set up was paused — its channel (#${trigger.binding.channel_name}) is gone or archived. Recreate it elsewhere if you still need it.`);
      return;
    }
  }

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
    delivery = `Deliver the result to the user as a direct message (Slack user ID ${trigger.binding.user_id}).`;
  } else {
    delivery = `Deliver the result by posting it to the channel #${trigger.binding.channel_name} (Slack channel ID ${trigger.binding.channel_id}).`;
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
  // The notice is posted IN the bound channel, so naming the channel again would
  // be redundant — omit "where" here (the approval card, posted in the task
  // thread, still shows it).
  const what = triggerWhat(trigger);
  const when = triggerWhen(trigger);
  let text: string;
  switch (change) {
    case 'enabled':
      text = `🔔 New automation added — *${what}* · ${when}`;
      break;
    case 'edited':
      text = `✏️ Automation updated — *${what}* · now ${when}`;
      break;
    case 'paused':
      text = `⏸️ Automation paused — *${what}* won't run until it's resumed.`;
      break;
    case 'resumed':
      text = `▶️ Automation resumed — *${what}* · ${when}`;
      break;
    case 'deleted':
      text = `🗑️ Automation removed — *${what}*`;
      break;
  }
  try {
    await postToBinding(trigger.binding, text);
  } catch (err) {
    logger.warn('trigger-scheduler', `Failed to announce ${change} for ${trigger.id}`, err);
  }
}

// ---- Human-readable rendering ----
//
// User-facing trigger text is built from three plain-English facets — WHAT it
// does (the PM's short summary, never the verbose internal prompt), WHEN it
// runs (cron humanized to prose, never a raw expression), and WHERE it posts.

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 24h hour+minute → "9:00 AM" / "3:15 PM" / "12:00 AM". */
function formatClock(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** Friendly timezone label: "Europe/London" → "London time", "UTC" → "UTC". */
export function friendlyTz(tz: string): string {
  if (!tz || tz === 'UTC') return 'UTC';
  const city = tz.split('/').pop()?.replace(/_/g, ' ');
  return city ? `${city} time` : tz;
}

/**
 * Turn a cron expression into plain English for the shapes the PM generates
 * (hourly, daily/weekday/weekend/weekly/monthly at a time). Falls back to a
 * generic phrase for anything unusual — the raw cron is never shown to users.
 */
export function describeSchedule(cron: string, tz: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'on a custom schedule';
  const [min, hour, dom, mon, dow] = parts;
  const isNum = (s: string) => /^\d+$/.test(s);
  const tzSuffix = ` (${friendlyTz(tz)})`;

  // Sub-daily cadences (no specific clock time → no timezone suffix).
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep) return `every ${hourStep[1]} hours`;
  if (hour === '*') {
    const minStep = min.match(/^\*\/(\d+)$/);
    if (minStep) return `every ${minStep[1]} minutes`;
    if (isNum(min)) return min === '0' ? 'every hour' : `every hour at :${min.padStart(2, '0')}`;
    return 'on a custom schedule';
  }

  if (!isNum(hour) || !isNum(min)) return 'on a custom schedule';
  const time = formatClock(Number(hour), Number(min));

  if (dow !== '*') {
    if (dow === '1-5') return `every weekday at ${time}${tzSuffix}`;
    if (['0,6', '6,0', '6,7', '0,7'].includes(dow)) return `every weekend at ${time}${tzSuffix}`;
    const nums = dow.split(',').map((d) => (d === '7' ? 0 : Number(d)));
    if (nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) {
      return `every ${nums.map((n) => DOW_NAMES[n]).join(', ')} at ${time}${tzSuffix}`;
    }
    return 'on a custom schedule';
  }

  if (dom !== '*' && isNum(dom)) {
    const scope = mon === '*' ? 'each month' : 'certain months';
    return `on the ${ordinal(Number(dom))} of ${scope} at ${time}${tzSuffix}`;
  }

  if (dom === '*' && mon === '*') return `every day at ${time}${tzSuffix}`;
  return 'on a custom schedule';
}

/** Render a one-off instant in a timezone: "once on Jun 26 at 9:00 AM (London time)". */
function describeOneOff(iso: string, tz: string): string {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    return `once on ${date} at ${time} (${friendlyTz(tz)})`;
  } catch {
    return `once at ${iso}`;
  }
}

/** Plain-English "when" clause for a single condition. */
function describeCondition(c: TriggerCondition): string {
  if (c.type === 'schedule') {
    return c.cron ? describeSchedule(c.cron, c.tz) : describeOneOff(c.next_run_at, c.tz);
  }
  const filters: string[] = [];
  if (c.match?.contains) filters.push(`mentioning "${c.match.contains}"`);
  if (c.match?.from_user) filters.push('from a specific person');
  return `on a new message${filters.length ? ' ' + filters.join(' ') : ''}`;
}

/** First sentence / clipped form of the internal prompt — fallback when no summary was set. */
function shortenPrompt(prompt: string): string {
  const s = (prompt.split(/(?<=[.!?])\s/)[0] ?? prompt).trim();
  return s.length > 90 ? `${s.slice(0, 87)}…` : s;
}

/** WHAT the trigger does — the PM's short summary, else a clipped internal prompt.
 * Trailing punctuation is stripped so it reads as a label inside a larger sentence. */
export function triggerWhat(trigger: Trigger): string {
  const raw = trigger.summary?.trim() || shortenPrompt(trigger.action.prompt);
  return raw.replace(/[.\s]+$/, '');
}

/** WHEN it runs, across all conditions ("every day at 9:00 AM" / "on a new message …"). */
export function triggerWhen(trigger: Trigger): string {
  return trigger.conditions.map(describeCondition).join(' or ');
}

/** WHERE results are delivered ("#general" / "a DM"). */
export function triggerWhere(trigger: Trigger): string {
  return trigger.binding.type === 'channel' ? `#${trigger.binding.channel_name}` : 'a DM';
}

/** Human-readable one-liner: "<when> → <what>". Used by CLI/API listings. */
export function describeTrigger(trigger: Trigger): string {
  return `${triggerWhen(trigger)} → ${triggerWhat(trigger)}`;
}

/**
 * Post a plain message to a trigger's binding (channel or user DM). Slack's
 * chat.postMessage resolves a user id directly to that user's DM, so no
 * separate conversations.open is needed.
 */
async function postToBinding(binding: TriggerBinding, text: string): Promise<void> {
  const channel = binding.type === 'user' ? binding.user_id : binding.channel_id;
  await postSlackMessage({ channel, text });
}

/** Best-effort DM to a trigger's creator (used for cap/failure notices). */
async function notifyCreator(trigger: Trigger, text: string): Promise<void> {
  if (!trigger.created_by || trigger.created_by === 'unknown') return; // no known human to DM
  try {
    await postSlackMessage({ channel: trigger.created_by, text });
  } catch (err) {
    logger.warn('trigger-scheduler', `Failed to notify creator of ${trigger.id}`, err);
  }
}
