/**
 * Slack assistant thread title wrapper.
 *
 * Wraps `agents.sessions.rename` for DM-originated tasks. It fails with
 * `not_authorized` until the status indicator has created the session. Errors
 * are logged and swallowed — title is still persisted in metadata even if Slack
 * sync fails.
 *
 * Required Slack scope: `chat:write`.
 */

import type { WebClient } from '@slack/web-api';
import { logger } from '../../system/logger.js';
import { isSlackDryRun } from './client.js';

export async function setAssistantThreadTitle(
  client: WebClient,
  channel_id: string,
  thread_ts: string,
  title: string,
): Promise<boolean> {
  if (isSlackDryRun()) return false;
  try {
    await client.agents.sessions.rename({ channel_id, thread_ts, title });
    logger.system(`Slack DM title synced (${channel_id}/${thread_ts})`);
    return true;
  } catch (err) {
    logger.warn('slack-title', `rename failed for ${channel_id}/${thread_ts}: ${err}`);
    return false;
  }
}
