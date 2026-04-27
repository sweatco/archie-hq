/**
 * Slack assistant thread title wrapper.
 *
 * Wraps `assistant.threads.setTitle` for DM-originated tasks. Errors are
 * logged and swallowed — title is still persisted in metadata even if Slack
 * sync fails.
 *
 * Required Slack scope: `assistant:write`. The Agents & AI Apps feature
 * toggle must be enabled on the bot.
 */

import type { WebClient } from '@slack/web-api';
import { logger } from '../../system/logger.js';

export async function setAssistantThreadTitle(
  client: WebClient,
  channel_id: string,
  thread_ts: string,
  title: string,
): Promise<void> {
  try {
    await client.assistant.threads.setTitle({ channel_id, thread_ts, title });
    logger.system(`Slack DM title synced (${channel_id}/${thread_ts})`);
  } catch (err) {
    logger.warn('slack-title', `setTitle failed for ${channel_id}/${thread_ts}: ${err}`);
  }
}
