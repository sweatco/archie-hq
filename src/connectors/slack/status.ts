/**
 * Slack assistant-thread status wrapper.
 *
 * Wraps `assistant.threads.setStatus` — the ephemeral "<App Name> is …" loading
 * line shown in a thread while a task is being worked on. It is the progress
 * sibling of `setTitle` (see title.ts): same `assistant.threads.*` accessor,
 * same `channel_id` + `thread_ts`. Slack auto-prepends the app name, so `status`
 * is a verb fragment ("is digging into the backend…"); an empty string clears
 * the indicator. Slack also clears it automatically when the app posts a reply,
 * and after a built-in ~2-minute timeout.
 *
 * Best-effort: errors — and an uninitialised client (e.g. CLI-only runs) — are
 * logged and swallowed so a failed status update never breaks the work it
 * describes. Honours Slack dry-run. Gated by `ARCHIE_SLACK_STATUS` (default on).
 *
 * Scope: since the 2026-03 platform change, `setStatus` accepts `chat:write`
 * and works in regular channel threads as well as DM/assistant threads, so it is
 * set on every linked Slack thread; any thread that rejects it is swallowed.
 *
 * Required Slack scope: `assistant:write` or `chat:write` (both present in the
 * manifest). The Agents & AI Apps feature toggle must be enabled on the bot.
 */

import { getSlackClient, isSlackDryRun } from './client.js';
import { logger } from '../../system/logger.js';

/** Feature gate — default on; set ARCHIE_SLACK_STATUS=false to disable. */
export function isSlackStatusEnabled(): boolean {
  return process.env.ARCHIE_SLACK_STATUS !== 'false';
}

/**
 * Set (or, with an empty string, clear) the loading status on a Slack thread.
 * Never throws.
 */
export async function setSlackThreadStatus(
  channel_id: string,
  thread_ts: string,
  status: string,
): Promise<void> {
  if (isSlackDryRun()) {
    logger.debug('slack-status', `[DRY RUN] setStatus ${channel_id}/${thread_ts} — "${status}"`);
    return;
  }
  try {
    const client = getSlackClient();
    await client.assistant.threads.setStatus({ channel_id, thread_ts, status });
  } catch (err) {
    logger.warn('slack-status', `setStatus failed for ${channel_id}/${thread_ts}: ${err}`);
  }
}
