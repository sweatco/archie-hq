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
  classifySlackIdentity,
  isExternalUser,
  postEphemeral,
  getSlackClient,
  fetchChannelIsPrivate,
  cleanSlackText,
} from './client.js';
import { ensureChannelCanvas } from './channel-canvas.js';
import { ensureChannelPins } from './channel-pins.js';
import { shouldCreateNewTask, shouldForwardMessageEvent, isAckableEvent } from './task-routing.js';
import { Task } from '../../tasks/task.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { logger } from '../../system/logger.js';
import { getIsShuttingDown } from '../../system/shutdown.js';
import { findTaskByThread } from '../../tasks/persistence.js';
import { rawMessageBody } from './message-body.js';
import { getChannelMessageTriggers, fireTrigger, triggerWhat } from '../../system/trigger-scheduler.js';
import type { Trigger } from '../../types/trigger.js';
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

type SlackUserInfo = Awaited<ReturnType<typeof getUserInfo>>;

type ActionBody = {
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string; blocks?: unknown[] };
};

async function rejectActionActor(
  body: ActionBody,
  userId: string,
  actionName: string,
  reason: 'external' | 'unknown',
): Promise<void> {
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;
  if (channelId) {
    const text = reason === 'external'
      ? `Only members of this workspace can complete this ${actionName}. Ask a workspace member to use the approval controls.`
      : `I couldn't verify your Slack account for this ${actionName}. Please try again.`;
    await postEphemeral(channelId, userId, text, body.message?.thread_ts ?? messageTs);
  }
  if (reason !== 'external' || !channelId || !messageTs) return;

  try {
    const waitingBlock = {
      type: 'context',
      block_id: 'external-actor-waiting',
      elements: [{
        type: 'mrkdwn',
        text: `⏳ Waiting for a workspace member — external and guest users can't complete this ${actionName}.`,
      }],
    };
    const blocks = body.message?.blocks
      ? [
          ...body.message.blocks.filter((block) =>
            !(block && typeof block === 'object' && 'block_id' in block && block.block_id === 'external-actor-waiting')),
          waitingBlock,
        ]
      : undefined;
    await updateMessage(
      channelId,
      messageTs,
      `⏳ *Waiting for a workspace member* — external and guest users can't complete this ${actionName}.`,
      blocks,
    );
  } catch (error) {
    logger.warn('Slack', `Failed to annotate ${actionName} after rejecting external/guest user ${userId}`, error);
  }
}

/** Resolve an interactive-action actor and require verified internal identity. */
export async function resolveInternalActionActor(
  body: ActionBody,
  actionName: string,
): Promise<{ id: string; info: SlackUserInfo } | null> {
  const userId = body.user?.id;
  if (!userId) {
    logger.warn('Slack', `Ignoring ${actionName}: action has no actor`);
    return null;
  }
  try {
    const info = await getUserInfo(userId);
    const identity = classifySlackIdentity(info);
    if (identity !== 'internal') {
      logger.system(`Ignoring ${actionName} from ${identity} user ${userId}`);
      await rejectActionActor(body, userId, actionName, identity);
      return null;
    }
    return { id: userId, info };
  } catch (error) {
    logger.warn('Slack', `Ignoring ${actionName}: failed to classify actor ${userId}`, error);
    await rejectActionActor(body, userId, actionName, 'unknown');
    return null;
  }
}

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
      raw: event,
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

    // Decide whether this message should flow into task routing at all. A
    // top-level channel post is only forwarded when an enabled channel-message
    // trigger is watching this exact channel — kept cheap via the in-memory
    // index (consulted lazily, so unwatched channels and DMs/thread-replies
    // stay a no-op). handleSlackEvent then runs the same own-bot/external/
    // @mention filtering before firing any trigger.
    if (!shouldForwardMessageEvent(event, (ch) => getChannelMessageTriggers(ch).length > 0)) {
      // Record, for a channel someone is actively watching, that the gate dropped an event and why — from the trigger owner's side a silent drop is indistinguishable from "nothing was posted", and this line is what makes "why didn't my trigger fire?" answerable.
      //
      // Deliberately `debug`, not `warn`. Two classes reach here and both are routine: a denylisted noise subtype, and an app post that is not a top-level channel message (app posts reach triggers but never wake a task, so a bot thread reply satisfies neither arm). Neither is an anomaly worth a warning, and the class this was originally written to catch — an unenumerated subtype vanishing — is now structurally impossible rather than merely logged, because the gate is a denylist.
      //
      // The message must not claim the denylist is the reason: `bot_message` is deliberately absent from it, so naming the denylist for a dropped bot reply would state the one fact the line exists to convey, wrongly. Report the subtype and let the reader compare it against the list.
      //
      // Consulting the trigger index here means it is no longer a lazy lookup on the dropped path; that is fine, it is an in-memory read.
      if (getChannelMessageTriggers(event.channel).length > 0) {
        logger.debug(
          'Slack',
          `Dropped a message event in trigger-watched channel ${event.channel} (ts ${event.ts}): subtype "${event.subtype ?? 'none'}"${event.bot_id ? ', app-authored' : ''} is not routed, so no channel-message trigger saw it`,
        );
      }
      return;
    }

    // In channels, @mentions are handled by app_mention handler, so skip them here
    // to avoid double-processing. But in DMs, app_mention doesn't fire, so we must
    // process mention-containing DMs here.
    const isDm = event.channel?.startsWith('D');
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
      raw: event,
      ts: event.ts,
      thread_ts: event.thread_ts,
    }).catch((err: unknown) => logger.error('Server', 'Error processing Slack event', err));
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
    Promise.all([ensureChannelCanvas(event.channel), ensureChannelPins(event.channel)]).catch((err: unknown) =>
      logger.error('Server', 'Error scanning channel context on channel join', err));
  });

  // Handle edit mode approval button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('approve_edit_mode', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const actor = await resolveInternalActionActor(body, 'edit-mode approval');
    if (!actor) return;
    const userId = actor.id;

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
      const approver = { id: userId, name: actor.info.realName, email: actor.info.email };
      await task.handleEditModeApproval(approver);
    } catch (error) {
      logger.error('Server', 'Error handling edit mode approval', error);
    }
  });

  // Handle edit mode denial button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('deny_edit_mode', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const actor = await resolveInternalActionActor(body, 'edit-mode denial');
    if (!actor) return;
    const userId = actor.id;

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

  // Handle max mode approval button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('approve_max_mode', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const actor = await resolveInternalActionActor(body, 'max-mode approval');
    if (!actor) return;
    const userId = actor.id;

    logger.server(`Max mode approved by ${userId} for task ${taskId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `✅ *Max mode approved* by <@${userId}>`,
          []
        );
      }

      const task = await Task.get(taskId);
      await task.handleMaxModeApproval(actor.info.realName);
    } catch (error) {
      logger.error('Server', 'Error handling max mode approval', error);
    }
  });

  // Handle max mode denial button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('deny_max_mode', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const actor = await resolveInternalActionActor(body, 'max-mode denial');
    if (!actor) return;
    const userId = actor.id;

    logger.server(`Max mode denied by ${userId} for task ${taskId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(
          body.channel.id,
          body.message.ts,
          `❌ *Max mode denied* by <@${userId}>`,
          []
        );
      }

      const task = await Task.get(taskId);
      await task.handleMaxModeDenial();
    } catch (error) {
      logger.error('Server', 'Error handling max mode denial', error);
    }
  });

  // Handle research budget approval button (Defense 4)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('approve_research_budget', async ({ action, ack, body }: any) => {
    await ack();

    const taskId = action.value;
    const actor = await resolveInternalActionActor(body, 'research-budget approval');
    if (!actor) return;
    const userId = actor.id;

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
    const actor = await resolveInternalActionActor(body, 'research-budget denial');
    if (!actor) return;
    const userId = actor.id;

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

  registerMergeActionHandlers(app!);

  // Handle trigger approval button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('approve_trigger', async ({ action, ack, body }: any) => {
    await ack();

    const triggerId = action.value;
    const actor = await resolveInternalActionActor(body, 'trigger approval');
    if (!actor) return;
    const userId = actor.id;
    // The approval prompt was posted into a task thread; that task carries the
    // pending_trigger_id. Find it by the message thread so the same task-level
    // handler (shared with the CLI /approve path) runs.
    const threadId = body.message?.thread_ts || body.message?.ts;

    logger.server(`Trigger ${triggerId} approved by ${userId}`);

    try {
      // Enable first so we have the trigger to describe, then swap the card for a
      // friendly confirmation (the full details also post to the bound channel
      // via the announcement inside handleTriggerApproval).
      const taskId = threadId ? await findTaskByThread(threadId) : null;
      let trigger: import('../../types/trigger.js').Trigger | null = null;
      if (taskId) {
        const task = await Task.get(taskId);
        trigger = await task.handleTriggerApproval(userId, triggerId);
      } else {
        logger.warn('Server', `approve_trigger: no task found for thread ${threadId}; refusing approval because task visibility cannot be verified`);
      }
      if (body.channel?.id && body.message?.ts) {
        const text = trigger
          ? `✅ Approved by <@${userId}> — *${triggerWhat(trigger)}* is now on.`
          : `⚠️ Approved by <@${userId}>, but the automation couldn't be enabled (it may already be active or a limit was reached).`;
        await updateMessage(body.channel.id, body.message.ts, text, []);
      }
    } catch (error) {
      logger.error('Server', 'Error handling trigger approval', error);
    }
  });

  // Handle trigger denial button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app!.action('deny_trigger', async ({ action, ack, body }: any) => {
    await ack();

    const triggerId = action.value;
    const actor = await resolveInternalActionActor(body, 'trigger denial');
    if (!actor) return;
    const userId = actor.id;
    const threadId = body.message?.thread_ts || body.message?.ts;

    logger.server(`Trigger ${triggerId} denied by ${userId}`);

    try {
      if (body.channel?.id && body.message?.ts) {
        await updateMessage(body.channel.id, body.message.ts, `❌ Declined by <@${userId}> — no automation was set up.`, []);
      }
      const taskId = threadId ? await findTaskByThread(threadId) : null;
      if (taskId) {
        const task = await Task.get(taskId);
        await task.handleTriggerDenial(triggerId);
      } else {
        const { deleteTrigger } = await import('../../system/trigger-store.js');
        await deleteTrigger(triggerId);
      }
    } catch (error) {
      logger.error('Server', 'Error handling trigger denial', error);
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

/** Parse a merge-button value (`<taskId>|<github>#<pr_number>`) into the task id + expected PR identity. */
function parseMergeButtonValue(value: string): { taskId: string; expected: { github: string; pr_number: number } } {
  const pipe = value.indexOf('|');
  const taskId = value.slice(0, pipe);
  const prRef = value.slice(pipe + 1);
  const hash = prRef.lastIndexOf('#');
  return {
    taskId,
    expected: { github: prRef.slice(0, hash), pr_number: Number(prRef.slice(hash + 1)) },
  };
}

const STALE_MERGE_PROMPT_TEXT =
  '⚠️ This merge prompt is stale — the pending request changed or was already resolved. Nothing was merged.';

/**
 * Register the merge approve/deny button handlers.
 *
 * Mirrors the edit-mode pair with one deliberate ordering change: the in-place
 * message update happens *after* the Task method, driven by its returned
 * disposition. The handlers do no slot verification of their own — the Task
 * method's atomic read-compare-clear is the single verification point, and a
 * handler-side verify-then-await would reopen the supersede race.
 *
 * Exported for tests, which pass a fake Bolt app recording `.action`
 * registrations; production registration happens in mountSlackApp.
 */
export function registerMergeActionHandlers(boltApp: Pick<AppType, 'action'>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boltApp.action('approve_merge', async ({ action, ack, body }: any) => {
    await ack();

    const { taskId, expected } = parseMergeButtonValue(String(action.value ?? ''));
    const actor = await resolveInternalActionActor(body, 'merge approval');
    if (!actor) return;
    const userId = actor.id;

    logger.server(`Merge approved by ${userId} for task ${taskId} (${expected.github}#${expected.pr_number})`);

    try {
      const task = await Task.get(taskId);
      const approver = { id: userId, name: actor.info.realName, email: actor.info.email };

      const disposition = await task.handleMergeApproval(approver, expected);

      if (body.channel?.id && body.message?.ts) {
        const text = disposition === 'resolved'
          ? `✅ *Merge approved* by <@${userId}>`
          : STALE_MERGE_PROMPT_TEXT;
        await updateMessage(body.channel.id, body.message.ts, text, []);
      }
    } catch (error) {
      logger.error('Server', 'Error handling merge approval', error);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boltApp.action('deny_merge', async ({ action, ack, body }: any) => {
    await ack();

    const { taskId, expected } = parseMergeButtonValue(String(action.value ?? ''));
    const actor = await resolveInternalActionActor(body, 'merge denial');
    if (!actor) return;
    const userId = actor.id;

    logger.server(`Merge denied by ${userId} for task ${taskId} (${expected.github}#${expected.pr_number})`);

    try {
      const task = await Task.get(taskId);
      const disposition = await task.handleMergeDenial(expected);

      if (body.channel?.id && body.message?.ts) {
        const text = disposition === 'resolved'
          ? `❌ *Merge denied* by <@${userId}>`
          : STALE_MERGE_PROMPT_TEXT;
        await updateMessage(body.channel.id, body.message.ts, text, []);
      }
    } catch (error) {
      logger.error('Server', 'Error handling merge denial', error);
    }
  });
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
  user?: string;
  type: string;
}): SlackRouteResult {
  const ourBotId = getBotId();
  if (event.bot_id && ourBotId && event.bot_id === ourBotId) {
    return { action: 'discard', reason: 'Own bot message' };
  }

  // Also discard anything Slack attributes to our own bot USER rather than to a `bot_id`. This is insurance, and it has no known reachable path today: everything Archie posts goes through `postSlackMessage` with the bot token, so it carries our `bot_id` and the check above already catches it, and the canvas and pin scans are read-only (no `pins.add`, no `canvases.create`, no `conversations.setTopic` anywhere in this codebase). The reason to keep it anyway is that the cost is one comparison and the failure mode is a feedback loop: `handleSlackEvent` refreshes the canvas and pin index, so the day any of those paths starts writing, a filterless trigger in a watched channel would fire on Archie's own housekeeping and each firing would refresh again.
  const ourBotUserId = getBotUserId();
  if (event.user && ourBotUserId && event.user === ourBotUserId) {
    return { action: 'discard', reason: 'Own bot user message' };
  }

  return { action: 'triage' };
}

// ============================================================================
// Slack Event Handler
// ============================================================================

export async function handleSlackEvent(event: {
  type: string;
  channel: string;
  user?: string;
  text?: string;
  raw?: unknown;
  ts: string;
  thread_ts?: string;
}): Promise<void> {
  const threadId = event.thread_ts || event.ts;
  // Key under which this thread is (or will be) linked in task.metadata.channels.
  const channelKey = `slack:${event.channel}:${threadId}`;

  // ---- External-author bail-out --------------------------------------------
  // Human-authored events proceed only for verified internal users. Authorless
  // app posts are allowed only into the ambient channel-trigger path below,
  // which performs its own workspace gate before rendering their content.
  if (event.user) {
    try {
      const authorInfo = await getUserInfo(event.user);
      const identity = classifySlackIdentity(authorInfo);
      if (identity !== 'internal') {
        logger.system(`Skipping event from ${identity} user ${event.user}`);
        return;
      }
    } catch (error) {
      logger.warn('Slack', `Failed to classify event author ${event.user}`, error);
      return;
    }
  } else if (event.type !== 'message' || event.channel.startsWith('D') || event.thread_ts) {
    logger.warn('Slack', 'Skipping task-directed event without an author');
    return;
  }

  // Resolve channel confidentiality before any ingress side effect. A failed
  // lookup must not be converted into a durable private classification for a
  // channel that may actually be public.
  const thread = await fetchSlackThread(event.channel, threadId, event.ts);

  // Instant acknowledgment — react before any LLM processing. Only @mentions
  // and DM messages are acknowledged; plain thread replies in an engaged channel
  // are not. Moving the ack (clearing it from the previously-acked message)
  // and recording which message holds it is done via `task.ackMessage` once we
  // have a task in hand — see below — so the bookkeeping survives follow-up
  // messages.
  const isAckable = isAckableEvent(event.type, event.channel);
  if (isAckable) {
    addReaction(event.channel, event.ts, 'eyes');
  }

  const shared = thread.shared;

  // Refresh the channel's "Archie" project-context canvas before the PM wakes,
  // so the spawn-time injection reads fresh state. No-op for DMs and TTL-bounded.
  // Runs after the external-author bail-out above, so a purely-external trigger
  // never causes a scan. Never throws.
  //
  // The pinned-messages index is refreshed on exactly the same terms: before the PM wakes, no-op for DMs, TTL-bounded, after the external-author bail-out above so a purely-external trigger never causes a scan, and never throws.
  await Promise.all([ensureChannelCanvas(event.channel), ensureChannelPins(event.channel)]);

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
    if (!(await task.append(thread))) {
      logger.warn('Slack', `Stopped ingesting thread ${threadId} at an author whose identity could not be verified`);
      return;
    }
    if (isAckable) task.ackMessage(channelKey, event.ts);
    if (!task.metadata.title) {
      generateTitleAndSync(task, thread).catch((err) =>
        logger.warn('title-generator', `pipeline failed: ${err}`),
      );
    }
    await sendSharedChannelWarnings(task, event.channel, threadId, thread, shared);
    await task.sendMessage(AGENT_PROMPTS.existingTask);
  } else if (shouldCreateNewTask(event.type, event.channel, thread.rootAuthorWasBot) && thread.messages.length > 0) {
    logger.system(`Processing #${thread.channel.name} (thread: ${threadId})`);

    // Start a new task when: the bot was @mentioned, this is a DM, OR a human is
    // replying to a thread Archie itself started (a top-level post it made via the
    // post_to_channel explore tool). A reply inside a human-started thread never
    // lands here — its root author isn't the bot — so it stays ignored, as before.
    //
    // The `thread.messages.length > 0` conjunct is a content floor on TASK CREATION specifically. Inverting the subtype gate to a denylist deliberately forwards subtypes nobody enumerated, which is what fixes the trigger arm, but this branch spends a PM turn: a payload with no author and no body (an assistant-container notice, a `tombstone`, a `bot_add`) otherwise reached `Task.create()` and woke the PM on an empty knowledge log. Checking the fetched thread rather than the subtype keeps that robust — any future subtype carrying nothing is refused for the same reason, with no list to maintain.
    //
    // It is deliberately NOT applied to the trigger branch below. That path renders from the raw event, not from the fetched thread, precisely because `fetchSlackThread` drops a message with neither a `user` nor a `botId` — gating it on `thread.messages` would reintroduce the very blindness this change removes.
    const task = await Task.create(thread.taskVisibility);
    if (!(await task.append(thread))) {
      logger.warn('Slack', `Stopped ingesting new thread ${threadId} at an author whose identity could not be verified`);
      return;
    }
    // Ack the triggering message. For @mention/DM the :eyes: was already added
    // before the thread fetch; for a reply to a bot-started thread, add it now.
    if (!isAckable && thread.rootAuthorWasBot) addReaction(event.channel, event.ts, 'eyes');
    if (isAckable || thread.rootAuthorWasBot) task.ackMessage(channelKey, event.ts);
    if (!task.metadata.title) {
      generateTitleAndSync(task, thread).catch((err) =>
        logger.warn('title-generator', `pipeline failed: ${err}`),
      );
    }
    await sendSharedChannelWarnings(task, event.channel, threadId, thread, shared);
    await task.sendMessage(AGENT_PROMPTS.newTask);
  } else if (event.type === 'message' && !event.channel.startsWith('D') && !event.thread_ts) {
    // Ambient top-level channel message (no task, not an @mention, not a thread
    // reply) — the only place channel-message triggers fire. @mentions and DMs
    // are excluded above so a message aimed at Archie never also fires a trigger.
    await dispatchChannelMessageTriggers(event, thread.channel.name, thread);
  }
  // Otherwise: a reply in a human-started thread the bot wasn't part of — ignore
}

/**
 * Fire any channel-message triggers watching this channel whose filter matches
 * the message. Each match spawns an independent read-only task that replies in
 * the triggering thread. External authors are already filtered upstream.
 *
 * The filter is matched against the *rendered* body — the same text an agent would be shown — not against the raw event's top-level `text`. That distinction is the whole point: a webhook or app post carries an empty `text` with all of its content in `attachments`/`blocks`, so matching the raw field made every such post invisible to `contains` filters. `rawMessageBody` runs the payload through the full inbound extraction, so blocks, attachment cards and files all become matchable.
 *
 * There is deliberately no fallback to the raw text and no re-fetch of the message by `ts`: a fallback would silently restore the original bug on exactly the payloads it was meant to fix, and a thread re-fetch can't see a message that has neither a `user` nor a `botId` anyway. If extraction yields an empty body, an empty body is what the filter sees.
 */
async function dispatchChannelMessageTriggers(
  event: { channel: string; user?: string; ts: string; raw?: unknown },
  channelName: string,
  thread: SlackThread,
): Promise<void> {
  const triggers = getChannelMessageTriggers(event.channel);
  if (triggers.length === 0) return;

  // An app post from ANOTHER workspace never fires a trigger. The external-author bail-out earlier in
  // `handleSlackEvent` is guarded by `if (event.user)`, and an app post carries no `user`, so it is not
  // classified there; and this path renders from the raw event rather than the fetched thread, so
  // `fetchSlackThread`'s own external-bot filter never sees it either. Before app posts were forwarded at
  // all, the subtype allowlist closed this by accident. Now that they are forwarded deliberately, the gate
  // has to be explicit — and it mirrors the rule thread ingestion and the pin index already draw (drop a
  // bot from a foreign team, keep internal bots) rather than inventing a stricter one.
  const raw = event.raw as { bot_id?: string; team?: string; bot_profile?: { team_id?: string } } | null | undefined;
  if (raw?.bot_id) {
    const botTeamId = raw.bot_profile?.team_id || raw.team;
    if (isExternalUser({ teamId: botTeamId })) {
      logger.system(`Skipping channel-message triggers for an app post from another workspace in ${channelName} (bot ${raw.bot_id}, team ${botTeamId})`);
      return;
    }
  }

  // Rendered once, after the no-triggers short-circuit above: a channel nobody
  // is watching must stay free, and extraction resolves mentions (a network
  // read) so it is not free.
  const body = await rawMessageBody(event.raw, event.channel);

  const matches = (trigger: Trigger): boolean =>
    trigger.conditions.some((c) => {
      if (c.type !== 'channel_message' || c.channel_id !== event.channel) return false;
      if (c.match?.contains && !body.toLowerCase().includes(c.match.contains.toLowerCase())) return false;
      if (c.match?.from_user && event.user !== c.match.from_user) return false;
      return true;
    });

  for (const trigger of triggers) {
    if (!matches(trigger)) continue;
    try {
      await fireTrigger(trigger, {
        kind: 'message',
        thread,
        body,
        authorId: event.user || raw?.bot_id || undefined,
        channelName,
      });
    } catch (err) {
      logger.error('Slack', `Failed to fire channel-message trigger ${trigger.id}`, err);
    }
  }
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
export async function handleSlackEdit(event: any): Promise<void> {
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

  // Author resolution is fail closed: edits require verified internal identity.
  let authorInfo: Awaited<ReturnType<typeof getUserInfo>>;
  try {
    authorInfo = await getUserInfo(msg.user);
    const identity = classifySlackIdentity(authorInfo);
    if (identity !== 'internal') {
      logger.system(`Skipping edit from ${identity} user ${msg.user}`);
      return;
    }
  } catch (error) {
    logger.warn('Slack', `Failed to classify edit author ${msg.user}`, error);
    return;
  }

  // Run the edited message through the same extraction as any other inbound
  // message — blocks, attachment cards, link chips, entity decoding — not just
  // mention resolution. Editing a message to add a Jira link used to log the
  // raw `<url|label>` mrkdwn while the identical link posted fresh logged as
  // `label (url)`, and anything carried in `blocks` was lost on the edit path.
  // Only the new text is logged — the pre-edit text already lives in the log
  // under the same `msg:<ts>` id.
  const newText = await rawMessageBody(msg, channelId);
  const author: SlackAuthor = {
    id: msg.user,
    username: authorInfo.name,
    realName: authorInfo.realName,
    teamId: authorInfo.teamId,
    isRestricted: authorInfo.isRestricted,
    isUltraRestricted: authorInfo.isUltraRestricted,
    isBot: authorInfo.isBot,
    isAppUser: authorInfo.isAppUser,
  };

  let sourceVisibility: SlackThread['taskVisibility'];
  try {
    sourceVisibility = (await fetchChannelIsPrivate(channelId)) ? 'private' : 'public';
  } catch (error) {
    logger.warn('Slack', `Skipping edit because channel privacy could not be verified for ${channelId}`, error);
    return;
  }

  const task = await Task.get(taskId);
  const channelKey = `slack:${channelId}:${threadId}`;
  const channel = task.metadata.channels[channelKey];

  // Respect mute — a muted channel isn't woken by edits either.
  if (channel?.type === 'slack' && channel.muted) {
    logger.system(`Skipping edit in muted channel ${threadId}`);
    return;
  }
  const recorded = await task.appendSlackEdit(channelKey, author, editedTs, newText, sourceVisibility);
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

  // Snapshot isShared for observability and the PM's disclosure warning.
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
    if (classifySlackIdentity(msg.user) !== 'internal') continue;
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
      (att) => att.author && classifySlackIdentity(att.author) !== 'internal',
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
