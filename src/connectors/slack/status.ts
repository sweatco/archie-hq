/**
 * Slack renderer for the live status indicator.
 *
 * The status string is composed surface-agnostically by `TaskStatusController`
 * (src/tasks/status.ts) and gated by `isStatusEnabled()`; this module renders it
 * to Slack's Agent surface with `agents.sessions.setStatus`, on the same
 * `channel_id` + `thread_ts` as the title (see title.ts). That call takes only a
 * state, so any non-empty status sets `processing` and an empty one sets
 * `active`. Slack shows "<App> is working" with a stop button; the composed text
 * reaches only the CLI.
 *
 * Why this call and not `assistant.threads.setStatus`: Slack bridges the old call
 * onto agent sessions, but then shows no stop button and drops the text as well
 * (observed on a throwaway app, #425). With either call the app must end the
 * session itself: a posted reply does not end `processing`, a press of the stop
 * button leaves "Stopping…" until the app sets `active`, and an unended session
 * stays `processing` for up to an hour.
 *
 * Best-effort: errors — and an uninitialised client (e.g. CLI-only runs) — are
 * logged and swallowed so a failed status update never breaks the work it
 * describes. Honours Slack dry-run. Works in DM and channel threads. The pinned
 * `@slack/web-api` has no typed `agents.*` methods, hence `apiCall`.
 */

import { getSlackClient, isSlackDryRun } from './client.js';
import { logger } from '../../system/logger.js';

/**
 * Mark a Slack thread's agent session as working, or, with an empty string, as
 * no longer working. Never throws.
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
    await getSlackClient().apiCall('agents.sessions.setStatus', {
      channel_id,
      thread_ts,
      status: status ? 'processing' : 'active',
    });
  } catch (err) {
    logger.warn('slack-status', `setStatus failed for ${channel_id}/${thread_ts}: ${err}`);
  }
}
