import type { App, BlockAction, ButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { postEphemeral } from '../connectors/slack/client.js';
import { Task } from '../tasks/task.js';
import { logger } from '../system/logger.js';
import { resolvePreferenceApproval } from './explicit.js';
import { isAllowedTaskId } from './paths.js';

export function registerMemoryPreferenceHandlers(boltApp: Pick<App, 'action'>): void {
  const handle =
    (approve: boolean) =>
    async ({ action, ack, body }: SlackActionMiddlewareArgs<BlockAction<ButtonAction>>) => {
      await ack();
      const [taskId, id] = String(action.value ?? '').split('|');
      const userId = body.user?.id;
      const channelId = body.channel?.id;
      const rawThreadTs: unknown = body.message?.thread_ts;
      const threadTs = typeof rawThreadTs === 'string' ? rawThreadTs : undefined;
      if (!taskId || !id || !isAllowedTaskId(taskId) || !userId || !channelId) return;
      try {
        const task = await Task.get(taskId);
        const outcome = await resolvePreferenceApproval(task, id, userId, channelId, approve);
        if (
          outcome.status === 'saved' ||
          outcome.status === 'unchanged' ||
          outcome.status === 'cancelled' ||
          outcome.status === 'expired'
        ) {
          const text =
            outcome.status === 'saved' || outcome.status === 'unchanged'
              ? `✅ Preference saved across conversations for <@${userId}>: ${outcome.text}`
              : (outcome.message ?? 'The preference could not be saved.');
          if (body.message?.ts)
            await task
              .updateSlackMessageSafely(channelId, body.message.ts, text, [])
              .catch((error) =>
                logger.warn('Slack', 'Could not update preference approval card', error),
              );
          return;
        }
        await postEphemeral(
          channelId,
          userId,
          outcome.message ?? 'The preference could not be saved.',
          threadTs,
        );
      } catch (error) {
        logger.error('Server', 'Error handling preference approval', error);
        await postEphemeral(
          channelId,
          userId,
          'The approval could not be processed. Please retry.',
          threadTs,
        );
      }
    };
  boltApp.action('approve_memory_preference', handle(true));
  boltApp.action('deny_memory_preference', handle(false));
}
