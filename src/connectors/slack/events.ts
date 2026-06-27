/**
 * Slack Events — Bolt app, event handlers, button handlers
 *
 * Owns: Slack Bolt app, app_mention/message handlers, button actions,
 * Slack triage processing. Does NOT own the HTTP server or GitHub endpoints.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { App, ExpressReceiver, SocketModeReceiver } = require('@slack/bolt');

import type { Application } from 'express';
import type { App as AppType } from '@slack/bolt';

import {
  initSlackClient,
  updateMessage,
  getBotUserId,
  fetchSlackThread,
  getBotId,
  addReaction,
  setSlackDryRun,
  getUserInfo,
  isExternalUser,
  isChannelShared,
  postEphemeral,
  getSlackClient,
  cleanSlackText,
} from './client.js';
import { ensureChannelCanvas } from './channel-canvas.js';
import { Task } from '../../tasks/task.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { logger } from '../../system/logger.js';
import { getIsShuttingDown } from '../../system/shutdown.js';
import { findTaskByThread } from '../../tasks/persistence.js';
import { generateTaskTitle } from '../../tasks/title-generator.js';
import { setAssistantThreadTitle } from './title.js';
import type { SlackThread, SlackAuthor } from '../../types/task.js';
// import { triageSlackMessage } from '../../system/triage.js';

/**
 * Slack configuration
 *
 * If `slackAppToken` is set, the Bolt app runs in Socket Mode (outbound
 * WebSocket, no webhook URL). Otherwise it mounts an HTTP receiver on the
 * shared Express app at `/webhooks/slack` and uses `slackSigningSecret` to
 * verify inbound requests.
 */
export interface SlackConfig {
  slackBotToken: string;
  slackSigningSecret?: string;
  slackAppToken?: string;
  dryRun?: boolean;
}

/**
 * Lifecycle handle returned by mountSlackApp.
 *
 * Mounting only registers handlers; `start()` opens the Socket Mode
 * WebSocket (no-op in HTTP mode, which is driven by the shared HTTP
 * server). Callers should defer `start()` until task recovery has
 * completed so startup-time events cannot race recovery.
 */
export interface SlackLifecycle {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

let app: AppType | null = null;

/**
 * Mount Slack Bolt app on an existing Express app
 *
 * Registers Bolt event/action handlers and initializes the Slack
 * client. In HTTP mode the ExpressReceiver hooks routes onto the
 * shared Express app immediately. In Socket Mode the WebSocket is
 * NOT opened here — call `start()` on the returned lifecycle once
 * the rest of bootstrap (task recovery, scheduler) is ready.
 */
export async function mountSlackApp(
  expressApp: Application,
  config: SlackConfig
): Promise<SlackLifecycle> {
  const useSocketMode = !!config.slackAppToken;

  if (useSocketMode) {
    if (!config.slackAppToken!.startsWith('xapp-')) {
      throw new Error(
        'SLACK_APP_TOKEN must start with "xapp-" (app-level token with connections:write scope)'
      );
    }
    logger.plain('Slack: Socket Mode (outbound WebSocket, no webhook URL)');
  } else {
    if (!config.slackSigningSecret) {
      throw new Error('SLACK_SIGNING_SECRET is required when SLACK_APP_TOKEN is not set');
    }
    logger.plain('Slack webhook: POST /webhooks/slack');
  }

  // Enable dry-run mode (receive events, suppress outgoing messages)
  if (config.dryRun) {
    setSlackDryRun(true);
    logger.plain('Slack dry-run mode: outgoing messages suppressed');
  }

  // Initialize Slack client for outgoing messages
  await initSlackClient(config.slackBotToken);

  // Create Bolt app with the appropriate receiver
  const receiver = useSocketMode
    ? new SocketModeReceiver({ appToken: config.slackAppToken })
    : new ExpressReceiver({
        signingSecret: config.slackSigningSecret!,
        endpoints: '/webhooks/slack',
        app: expressApp,
      });

  app = new App({
    token: config.slackBotToken,
    receiver,
  });

  // Handle app mentions - process inline
  app!.event('app_mention', async ({ event }) => {
    if (getIsShuttingDown()) {
      logger.system('Ignoring Slack event during shutdown');
      return;
    }

    const route = routeSlackEvent(event);
    if (route.action === 'discard') {
      return;
    }

    handleSlackEvent({
      type: event.type,
      channel: event.channel,
      user: event.user ?? '',
      text: event.text,
      ts: event.ts,
      thread_ts: event.thread_ts,
    }).catch((err: unknown) => logger.error('Server', 'Error processing Slack event', err));
  });

  // Handle thread messages (replies without @mention) and DM messages
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.event('message', async ({ event }: { event: any }) => {
    // Message edits arrive as a `message_changed` subtype carrying both the new
    // (`message`) and prior (`previous_message`) versions. Handle these on a
    // dedicated path: we log the edit and wake the owning task so the agent can
    // reassess if the change is material. (Slack also fires `message_changed`
    // for link unfurls and attachment re-renders with unchanged text — those are
    // filtered out inside `handleSlackEdit`.)
    if (event.subtype === 'message_changed') {
      if (getIsShuttingDown()) {
        logger.system('Ignoring Slack edit during shutdown');
        return;
      }
      handleSlackEdit(event).catch((err: unknown) =>
        logger.error('Server', 'Error processing Slack message edit', err));
      return;
    }

    const isDm = event.channel?.startsWith('D');
    const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
    if (
      event.type === 'message' &&
      (!event.subtype || ['file_share', 'thread_broadcast'].includes(event.subtype)) &&
      (isThreadReply || isDm)
    ) {
      // In channels, @mentions are handled by app_mention handler, so skip them here
      // to avoid double-processing. But in DMs, app_mention doesn't fire, so we must
      // process mention-containing DMs here.
      const botUserId = getBotUserId();
      if (!isDm && botUserId && event.text?.includes(`<@${botUserId}>`)) {
        return;
      }

      if (getIsShuttingDown()) {
        logger.system('Ignoring Slack event during shutdown');
        return;
      }

      const route = routeSlackEvent(event);
      if (route.action === 'discard') {
        return;
      }

      handleSlackEvent({
        type: event.type,
        channel: event.channel,
        user: event.user || '',
        text: event.text || '',
        ts: event.ts,
        thread_ts: event.thread_ts,
      }).catch((err: unknown) => logger.error('Server', 'Error processing Slack event', err));
    }
  });

  // Handle the bot itself being added to a channel — scan for an existing
  // "Archie" canvas and adopt/announce it immediately (so a canvas already in
  // the channel isn't missed until the first message). Only the bot's own join
  // matters; `routeSlackEvent`'s own-bot filter is not on this path, so the
  // self-join check here is load-bearing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.event('member_joined_channel', async ({ event }: { event: any }) => {
    if (getIsShuttingDown()) return;
    const botUserId = getBotUserId();
    if (!botUserId || event.user !== botUserId) return;
    if (typeof event.channel !== 'string' || event.channel.startsWith('D')) return;
    ensureChannelCanvas(event.channel).catch((err: unknown) =>
      logger.error('Server', 'Error scanning canvas on channel join', err));
  });

  // Handle edit mode approval button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('approve_edit_mode', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || 'unknown';

    logger.server(`Edit mode approved by ${userId} for task ${taskId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `✅ *Edit mode approved* by <@${userId}>`,
          []
        );
      }

      const task = await Task.get(taskId);
      await task.handleEditModeApproval();
    } catch (error) {
      logger.error('Server', 'Error handling edit mode approval', error);
    }
  });

  // Handle edit mode denial button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('deny_edit_mode', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || 'unknown';

    logger.server(`Edit mode denied by ${userId} for task ${taskId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `❌ *Edit mode denied* by <@${userId}>`,
          []
        );
      }

      const task = await Task.get(taskId);
      await task.handleEditModeDenial();
    } catch (error) {
      logger.error('Server', 'Error handling edit mode denial', error);
    }
  });

  // Handle research budget approval button (Defense 4)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('approve_research_budget', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || 'unknown';

    logger.server(`Research budget approved by ${userId} for task ${taskId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `✅ *Research budget extended* by <@${userId}> (+5 requests)`,
          []
        );
      }

      const task = await Task.get(taskId);
      await task.handleResearchBudgetApproval();
    } catch (error) {
      logger.error('Server', 'Error handling research budget approval', error);
    }
  });

  // Handle research budget denial button (Defense 4)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('deny_research_budget', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const userId = body.user?.id || 'unknown';

    logger.server(`Research budget denied by ${userId} for task ${taskId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `❌ *Additional research denied* by <@${userId}>`,
          []
        );
      }

      const task = await Task.get(taskId);
      await task.handleResearchBudgetDenial();
    } catch (error) {
      logger.error('Server', 'Error handling research budget denial', error);
    }
  });

  // Return a lifecycle handle. start()/stop() are no-ops in HTTP mode —
  // the shared HTTP server in src/index.ts drives the ExpressReceiver.
  return {
    async start() {
      if (useSocketMode) {
        await app!.start();
        logger.plain('Slack: Socket Mode connected');
      }
    },
    async stop() {
      if (useSocketMode && app) {
        await app.stop();
        logger.plain('Slack: Socket Mode disconnected');
      }
    },
  };
}


// ============================================================================
// Task Title Pipeline
// ============================================================================

/**
 * Fire-and-forget title generation + Slack sync.
 *
 * Generates a Haiku-authored title for the task and persists it on metadata.
 * For DM-originated tasks, also pushes the title to Slack via
 * `assistant.threads.setTitle` so the bot's DM list shows a meaningful name.
 *
 * Errors are swallowed by the called helpers — title is best-effort.
 */
async function generateTitleAndSync(task: Task, thread: SlackThread): Promise<void> {
  const title = await generateTaskTitle(thread);
  if (!title) return;

  task.metadata.title = title;
  task.debouncedSave();
  logger.system(`Task ${task.taskId} title set: "${title}"`);

  if (thread.channel.id.startsWith('D')) {
    await setAssistantThreadTitle(getSlackClient(), thread.channel.id, thread.threadId, title);
  }
}

// ============================================================================
// Slack Routing
// ============================================================================

type SlackRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'triage' };

function routeSlackEvent(event: {
  bot_id?: string;
  type: string;
}): SlackRouteResult {
  const ourBotId = getBotId();
  if (event.bot_id && ourBotId && event.bot_id === ourBotId) {
    return { action: 'discard', reason: 'Own bot message' };
  }

  return { action: 'triage' };
}

// ============================================================================
// Slack Event Handler
// ============================================================================

async function handleSlackEvent(event: {
  type: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}): Promise<void> {
  const threadId = event.thread_ts || event.ts;
  // Key under which this thread is (or will be) linked in task.metadata.channels.
  const channelKey = `slack:${event.channel}:${threadId}`;

  // ---- External-author bail-out --------------------------------------------
  // Resolve the event author and bail if external (different team, or guest).
  // No agent spawn, no task creation, no reactions, no log entries. The
  // redacted history will be appended lazily the next time an internal user
  // triggers the handler (fetchSlackThread re-reads full history and redacts).
  if (event.user) {
    try {
      const authorInfo = await getUserInfo(event.user);
      if (isExternalUser(authorInfo)) {
        logger.system(`Skipping event from external/guest user ${event.user}`);
        return;
      }
    } catch (error) {
      // Fail open — if we can't classify, don't silently drop the event.
      logger.warn('Slack', `Failed to classify event author ${event.user}`, error);
    }
  }

  // Instant acknowledgment — react before any LLM processing. Only @mentions
  // and DM messages are acknowledged; plain thread replies in an engaged channel
  // are not. Moving the ack (clearing it from the previously-acked message)
  // and recording which message holds it is done via `task.ackMessage` once we
  // have a task in hand — see below — so the bookkeeping survives follow-up
  // messages.
  const isAckable = event.type === 'app_mention' || event.channel.startsWith('D');
  if (isAckable) {
    addReaction(event.channel, event.ts, 'eyes');
  }

  const thread = await fetchSlackThread(event.channel, threadId, event.ts);
  const shared = await isChannelShared(event.channel);

  // Refresh the channel's "Archie" project-context canvas before the PM wakes,
  // so the spawn-time injection reads fresh state. No-op for DMs and TTL-bounded.
  // Runs after the external-author bail-out above, so a purely-external trigger
  // never causes a scan. Never throws.
  await ensureChannelCanvas(event.channel);

  // const triageResult = await triageSlackMessage(thread);
  // switch (triageResult.action) {
  //   case 'new_task': {
  //     const task = await Task.create();
  //     await task.append(thread);
  //     await task.sendMessage(AGENT_PROMPTS.newTask);
  //     break;
  //   }
  //   case 'existing_task': {
  //     if (!triageResult.task_id) break;
  //     const task = await Task.get(triageResult.task_id);
  //     const { linkedNewThread } = await task.append(thread);
  //     if (linkedNewThread) {
  //       await postToThreads(
  //         [{ thread_id: thread.threadId, channel_id: thread.channel.id, last_processed_ts: thread.currentMessageTs }],
  //         'Got it, I\'ve linked this to the ongoing investigation.',
  //       );
  //     }
  //     await task.sendMessage(AGENT_PROMPTS.existingTask);
  //     break;
  //   }
  //   case 'cancel_task': {
  //     if (!triageResult.task_id) break;
  //     const task = await Task.get(triageResult.task_id);
  //     await task.postToUser('Work stopped. All progress has been saved and can be resumed if needed.');
  //     await task.stop();
  //     break;
  //   }
  //   case 'noop':
  //     logger.system('Triage: noop');
  //     break;
  // }
  const taskId = await findTaskByThread(threadId);
  if (taskId) {
    logger.system(`Processing #${thread.channel.name} (thread: ${threadId})`);
    const task = await Task.get(taskId);

    // Check if channel is muted
    const channel = task.metadata.channels[channelKey];
    if (channel?.type === 'slack' && channel.muted) {
      const isDm = event.channel.startsWith('D');
      if (event.type === 'app_mention' || isDm) {
        // @mention unmutes the channel; a DM message is an implicit @mention
        // (there's no other re-engagement path in a DM)
        channel.muted = false;
        task.debouncedSave();
        logger.system(`Channel ${threadId} unmuted by ${event.type === 'app_mention' ? '@mention' : 'DM message'}`);
      } else {
        // Channel is muted and no @mention — skip
        logger.system(`Skipping muted channel ${threadId}`);
        return;
      }
    }

    // Thread reply to an existing task — route to it
    await task.append(thread);
    if (isAckable) task.ackMessage(channelKey, event.ts);
    if (!task.metadata.title) {
      generateTitleAndSync(task, thread).catch((err) =>
        logger.warn('title-generator', `pipeline failed: ${err}`),
      );
    }
    await sendSharedChannelWarnings(task, event.channel, threadId, thread, shared);
    await task.sendMessage(AGENT_PROMPTS.existingTask);
  } else if (event.type === 'app_mention' || event.channel.startsWith('D')) {
    logger.system(`Processing #${thread.channel.name} (thread: ${threadId})`);

    // Bot was @mentioned, or this is a DM — start a new task
    const task = await Task.create();
    await task.append(thread);
    if (isAckable) task.ackMessage(channelKey, event.ts);
    if (!task.metadata.title) {
      generateTitleAndSync(task, thread).catch((err) =>
        logger.warn('title-generator', `pipeline failed: ${err}`),
      );
    }
    await sendSharedChannelWarnings(task, event.channel, threadId, thread, shared);
    await task.sendMessage(AGENT_PROMPTS.newTask);
  }
  // Otherwise: thread reply in a thread the bot was never part of — ignore
}

/**
 * Handle a `message_changed` event — a user edited a previously sent message.
 *
 * We only act when all of these hold:
 *  - the text actually changed (Slack also fires this subtype for link unfurls
 *    and attachment re-renders, where new and previous text are identical),
 *  - the edit isn't bot-authored (our own posts or other integrations),
 *  - a task already follows this thread (mirrors plain-reply handling — we never
 *    engage a thread the bot wasn't invited to), and
 *  - the editor is an internal (non-external/guest) user.
 *
 * When they hold we append an edit notice to the task's knowledge log and wake
 * the task with the standard "new input" prompt. The agent decides whether the
 * change is material; a cosmetic edit can simply be a no-op on its end.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleSlackEdit(event: any): Promise<void> {
  const msg = event.message;
  const prev = event.previous_message;
  if (!msg || !msg.ts) return;

  // Skip bot-authored edits (our own messages or other integrations).
  if (msg.bot_id || msg.subtype === 'bot_message' || msg.user === getBotUserId()) return;

  const oldRaw: string = prev?.text ?? '';
  const newRaw: string = msg.text ?? '';
  // Unchanged text = an unfurl/attachment re-render, not a human edit. Drop it.
  if (newRaw === oldRaw) return;

  const channelId: string = event.channel;
  const editedTs: string = msg.ts;
  const threadId: string = msg.thread_ts || msg.ts;

  // Only act on threads a task already follows — same rule as plain replies.
  const taskId = await findTaskByThread(threadId);
  if (!taskId) return;

  // External-author bail-out + author resolution in one (cached) lookup.
  let authorInfo: Awaited<ReturnType<typeof getUserInfo>> | undefined;
  try {
    authorInfo = await getUserInfo(msg.user);
    if (isExternalUser(authorInfo)) {
      logger.system(`Skipping edit from external/guest user ${msg.user}`);
      return;
    }
  } catch (error) {
    // Fail open — if we can't classify, don't silently drop the edit.
    logger.warn('Slack', `Failed to classify edit author ${msg.user}`, error);
  }

  const task = await Task.get(taskId);
  const channelKey = `slack:${channelId}:${threadId}`;
  const channel = task.metadata.channels[channelKey];

  // Respect mute — a muted channel isn't woken by edits either.
  if (channel?.type === 'slack' && channel.muted) {
    logger.system(`Skipping edit in muted channel ${threadId}`);
    return;
  }

  // Resolve <@U…>/<#C…> mentions to the @<ID:Name> form used throughout the
  // knowledge log. Only the new text is logged — the pre-edit text already
  // lives in the log under the same `msg:<ts>` id.
  const newText = await cleanSlackText(newRaw, channelId);
  const author: SlackAuthor = {
    id: msg.user,
    username: authorInfo?.name ?? msg.user,
    realName: authorInfo?.realName ?? msg.user,
    teamId: authorInfo?.teamId,
    isRestricted: authorInfo?.isRestricted,
    isUltraRestricted: authorInfo?.isUltraRestricted,
  };

  const recorded = await task.appendSlackEdit(channelKey, author, editedTs, newText);
  if (!recorded) return;

  const channelLabel = channel?.type === 'slack' ? channel.channel_name : channelId;
  logger.system(`Processing edit in #${channelLabel} (msg: ${editedTs})`);
  await task.sendMessage(AGENT_PROMPTS.existingTask);
}

const SHARED_CHANNEL_WARNING_TEXT =
  ':warning: *Heads up:* this thread is in a Slack channel shared with an external organisation. ' +
  'Archie filters messages from external participants — if you need Archie to see something an ' +
  'external person said, re-say it yourself. Also be aware that anything Archie posts here ' +
  '(including on your behalf) is visible to the external org, so mind what you ask Archie to share.';

const FORWARD_NOTICE_TEXT =
  ':information_source: You forwarded a message originally authored by an external user. ' +
  'Archie will process its contents — just making sure you are aware.';

/**
 * Persist isShared and post ephemeral warnings to internal users in the thread.
 *
 * Warning A (shared-channel awareness): one ephemeral per (thread × user).
 * Warning B (forward-from-external): one ephemeral per (thread × forwarder).
 *
 * Both lists live on the SlackChannel metadata for the thread.
 */
async function sendSharedChannelWarnings(
  task: Task,
  channelId: string,
  threadId: string,
  thread: import('../../types/task.js').SlackThread,
  shared: boolean,
): Promise<void> {
  const channelKey = `slack:${channelId}:${threadId}`;
  const ch = task.metadata.channels[channelKey];
  if (!ch || ch.type !== 'slack') return;

  // Snapshot isShared for observability. Runtime decisions still use isChannelShared cache.
  ch.isShared = shared;

  if (!shared) {
    task.debouncedSave();
    return;
  }

  // Warning A — diff thread participants vs already-warned set.
  // Skip externals (they don't need our warning) and the bot.
  const warned = new Set(ch.warnedUsers ?? []);
  const botUserId = getBotUserId();
  const internalParticipants = new Set<string>();
  for (const msg of thread.messages) {
    if (isExternalUser(msg.user)) continue;
    if (!msg.user.id || msg.user.id === botUserId) continue;
    internalParticipants.add(msg.user.id);
  }
  const toWarn = [...internalParticipants].filter((u) => !warned.has(u));
  for (const userId of toWarn) {
    await postEphemeral(channelId, userId, SHARED_CHANNEL_WARNING_TEXT, threadId);
    warned.add(userId);
  }
  if (toWarn.length > 0) {
    ch.warnedUsers = [...warned];
  }

  // Warning B — for each message that carries at least one externally-authored
  // attachment, notify the forwarder (the message's top-level author) once
  // per thread.
  const forwardNotified = new Set(ch.forwardNotifiedUsers ?? []);
  const forwardersToNotify = new Set<string>();
  for (const msg of thread.messages) {
    if (!msg.user.id || forwardNotified.has(msg.user.id)) continue;
    const hasExternalAttachment = (msg.attachments ?? []).some(
      (att) => att.author && isExternalUser(att.author),
    );
    if (hasExternalAttachment) {
      forwardersToNotify.add(msg.user.id);
    }
  }
  for (const userId of forwardersToNotify) {
    await postEphemeral(channelId, userId, FORWARD_NOTICE_TEXT, threadId);
    forwardNotified.add(userId);
  }
  if (forwardersToNotify.size > 0) {
    ch.forwardNotifiedUsers = [...forwardNotified];
  }

  task.debouncedSave();
}

