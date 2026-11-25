/**
 * Slack thread title wrapper for DM-originated tasks.
 *
 * Wraps `assistant.threads.setTitle`. On Slack's Agent surface the call is
 * bridged: Slack applies the title to the thread's agent session, where it shows
 * in the thread header (observed, #425). `agents.sessions.rename` is the new
 * method; the bridge is kept until Slack dates the old one's removal. Errors are
 * logged and swallowed — the title is still persisted in metadata even if Slack
 * sync fails.
 *
 * Required Slack scope: `assistant:write`.
 */

import type { WebClient } from '@slack/web-api';
import { logger } from '../../system/logger.js';
import { isSlackDryRun } from './client.js';

export async function setAssistantThreadTitle(
  client: WebClient,
  channel_id: string,
  thread_ts: string,
  title: string,
): Promise<void> {
  if (isSlackDryRun()) return;
  try {
    await client.assistant.threads.setTitle({ channel_id, thread_ts, title });
    logger.system(`Slack DM title synced (${channel_id}/${thread_ts})`);
  } catch (err) {
    logger.warn('slack-title', `setTitle failed for ${channel_id}/${thread_ts}: ${err}`);
  }
}
