/**
 * Slack renderer for the live status indicator.
 *
 * Calls `agents.sessions.setStatus`: a non-empty status sets `processing`, an
 * empty one `active`, and Slack shows only "<App> is working". The bridged
 * `assistant.threads.setStatus` offers no stop button. A posted reply does not
 * end `processing`, so the app must send `active` itself.
 *
 * Best-effort: errors — and an uninitialised client (e.g. CLI-only runs) — are
 * logged and swallowed so a failed status update never breaks the work it
 * describes. Honours Slack dry-run.
 */

import { getSlackClient, isSlackDryRun } from './client.js';
import { logger } from '../../system/logger.js';

/**
 * Set (or, with an empty string, clear) the loading status on a Slack thread.
 * Never throws; resolves to whether Slack accepted the call.
 */
export async function setSlackThreadStatus(
  channel_id: string,
  thread_ts: string,
  status: string,
): Promise<boolean> {
  if (isSlackDryRun()) {
    logger.debug('slack-status', `[DRY RUN] setStatus ${channel_id}/${thread_ts} — "${status}"`);
    return false;
  }
  try {
    await getSlackClient().agents.sessions.setStatus({
      channel_id,
      thread_ts,
      status: status ? 'processing' : 'active',
    });
    return true;
  } catch (err) {
    logger.warn('slack-status', `setStatus failed for ${channel_id}/${thread_ts}: ${err}`);
    return false;
  }
}
