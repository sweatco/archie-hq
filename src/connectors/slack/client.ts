/**
 * Slack Client
 *
 * Wrapper around Slack API for posting messages, fetching thread history,
 * and handling webhooks.
 */

import { WebClient } from '@slack/web-api';
import type { SlackThreadRef, SlackFile, SlackThread, SlackThreadMessage, SlackAuthor, SlackAttachment, SlackReaction } from '../../types/index.js';
import type { PrCardData } from '../../types/task.js';
import { prCardSubtitle, SLACK_PR_CARD_EMOJI } from '../../system/pr-card-format.js';

/**
 * Internal raw shape produced by `fetchThreadHistory`. Carries the unresolved
 * top-level `user` ID; attachment authors are already resolved to SlackAuthor.
 * Only consumed by `fetchSlackThread`, which resolves the top-level user and
 * returns the public `SlackThreadMessage`. Not exported.
 */
interface RawSlackMessage {
  /** Author's user ID. Empty string when the message was posted by an app/bot. */
  user: string;
  text: string;
  ts: string;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  /** Slack-assigned bot identity when the message was posted by an app/bot. */
  botId?: string;
  /** Bot's display name (from bot_profile.name) when posted by an app/bot. */
  botName?: string;
  /** Workspace (team) the message originated from. Used for external-bot filtering. */
  teamId?: string;
  /** Emoji reactions present on the message at fetch time. */
  reactions?: SlackReaction[];
}
import { logger } from '../../system/logger.js';

/**
 * Slack `markdown` block cumulative payload limit (per chat.postMessage).
 * Source: https://docs.slack.dev/reference/block-kit/blocks/markdown-block/
 */
export const SLACK_MARKDOWN_LIMIT = 12000;

/**
 * Thrown when a Slack-bound message exceeds the markdown block character limit.
 * Carries the actual length so tool wrappers can build agent-facing guidance.
 */
export class SlackMarkdownLimitError extends Error {
  readonly actualLength: number;
  readonly limit: number;
  constructor(actualLength: number) {
    super(
      `Slack markdown payload is ${actualLength} chars, exceeds ${SLACK_MARKDOWN_LIMIT} limit.`
    );
    this.name = 'SlackMarkdownLimitError';
    this.actualLength = actualLength;
    this.limit = SLACK_MARKDOWN_LIMIT;
  }
}

/**
 * Throw if `text` exceeds Slack's markdown block character limit.
 * Callers should invoke this BEFORE logging the message anywhere
 * so a rejected payload does not pollute the knowledge log.
 */
export function assertSlackMarkdownLength(text: string): void {
  if (text.length > SLACK_MARKDOWN_LIMIT) {
    throw new SlackMarkdownLimitError(text.length);
  }
}

/**
 * Build a single Slack `markdown` block carrying CommonMark text.
 * Slack renders it natively (tables, code, lists) — no legacy mrkdwn conversion.
 */
function markdownBlock(text: string): unknown[] {
  return [{ type: 'markdown', text }];
}

/**
 * Message element shape returned by conversations.history / conversations.replies.
 * Derived from the WebClient method type to avoid importing a response type.
 */
type SlackHistoryMessage = NonNullable<Awaited<ReturnType<WebClient['conversations']['history']>>['messages']>[number];

let slackClient: WebClient | null = null;
let botUserId: string | null = null;
let botId: string | null = null;
let workspaceUrl: string | null = null;
let homeTeamId: string | null = null;
let dryRun = false;

/**
 * Enable dry-run mode: receive and process events but suppress all outgoing Slack messages.
 */
export function setSlackDryRun(enabled: boolean): void {
  dryRun = enabled;
}

export function isSlackDryRun(): boolean {
  return dryRun;
}

/**
 * Initialize the Slack client and fetch bot user ID
 */
export async function initSlackClient(token: string): Promise<void> {
  slackClient = new WebClient(token);

  // Fetch bot's user ID and bot ID for filtering bot messages
  try {
    const authResult = await slackClient.auth.test();
    botUserId = authResult.user_id as string;
    botId = authResult.bot_id as string | undefined ?? null;
    workspaceUrl = (authResult.url as string | undefined)?.replace(/\/$/, '') ?? null;
    homeTeamId = (authResult.team_id as string | undefined) ?? null;
    logger.slack(`Bot user ID: ${botUserId}, bot ID: ${botId}, workspace: ${workspaceUrl}, home team: ${homeTeamId}`);
    if (!homeTeamId) {
      logger.warn('Slack', 'auth.test did not return team_id — external-user filtering will fail open (no filtering applied)');
    }
  } catch (error) {
    logger.warn('Slack', 'Failed to get bot user ID', error);
  }
}

/**
 * Get the bot's user ID
 */
export function getBotUserId(): string | null {
  return botUserId;
}

/**
 * Get the bot's bot ID (different from user ID)
 */
export function getBotId(): string | null {
  return botId;
}

/**
 * Get the bot's home Slack workspace team ID (from auth.test).
 * Used as the reference point for classifying users as internal vs external.
 * May be null if auth.test() did not return team_id — in that case external
 * filtering fails open (treats everyone as internal).
 */
export function getHomeTeamId(): string | null {
  return homeTeamId;
}

/**
 * Build a full Slack URL for a thread.
 * Format: https://{workspace}.slack.com/archives/{channel}/p{ts_without_dot}
 * Returns null if workspace URL is not available.
 */
export function buildThreadUrl(channelId: string, threadTs: string): string | null {
  if (!workspaceUrl) return null;
  const tsNoDot = threadTs.replace('.', '');
  return `${workspaceUrl}/archives/${channelId}/p${tsNoDot}`;
}

/**
 * Get the Slack client instance
 */
export function getSlackClient(): WebClient {
  if (!slackClient) {
    throw new Error('Slack client not initialized. Call initSlackClient first.');
  }
  return slackClient;
}

/**
 * Post a Slack message as a `markdown` block.
 *
 * - With `threadTs`: replies inside that thread.
 * - Without `threadTs`: posts a new top-level message; the returned `ts` becomes
 *   the thread root for future replies.
 *
 * Throws `SlackMarkdownLimitError` when `text` exceeds the per-message limit
 * — callers should perform any logging/event emission only AFTER this resolves
 * successfully so rejected payloads are not persisted.
 *
 * Returns `undefined` in dry-run mode.
 */
export async function postSlackMessage(args: {
  channel: string;
  text: string;
  threadTs?: string;
  /**
   * Optional grey footer line rendered as a trailing `context` block beneath the
   * message (e.g. the task id + PM model). Short and plain — not length-checked.
   */
  footer?: string;
}): Promise<string | undefined> {
  const { channel, text, threadTs, footer } = args;
  if (dryRun) {
    const target = threadTs ? `${channel}:${threadTs}` : channel;
    logger.system(`[DRY RUN] postSlackMessage ${target} — ${text.slice(0, 120)}`);
    return undefined;
  }
  const renderedText = restoreMentions(text);
  assertSlackMarkdownLength(renderedText);
  const client = getSlackClient();
  const blocks = markdownBlock(renderedText);
  if (footer) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] });
  }
  const result = await client.chat.postMessage({
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: renderedText,
    blocks: blocks as any,
  });
  return result.ts;
}

/**
 * Upload one or more files via `files.uploadV2`.
 *
 * No accompanying text — uploadV2 does not support the `markdown` block type
 * we use elsewhere, so callers post narrative text via `postSlackMessage`
 * separately (typically immediately before this call to seed a thread root).
 *
 * Returns `undefined` in dry-run mode.
 */
export async function postSlackFiles(args: {
  channel: string;
  threadTs?: string;
  files: { path: string; filename: string }[];
}): Promise<void> {
  const { channel, threadTs, files } = args;
  if (files.length === 0) {
    throw new Error('postSlackFiles called with no files');
  }
  if (dryRun) {
    const target = threadTs ? `${channel}:${threadTs}` : channel;
    const names = files.map((f) => f.filename).join(', ');
    logger.system(`[DRY RUN] postSlackFiles ${target} — ${files.length} file(s): ${names}`);
    return;
  }
  const client = getSlackClient();
  try {
    await client.files.uploadV2({
      channel_id: channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      file_uploads: files.map((f) => ({ file: f.path, filename: f.filename })),
    });
  } catch (uploadErr) {
    const errAny = uploadErr as { code?: string; data?: unknown; message?: string };
    logger.warn(
      'Slack',
      `files.uploadV2 failed channel=${channel} threadTs=${threadTs ?? '-'} files=${files.length} ` +
      `code=${errAny.code ?? 'n/a'} message=${errAny.message ?? 'n/a'} data=${JSON.stringify(errAny.data ?? null)}`,
    );
    throw uploadErr;
  }
}

/**
 * Post an interactive message with blocks to a Slack thread
 * Used for messages with buttons (e.g., edit mode approval)
 */
export async function postInteractiveToThread(
  channel: string,
  threadTs: string,
  text: string,
  blocks: unknown[]
): Promise<string | undefined> {
  if (dryRun) {
    logger.system(`[DRY RUN] postInteractiveToThread ${channel}:${threadTs} — ${text.slice(0, 120)}`);
    return undefined;
  }
  const client = getSlackClient();

  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text, // Fallback text for notifications
    blocks: blocks as any,
  });

  return result.ts;
}

/**
 * Post an interactive message to multiple threads
 */
export async function postInteractiveToThreads(
  threads: SlackThreadRef[],
  text: string,
  blocks: unknown[]
): Promise<void> {
  for (const thread of threads) {
    await postInteractiveToThread(thread.channel_id, thread.thread_id, text, blocks);
  }
}

/**
 * Add an emoji reaction to a message.
 * Failures are silently ignored (duplicate reactions, missing scopes, etc.).
 */
export async function addReaction(channel: string, timestamp: string, emoji: string): Promise<void> {
  if (dryRun) return;
  try {
    const client = getSlackClient();
    await client.reactions.add({ channel, timestamp, name: emoji });
  } catch {
    // Silently ignore — already_reacted, missing scope, etc.
  }
}

/**
 * Remove an emoji reaction from a message.
 * Failures are silently ignored (not_reacted, missing scope, etc.).
 */
export async function removeReaction(channel: string, timestamp: string, emoji: string): Promise<void> {
  if (dryRun) return;
  try {
    const client = getSlackClient();
    await client.reactions.remove({ channel, timestamp, name: emoji });
  } catch {
    // Silently ignore — not_reacted, missing scope, etc.
  }
}

/**
 * Read the current emoji reactions on a single message. Requires the
 * `reactions:read` scope. Returns the live state (unlike the snapshot captured
 * during thread ingest). Returns an empty array on failure or in dry-run.
 */
export async function getMessageReactions(channel: string, timestamp: string): Promise<SlackReaction[]> {
  if (dryRun) return [];
  try {
    const client = getSlackClient();
    // `full: true` returns the complete user list per reaction (not truncated).
    const result = await client.reactions.get({ channel, timestamp, full: true });
    const message = result.message as { reactions?: Array<{ name?: string; count?: number; users?: string[] }> } | undefined;
    const raw = message?.reactions;
    if (!raw || !Array.isArray(raw)) return [];

    // Resolve reacting user IDs to names so the agent knows WHO reacted —
    // identity is the point when a reaction is a signal/vote. We use the cached
    // workspace user list: it covers everyone we care about (the internal team).
    // External/Connect users, bots, and deactivated accounts aren't listed and
    // surface as their raw ID — fine here, and consistent with how we leave
    // external participants unresolved elsewhere.
    const nameById = new Map((await listWorkspaceUsers()).map((u) => [u.id, u.realName]));
    return raw
      .filter((r): r is { name: string; count?: number; users?: string[] } => typeof r.name === 'string')
      .map((r) => {
        const users = (r.users ?? []).map((uid) => nameById.get(uid) ?? uid);
        return { name: r.name, count: r.count ?? 0, ...(users.length > 0 ? { users } : {}) };
      });
  } catch {
    // Silently ignore — message not found, missing scope, etc.
    return [];
  }
}

/**
 * Update an existing message (e.g., to remove buttons after action)
 */
export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  blocks?: unknown[]
): Promise<void> {
  if (dryRun) {
    logger.system(`[DRY RUN] updateMessage ${channel}:${ts} — ${text.slice(0, 120)}`);
    return;
  }
  const client = getSlackClient();

  await client.chat.update({
    channel,
    ts,
    text,
    blocks: blocks as any,
  });
}

/**
 * Delete a message by timestamp. Used to drop a stale PR card before reposting
 * a fresh one at the bottom of the thread. Best-effort — swallows errors
 * (message already gone, missing scope, etc.) so a failed delete never blocks
 * the repost.
 */
export async function deleteMessage(channel: string, ts: string): Promise<void> {
  if (dryRun) {
    logger.system(`[DRY RUN] deleteMessage ${channel}:${ts}`);
    return;
  }
  try {
    const client = getSlackClient();
    await client.chat.delete({ channel, ts });
  } catch (error) {
    logger.warn('Slack', `Failed to delete message ${channel}:${ts}`, error);
  }
}

/**
 * Build the Block Kit `card` block for a PR card: a title row (`#number` linked
 * to the PR, then the head branch) and a subtitle (`repo · CI summary`, or the
 * merged/closed state). Subtitle text is shared with the CLI via
 * `pr-card-format`; here it uses Slack emoji shortcodes.
 */
export function buildPrCardBlocks(card: PrCardData): unknown[] {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    {
      type: 'card',
      title: { type: 'mrkdwn', text: `<${card.url}|#${card.prNumber}> ${escape(card.headRef)}` },
      subtitle: { type: 'mrkdwn', text: prCardSubtitle(card, SLACK_PR_CARD_EMOJI) },
    },
  ];
}

/**
 * Helper: Fetch user, group, and channel info for all mentions in messages
 * Returns maps that can be used to replace IDs with names
 */
async function fetchMentionInfo(
  messages: Array<{ text: string }>,
  channelIds: Set<string> = new Set()
): Promise<{
  userInfoMap: Map<string, { name: string; realName: string }>;
  groupInfoMap: Map<string, string>;
  channelInfoMap: Map<string, string>;
}> {
  const client = getSlackClient();

  // Collect all unique user and group IDs
  const userIds = new Set<string>();
  const groupIds = new Set<string>();

  for (const msg of messages) {
    const text = msg.text;

    // Extract user IDs: <@U123>
    const userMatches = text.matchAll(/<@([A-Z0-9]+)>/g);
    for (const match of userMatches) userIds.add(match[1]);

    // Extract group IDs: <!subteam^S123>
    const groupMatches = text.matchAll(/<!subteam\^([A-Z0-9]+)/g);
    for (const match of groupMatches) groupIds.add(match[1]);

    // Extract channel IDs: <#C123|channel-name>
    const channelMatches = text.matchAll(/<#([A-Z0-9]+)/g);
    for (const match of channelMatches) channelIds.add(match[1]);
  }

  // Batch fetch user info
  const userInfoMap = new Map<string, { name: string; realName: string }>();
  if (userIds.size > 0) {
    await Promise.all(
      Array.from(userIds).map(async (userId) => {
        try {
          const info = await getUserInfo(userId);
          userInfoMap.set(userId, info);
        } catch (error) {
          logger.warn('Slack', `Failed to get user info for ${userId}`);
        }
      })
    );
  }

  // Fetch group info
  const groupInfoMap = new Map<string, string>();
  if (groupIds.size > 0) {
    try {
      const groupsResult = await client.usergroups.list({ include_users: false });
      if (groupsResult.usergroups) {
        for (const group of groupsResult.usergroups) {
          if (group.id) {
            groupInfoMap.set(group.id, group.handle || group.name || group.id);
          }
        }
      }
    } catch (error) {
      logger.warn('Slack', 'Failed to fetch usergroups', error);
    }
  }

  // Batch fetch channel info
  const channelInfoMap = new Map<string, string>();
  if (channelIds.size > 0) {
    await Promise.all(
      Array.from(channelIds).map(async (channelId) => {
        try {
          const channelResult = await client.conversations.info({ channel: channelId });
          const channelName = channelResult.channel?.name || channelId;
          channelInfoMap.set(channelId, channelName);
        } catch (error) {
          logger.warn('Slack', `Failed to get channel info for ${channelId}`);
        }
      })
    );
  }

  return { userInfoMap, groupInfoMap, channelInfoMap };
}

/**
 * Restore the internal `<@ID:Name>` mention marker to Slack's `<@ID>` syntax for
 * outgoing messages, so Slack renders a real mention and notifies the user.
 *
 * Agents see users as `<@U123:John Smith>` in conversation history (Slack-native
 * bracket order, matching the model's instinct) and are taught to reproduce that.
 * We also accept the legacy `@<U123:John Smith>` order that older logs and the
 * model's occasional drift still produce. Either way the `:Name` is invalid Slack
 * syntax (Slack uses `<@ID>` or `<@ID|Name>` with a pipe, never `:Name`) — if it
 * reached Slack unconverted it renders as raw literal text (observed:
 * task-20260708-1144-wvnrnz). Strip the `:Name` from both orders. The required
 * `:[^>]+` means an already-valid `<@ID>` (no name) is left untouched.
 */
export function restoreMentions(text: string): string {
  return text.replace(/(?:@<|<@)([A-Z0-9]+):[^>]+>/g, '<@$1>');
}

/**
 * Apply mention replacements to text
 */
function applyMentionReplacements(
  text: string,
  userInfoMap: Map<string, { name: string; realName: string }>,
  groupInfoMap: Map<string, string>,
  channelInfoMap: Map<string, string>
): string {
  let result = text;

  // Replace user mentions <@U123> with the agent-facing <@U123:Real Name> — the
  // Slack-native bracket order (matches the model's instinct; restoreMentions
  // strips the name back to <@U123> on the way out).
  result = result.replace(/<@([A-Z0-9]+)>/g, (match, userId) => {
    const userInfo = userInfoMap.get(userId);
    return userInfo ? `<@${userId}:${userInfo.realName}>` : match;
  });

  // Replace group mentions <!subteam^S123|@name> with @<S123:group-name>
  result = result.replace(/<!subteam\^([A-Z0-9]+)(\|[^>]+)?>/g, (match, groupId) => {
    const groupName = groupInfoMap.get(groupId);
    return groupName ? `@<${groupId}:${groupName}>` : match;
  });

  // Replace channel mentions <#C123|channel-name> with #<C123:channel-name>
  result = result.replace(/<#([A-Z0-9]+)(\|[^>]+)?>/g, (match, channelId) => {
    const channelName = channelInfoMap.get(channelId);
    return channelName ? `#<${channelId}:${channelName}>` : match;
  });

  return result;
}

/**
 * Fetch thread history from Slack with mentions replaced.
 *
 * Returns the internal raw shape; consumers should use `fetchSlackThread`
 * which resolves authors and packages everything into a `SlackThread`.
 */
async function fetchThreadHistory(
  channel: string,
  threadTs: string,
  oldest?: string
): Promise<RawSlackMessage[]> {
  const client = getSlackClient();

  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    oldest,
    inclusive: oldest ? false : true,
  });

  return resolveRawMessages(result.messages ?? [], channel);
}

/**
 * Resolve raw Slack message elements (from conversations.replies OR
 * conversations.history) into RawSlackMessage[]: extract text from
 * blocks/files/attachments, resolve mentions, and surface bot identity +
 * reactions. Author resolution into SlackAuthor happens later
 * (resolveAuthorsAndMap / fetchSlackThread). Order is preserved, so the caller
 * controls chronology (history is newest-first and must be reversed first).
 */
async function resolveRawMessages(
  rawMessages: SlackHistoryMessage[],
  channel: string,
): Promise<RawSlackMessage[]> {
  if (rawMessages.length === 0) {
    return [];
  }

  // Intermediate shape: we extract authorId here; the public SlackAttachment
  // exposes a fully resolved SlackAuthor — resolution happens after this loop.
  interface RawAttachment { authorId?: string; text: string }

  // Extract a message into the forwarder's own text plus a list of structured
  // attachments. Each attachment carries its own text and the original
  // author's user ID when Slack provides one. Keeping author+text correlated
  // per attachment lets downstream code redact / label individual attachments.
  const extractMessageParts = (msg: SlackHistoryMessage): {
    ownText: string;
    attachments: RawAttachment[];
  } => {
    const ownParts: string[] = [];

    // Slack delivers the same body in two places: structured `blocks`
    // (rich_text / Block Kit) and a plain-text `text` field (legacy fallback
    // for clients that can't render blocks). Prefer the structured form when
    // present; otherwise fall back to `text`.
    const blocks = msg.blocks as Array<{
      type: string;
      text?: { text?: string };
      elements?: Array<unknown>;
    }> | undefined;
    let consumedTopBlocks = false;

    if (blocks && Array.isArray(blocks)) {
      for (const block of blocks) {
        const blockText = extractBlockText(block);
        if (blockText && !ownParts.includes(blockText)) {
          ownParts.push(blockText);
          consumedTopBlocks = true;
        }
      }
    }

    if (!consumedTopBlocks && msg.text) {
      ownParts.push(msg.text);
    }

    // Files (file shares) — appended to ownText since they belong to the
    // top-level message, not to an attachment.
    const files = msg.files as Array<{ name?: string; title?: string }> | undefined;
    if (files && Array.isArray(files)) {
      const fileDescriptions = files
        .map(f => f.title || f.name)
        .filter(Boolean);
      if (fileDescriptions.length > 0) {
        ownParts.push(`[Files: ${fileDescriptions.join(', ')}]`);
      }
    }

    // Attachments (forwarded messages, shared content, unfurls). Each entry
    // becomes one SlackAttachment with its author + text correlated.
    const rawAttachments = msg.attachments as Array<{
      author_id?: string;
      text?: string;
      fallback?: string;
      pretext?: string;
      title?: string;
      message_blocks?: Array<{ message?: { user?: string; blocks?: Array<unknown> } }>;
    }> | undefined;

    const attachments: RawAttachment[] = [];
    if (rawAttachments && Array.isArray(rawAttachments)) {
      for (const att of rawAttachments) {
        // Prefer structured message_blocks; skip text/fallback when present to
        // avoid duplicating the same content.
        const seg: string[] = [];
        let authorId = att.author_id;
        let consumedFromBlocks = false;
        if (att.message_blocks) {
          for (const mb of att.message_blocks) {
            if (mb.message?.user && !authorId) authorId = mb.message.user;
            if (mb.message?.blocks) {
              for (const block of mb.message.blocks) {
                const blockText = extractBlockText(block as { type: string; elements?: Array<unknown> });
                if (blockText && !seg.includes(blockText)) {
                  seg.push(blockText);
                  consumedFromBlocks = true;
                }
              }
            }
          }
        }

        if (!consumedFromBlocks) {
          const attText = att.text || att.fallback;
          if (attText && !seg.includes(attText)) seg.push(attText);
        }

        const text = seg.join('\n');
        if (text || authorId) {
          attachments.push({ ...(authorId ? { authorId } : {}), text });
        }
      }
    }

    return {
      ownText: ownParts.join('\n'),
      attachments,
    };
  };

  /**
   * Extract text from a Block Kit block (handles rich_text, section, etc.)
   */
  const extractBlockText = (block: { type: string; text?: { text?: string }; elements?: Array<unknown> }): string => {
    if (!block) return '';

    switch (block.type) {
      case 'rich_text':
        // rich_text blocks have nested elements (sections, lists, quotes, etc.)
        return extractRichTextElements(block.elements || []);

      case 'section':
        // Section blocks have a text field
        return block.text?.text || '';

      case 'header':
        // Header blocks have a text field
        return block.text?.text || '';

      case 'context':
        // Context blocks have elements array with text/image objects
        if (block.elements) {
          return block.elements
            .map((el: unknown) => {
              const element = el as { type?: string; text?: string };
              return element.type === 'mrkdwn' || element.type === 'plain_text' ? element.text : '';
            })
            .filter(Boolean)
            .join(' ');
        }
        return '';

      default:
        return '';
    }
  };

  /**
   * Extract text from rich_text elements recursively
   */
  const extractRichTextElements = (elements: Array<unknown>): string => {
    const parts: string[] = [];

    for (const element of elements) {
      const el = element as {
        type: string;
        elements?: Array<unknown>;
        text?: string;
        user_id?: string;
        channel_id?: string;
        name?: string;
        url?: string;
        style?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };
      };

      switch (el.type) {
        case 'rich_text_section':
        case 'rich_text_preformatted':
        case 'rich_text_quote':
          // These contain nested elements
          if (el.elements) {
            const sectionText = extractRichTextElements(el.elements);
            if (el.type === 'rich_text_quote') {
              parts.push(`> ${sectionText}`);
            } else if (el.type === 'rich_text_preformatted') {
              parts.push(`\`\`\`${sectionText}\`\`\``);
            } else {
              parts.push(sectionText);
            }
          }
          break;

        case 'rich_text_list':
          // Lists have elements that are list items
          if (el.elements) {
            const listStyle = (el as { style?: string }).style;
            const items = el.elements.map((item, idx) => {
              const itemText = extractRichTextElements([item]);
              const bullet = listStyle === 'ordered' ? `${idx + 1}.` : '•';
              return `${bullet} ${itemText}`;
            });
            parts.push(items.join('\n'));
          }
          break;

        case 'text':
          // Plain text element
          parts.push(el.text || '');
          break;

        case 'user':
          // User mention
          parts.push(`<@${el.user_id}>`);
          break;

        case 'channel':
          // Channel mention
          parts.push(`<#${el.channel_id}>`);
          break;

        case 'emoji':
          // Emoji
          parts.push(`:${el.name}:`);
          break;

        case 'link':
          // URL link
          parts.push(el.url || '');
          break;

        case 'usergroup':
          // User group mention
          parts.push(`<!subteam^${(el as { usergroup_id?: string }).usergroup_id}>`);
          break;

        case 'broadcast':
          // @here, @channel, @everyone
          parts.push(`<!${(el as { range?: string }).range}>`);
          break;
      }
    }

    return parts.join('');
  };

  // Batch fetch user/group/channel info for all messages.
  // For mention extraction we just need every text segment we'll surface,
  // so concatenate ownText and all attachment texts into one blob.
  const messages = rawMessages.map((m) => {
    const { ownText, attachments } = extractMessageParts(m);
    return {
      text: [ownText, ...attachments.map((a) => a.text)].filter(Boolean).join('\n'),
    };
  });
  const channelIds = new Set([channel]); // Include the thread's channel
  const { userInfoMap, groupInfoMap, channelInfoMap } = await fetchMentionInfo(messages, channelIds);

  // Extract files from a message (including from attachments/forwarded messages)
  const extractFiles = (msg: SlackHistoryMessage): SlackFile[] | undefined => {
    const allFiles: SlackFile[] = [];

    // Helper to process a files array
    const processFiles = (files: Array<{
      id?: string;
      name?: string;
      mimetype?: string;
      url_private?: string;
      url_private_download?: string;
    }> | undefined) => {
      if (!files || !Array.isArray(files)) return;
      for (const f of files) {
        // Prefer url_private_download for API downloads (works with Bearer token)
        // Fall back to url_private if download URL not available
        if (f.id && (f.url_private_download || f.url_private)) {
          allFiles.push({
            id: f.id,
            name: f.name || 'unnamed',
            mimetype: f.mimetype || 'application/octet-stream',
            url_private: f.url_private || f.url_private_download!,
            url_private_download: f.url_private_download,
          });
        }
      }
    };

    // 1. Top-level files (direct file shares)
    processFiles(msg.files as Array<{ id?: string; name?: string; mimetype?: string; url_private?: string; url_private_download?: string }> | undefined);

    // 2. Files inside attachments (forwarded messages)
    const attachments = msg.attachments as Array<{
      files?: Array<{ id?: string; name?: string; mimetype?: string; url_private?: string; url_private_download?: string }>;
      image_url?: string;
      thumb_url?: string;
      fallback?: string;
      id?: number;
    }> | undefined;

    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        // Files nested in attachment
        processFiles(att.files);

        // Some attachments have image_url directly (e.g., unfurled links, image shares)
        if (att.image_url) {
          allFiles.push({
            id: `att-${att.id || Date.now()}`,
            name: att.fallback || 'image',
            mimetype: 'image/unknown',
            url_private: att.image_url,
          });
        }
      }
    }

    return allFiles.length > 0 ? allFiles : undefined;
  };

  // Extract emoji reactions Slack attaches to each message. Slack delivers them
  // as `{ name, count, users }`; we keep just name + count for the snapshot.
  const extractReactions = (msg: SlackHistoryMessage): SlackReaction[] => {
    const raw = (msg as { reactions?: Array<{ name?: string; count?: number }> }).reactions;
    if (!raw || !Array.isArray(raw)) return [];
    return raw
      .filter((r): r is { name: string; count?: number } => typeof r.name === 'string')
      .map((r) => ({ name: r.name, count: r.count ?? 0 }));
  };

  // Resolve attachment authors to SlackAuthor objects up-front so each
  // attachment carries its full author info (name, team, restriction flags).
  const extractedPerMessage = rawMessages.map((m) => extractMessageParts(m));
  const attachmentAuthorIds = new Set<string>();
  for (const { attachments } of extractedPerMessage) {
    for (const att of attachments) {
      if (att.authorId) attachmentAuthorIds.add(att.authorId);
    }
  }
  const authorEntries = await Promise.all(
    Array.from(attachmentAuthorIds).map(async (uid): Promise<readonly [string, SlackAuthor | null]> => {
      try {
        const info = await getUserInfo(uid);
        return [uid, {
          id: uid,
          username: info.name,
          realName: info.realName,
          teamId: info.teamId,
          isRestricted: info.isRestricted,
          isUltraRestricted: info.isUltraRestricted,
        }];
      } catch {
        return [uid, null];
      }
    })
  );
  const authorMap = new Map(authorEntries);

  // Apply replacements to all messages
  return rawMessages.map((msg, i) => {
    const files = extractFiles(msg);
    const { ownText, attachments } = extractedPerMessage[i];
    const resolvedAttachments: SlackAttachment[] = attachments.map((a) => {
      const author = a.authorId ? authorMap.get(a.authorId) ?? undefined : undefined;
      return {
        ...(author ? { author } : {}),
        text: applyMentionReplacements(a.text, userInfoMap, groupInfoMap, channelInfoMap),
      };
    });
    const rawMsg = msg as typeof msg & {
      bot_id?: string;
      bot_profile?: { id?: string; name?: string; team_id?: string };
      team?: string;
    };
    const botId = rawMsg.bot_id;
    const botName = rawMsg.bot_profile?.name;
    const teamId = rawMsg.bot_profile?.team_id || rawMsg.team;
    const reactions = extractReactions(msg);
    return {
      user: msg.user || '',
      text: applyMentionReplacements(ownText, userInfoMap, groupInfoMap, channelInfoMap),
      ts: msg.ts || '',
      ...(files && files.length > 0 ? { files } : {}),
      ...(resolvedAttachments.length > 0 ? { attachments: resolvedAttachments } : {}),
      ...(botId ? { botId } : {}),
      ...(botName ? { botName } : {}),
      ...(teamId ? { teamId } : {}),
      ...(reactions.length > 0 ? { reactions } : {}),
    };
  });
}

/**
 * Resolve top-level message authors and map RawSlackMessage[] into the public
 * SlackThreadMessage[] shape. Does NOT filter anything — the caller decides
 * which messages to pass in (fetchSlackThread filters bot chatter; explore
 * reads pass everything).
 */
async function resolveAuthorsAndMap(messages: RawSlackMessage[]): Promise<SlackThreadMessage[]> {
  const authorIds = new Set(messages.filter((m) => m.user).map((m) => m.user));
  const userInfoEntries = await Promise.all(
    Array.from(authorIds).map(async (uid): Promise<readonly [string, SlackAuthor]> => {
      try {
        const info = await getUserInfo(uid);
        return [uid, {
          id: uid,
          username: info.name,
          realName: info.realName,
          teamId: info.teamId,
          isRestricted: info.isRestricted,
          isUltraRestricted: info.isUltraRestricted,
        }];
      } catch {
        return [uid, { id: uid, username: uid, realName: uid }];
      }
    })
  );
  const userInfoMap = new Map(userInfoEntries);

  return messages.map((msg) => {
    const author: SlackAuthor = msg.user
      ? userInfoMap.get(msg.user)!
      : { id: msg.botId!, username: msg.botName || 'bot', realName: msg.botName || 'bot', teamId: msg.teamId };
    return {
      user: author,
      text: msg.text,
      ts: msg.ts,
      ...(msg.files && msg.files.length > 0 ? { files: msg.files } : {}),
      ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
      ...(msg.reactions && msg.reactions.length > 0 ? { reactions: msg.reactions } : {}),
    };
  });
}

/** Result of an explore read — a channel's messages plus its resolved name. */
export interface SlackChannelMessages {
  channel: { id: string; name: string };
  messages: SlackThreadMessage[];
}

/** Thrown when an explore read/search is pointed at a private channel, DM, or group DM. */
export class PrivateChannelError extends Error {
  readonly channelId: string;
  constructor(channelId: string) {
    super(`Channel ${channelId} is private`);
    this.name = 'PrivateChannelError';
    this.channelId = channelId;
  }
}

/** Thrown when `post_to_channel` is aimed at a 1:1 DM or a group DM (mpim). */
export class DmPostError extends Error {
  readonly channelId: string;
  constructor(channelId: string) {
    super(`Channel ${channelId} is a DM or group DM`);
    this.name = 'DmPostError';
    this.channelId = channelId;
  }
}

/**
 * Resolve a channel's {id,name} for an explore READ, enforcing the accessible-set
 * rule: a channel is readable iff it is PUBLIC, or it is one of `allowedIds` —
 * the channels THIS task already lives in (its own origin, which may legitimately
 * be a private channel or a DM). Any other private channel / DM / group-DM is
 * refused (PrivateChannelError). So Archie reads public channels everywhere, plus
 * its own current channel — never some other private channel or DM, not even from
 * a public-channel request. (Task ingestion via fetchSlackThread is a separate,
 * un-gated path — a task may legitimately live in a private channel.)
 */
async function assertAccessibleChannel(
  channelId: string,
  allowedIds: ReadonlySet<string> = new Set(),
): Promise<{ id: string; name: string }> {
  const client = getSlackClient();
  const info = await client.conversations.info({ channel: channelId });
  const ch = info.channel as
    | { id?: string; name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean }
    | undefined;
  if (!ch) throw new Error('channel_not_found');
  // The task's own channel is always readable, whatever its type.
  if (allowedIds.has(channelId)) return { id: ch.id ?? channelId, name: ch.name ?? channelId };
  // Otherwise fail CLOSED: only a channel Slack explicitly marks public passes.
  if (ch.is_private !== false || ch.is_im || ch.is_mpim) throw new PrivateChannelError(channelId);
  return { id: ch.id ?? channelId, name: ch.name ?? channelId };
}

/**
 * Gate a `post_to_channel` target. Posting is intentionally broad — any PUBLIC or
 * PRIVATE channel Archie belongs to is fine (e.g. escalating into a private
 * management channel) — but 1:1 DMs and group DMs (mpims) are refused, so task
 * content is never relayed into a small private audience. The `is_im`/`is_mpim`
 * API flags are the only reliable signal: a `G…` id is ambiguous between a legacy
 * private channel and a group DM, so we consult the API rather than the id shape
 * (the `D…`/`U…`/`W…` prefix pre-check in the tool handles obvious 1:1 DMs without
 * a round-trip; this catches the group-DM case it can't see).
 */
export async function assertPostableChannel(channelId: string): Promise<void> {
  if (dryRun) return;
  const client = getSlackClient();
  const info = await client.conversations.info({ channel: channelId });
  const ch = info.channel as { is_im?: boolean; is_mpim?: boolean } | undefined;
  if (!ch) throw new Error('channel_not_found');
  if (ch.is_im || ch.is_mpim) throw new DmPostError(channelId);
}

/**
 * Read a channel's recent top-level messages for exploration (bot token; member
 * channels only — `not_in_channel` otherwise). Allowed for any PUBLIC channel
 * plus the channels in `allowedIds` (this task's own channel, even if private/DM);
 * any other private channel / DM is refused. Returns chronological order (oldest
 * first). Bot messages are NOT filtered — exploration shows everything.
 */
export async function fetchChannelHistory(
  channelId: string,
  limit = 30,
  allowedIds?: ReadonlySet<string>,
): Promise<SlackChannelMessages> {
  const client = getSlackClient();
  // Gate BEFORE fetching, so disallowed history is never read into memory.
  const channelInfo = await assertAccessibleChannel(channelId, allowedIds);
  const result = await client.conversations.history({ channel: channelId, limit });
  // conversations.history returns newest-first; reverse to chronological.
  const raw = await resolveRawMessages((result.messages ?? []).slice().reverse() as SlackHistoryMessage[], channelId);
  return { channel: channelInfo, messages: await resolveAuthorsAndMap(raw) };
}

/**
 * Read a specific thread for exploration (bot token; member channels only). Same
 * accessible-set rule as fetchChannelHistory (public, or this task's own channel
 * via `allowedIds`). Unlike fetchSlackThread (task ingestion), does NOT filter
 * bot messages.
 */
export async function fetchExploreThread(
  channelId: string,
  threadTs: string,
  allowedIds?: ReadonlySet<string>,
): Promise<SlackChannelMessages> {
  const client = getSlackClient();
  const channelInfo = await assertAccessibleChannel(channelId, allowedIds);
  const result = await client.conversations.replies({ channel: channelId, ts: threadTs });
  const raw = await resolveRawMessages((result.messages ?? []) as SlackHistoryMessage[], channelId);
  return { channel: channelInfo, messages: await resolveAuthorsAndMap(raw) };
}

/**
 * Get user info
 */
export async function getUserInfo(userId: string): Promise<{
  name: string;
  realName: string;
  email?: string;
  tz?: string;
  teamId?: string;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
}> {
  const client = getSlackClient();

  const result = await client.users.info({ user: userId });
  const user = result.user as {
    name?: string;
    real_name?: string;
    profile?: { real_name?: string; display_name?: string; real_name_normalized?: string; email?: string };
    tz?: string;
    team_id?: string;
    is_restricted?: boolean;
    is_ultra_restricted?: boolean;
  } | undefined;

  // External users (Slack Connect) often only populate the name under profile.*
  // — fall through several fields before giving up to the user ID.
  const realName =
    user?.real_name ||
    user?.profile?.real_name ||
    user?.profile?.real_name_normalized ||
    user?.profile?.display_name ||
    user?.name ||
    userId;

  return {
    name: user?.name || userId,
    realName,
    // Requires the `users:read.email` bot scope; undefined without it.
    email: user?.profile?.email,
    tz: user?.tz,
    teamId: user?.team_id,
    isRestricted: user?.is_restricted,
    isUltraRestricted: user?.is_ultra_restricted,
  };
}

/**
 * Classify a user as external relative to the bot's home Slack team.
 * External = different team_id (Slack Connect / shared channels) OR a guest
 * (`is_restricted` / `is_ultra_restricted`) on the home workspace.
 *
 * Fails open when homeTeamId is unknown (returns false) so the bot remains
 * usable rather than filtering everyone — see startup warning in initSlackClient.
 */
export function isExternalUser(user: {
  teamId?: string;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
}): boolean {
  const home = getHomeTeamId();
  if (!home) return false;
  if (user.isRestricted || user.isUltraRestricted) return true;
  if (user.teamId && user.teamId !== home) return true;
  return false;
}

// ---- Slack Connect channel classification ---------------------------------
// One conversations.info snapshot per channel, cached with a 1-minute TTL: a
// channel can flip to shared mid-task, and warning logic should observe the
// transition promptly. 1 min
// is well under Slack's tier-3 rate limit (50+/min) even for >50 simultaneously
// active threads. Errors are NOT cached — the next call retries.

interface ConvInfoSnapshot {
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
  connected_team_ids?: string[];
}

interface ConvInfoCacheEntry {
  info: ConvInfoSnapshot;
  fetchedAt: number;
}
const conversationInfoCache = new Map<string, ConvInfoCacheEntry>();
const CONVERSATION_INFO_TTL_MS = 60_000;

async function fetchConversationInfoCached(channelId: string): Promise<ConvInfoSnapshot | null> {
  const cached = conversationInfoCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < CONVERSATION_INFO_TTL_MS) {
    return cached.info;
  }
  try {
    const client = getSlackClient();
    const result = await client.conversations.info({ channel: channelId });
    const info = (result.channel ?? {}) as ConvInfoSnapshot;
    conversationInfoCache.set(channelId, { info, fetchedAt: Date.now() });
    return info;
  } catch (error) {
    logger.warn('Slack', `Failed to fetch conversation info for ${channelId}`, error);
    return null;
  }
}

function isSharedFromInfo(info: ConvInfoSnapshot): boolean {
  return (
    !!info.is_ext_shared ||
    !!info.is_pending_ext_shared ||
    ((info.connected_team_ids?.length ?? 0) > 1)
  );
}

/**
 * Returns whether a channel is shared with one or more external Slack
 * workspaces (Slack Connect). Consults `conversations.info` for every id —
 * Slack Connect DMs are D-prefixed and ARE shared. Result is cached for
 * 1 minute. On API failure, returns false (fail-open — this is advisory only).
 */
export async function isChannelShared(channelId: string): Promise<boolean> {
  const info = await fetchConversationInfoCached(channelId);
  if (info === null) return false;
  return isSharedFromInfo(info);
}

/**
 * Post an ephemeral message in a channel/thread visible only to one user.
 * Used for shared-channel and forwarding warnings.
 */
export async function postEphemeral(
  channel: string,
  user: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  if (dryRun) {
    logger.system(`[DRY RUN] postEphemeral ${channel} → ${user} — ${text.slice(0, 120)}`);
    return;
  }
  try {
    const renderedText = restoreMentions(text);
    assertSlackMarkdownLength(renderedText);
    const client = getSlackClient();
    await client.chat.postEphemeral({
      channel,
      user,
      text: renderedText,
      blocks: markdownBlock(renderedText) as any,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (error) {
    logger.warn('Slack', `Failed to post ephemeral in ${channel} to ${user}`, error);
  }
}

/**
 * Get channel info
 */
export async function getChannelInfo(
  channelId: string,
): Promise<{ id: string; name: string; isPrivate: boolean; isIm: boolean; imUserId?: string }> {
  const client = getSlackClient();

  try {
    const result = await client.conversations.info({ channel: channelId });
    const channel = result.channel as
      | { name?: string; is_im?: boolean; is_private?: boolean; user?: string }
      | undefined;

    const isIm = channel?.is_im === true;
    // DMs are inherently private; otherwise read the channel's is_private flag.
    const isPrivate = isIm || channel?.is_private === true;

    // For DMs, resolve the other user's name instead of showing a raw ID
    if (isIm && channel?.user) {
      const userInfo = await getUserInfo(channel.user);
      return { id: channelId, name: `DM with ${userInfo.realName}`, isPrivate, isIm, imUserId: channel.user };
    }

    return {
      id: channelId,
      name: channel?.name || channelId,
      isPrivate,
      isIm,
    };
  } catch (error) {
    logger.warn('Slack', `Failed to get channel info for ${channelId}`);
    return { id: channelId, name: channelId, isPrivate: true, isIm: channelId.startsWith('D') };
  }
}

/**
 * Resolve a channel's current privacy, **throwing** on any API error rather than
 * swallowing it. Callers that need to distinguish a genuine private result
 * from an unreachable channel use this rather than getChannelInfo's fail-closed
 * fallback. A DM is private.
 */
export async function fetchChannelIsPrivate(channelId: string): Promise<boolean> {
  const client = getSlackClient();
  const result = await client.conversations.info({ channel: channelId });
  const channel = result.channel as { is_im?: boolean; is_private?: boolean } | undefined;
  return channel?.is_im === true || channel?.is_private === true;
}

// ---- Channel canvas tabs + file reads (project-context canvases) ----------
// A channel canvas pinned as a tab surfaces under conversations.info
// `channel.properties.tabs[]` (type === 'canvas'). We read the canvas body as a
// FILE (files.info → url_private_download → bot Bearer GET → HTML); there is no
// markdown read API for bots. Only `files:read` is required.

interface CanvasTabsCacheEntry {
  tabs: CanvasTab[];
  fetchedAt: number;
}
const canvasTabsCache = new Map<string, CanvasTabsCacheEntry>();
const CANVAS_TABS_TTL_MS = 60_000;

/** A canvas tab pinned in a channel header. `title` is best-effort; the
 *  authoritative title for prefix-matching comes from `getSlackFileInfo`. */
export interface CanvasTab {
  file_id: string;
  title?: string;
}

/** Metadata for a Slack file (canvas or regular file). */
export interface SlackFileInfo {
  url_private?: string;
  url_private_download?: string;
  filetype?: string;
  user?: string;     // creator user id
  title?: string;
  name?: string;
  updated?: number;  // edit timestamp — drives canvas change detection
}

/**
 * List canvas tabs pinned in a channel (returns their file ids). Cached for
 * 1 minute, mirroring `isChannelShared`. DMs never have canvas tabs.
 */
export async function getChannelCanvasTabs(channelId: string): Promise<CanvasTab[]> {
  if (channelId.startsWith('D')) return [];

  const cached = canvasTabsCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < CANVAS_TABS_TTL_MS) {
    return cached.tabs;
  }

  try {
    const client = getSlackClient();
    const result = await client.conversations.info({ channel: channelId });
    // `properties` (canvas tabs) isn't in the WebClient types — cast to read it.
    const channel = result.channel as {
      properties?: {
        tabs?: Array<{ type?: string; label?: string; data?: { file_id?: string } }>;
      };
    } | undefined;
    const tabs: CanvasTab[] = [];
    for (const tab of channel?.properties?.tabs ?? []) {
      if (tab.type === 'canvas' && tab.data?.file_id) {
        tabs.push({ file_id: tab.data.file_id, title: tab.label });
      }
    }
    canvasTabsCache.set(channelId, { tabs, fetchedAt: Date.now() });
    return tabs;
  } catch (error) {
    logger.warn('Slack', `Failed to fetch canvas tabs for ${channelId}`, error);
    return [];
  }
}

/** Fetch metadata for a Slack file via `files.info`. Returns null on failure. */
export async function getSlackFileInfo(fileId: string): Promise<SlackFileInfo | null> {
  try {
    const client = getSlackClient();
    const result = await client.files.info({ file: fileId });
    const f = result.file as {
      url_private?: string;
      url_private_download?: string;
      filetype?: string;
      user?: string;
      title?: string;
      name?: string;
      updated?: number;
      created?: number;
    } | undefined;
    if (!f) return null;
    return {
      url_private: f.url_private,
      url_private_download: f.url_private_download,
      filetype: f.filetype,
      user: f.user,
      title: f.title,
      name: f.name,
      updated: f.updated ?? f.created,
    };
  } catch (error) {
    logger.warn('Slack', `Failed to fetch file info for ${fileId}`, error);
    return null;
  }
}

/**
 * Fetch a Slack file body as a UTF-8 string (authenticated with the bot token).
 * Sibling of `downloadSlackFile`, but returns the body instead of writing to
 * disk and — crucially — does NOT treat `text/html` as an error: a canvas body
 * is legitimately HTML (that guard in `downloadSlackFile` exists to catch Slack
 * auth/login pages, which is a different case).
 */
export async function fetchSlackFileBody(fileUrl: string): Promise<string> {
  const client = getSlackClient();
  const token = (client as unknown as { token: string }).token;

  const response = await fetch(fileUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Slack file body: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

/**
 * Probe whether a channel can currently receive a post from the bot. Returns
 * false when the channel no longer exists or is archived (e.g. deleted, or the
 * bot was removed and the channel archived). A successful `conversations.info`
 * on a live, non-archived channel returns true. Note: a public channel returns
 * true even if the bot isn't a member (Slack allows posting), so this primarily
 * catches the deleted/archived cases — the strongest signal available without
 * actually posting.
 */
export async function isChannelReachable(channelId: string): Promise<boolean> {
  try {
    // getSlackClient() is inside the try on purpose: if the client isn't
    // initialized it throws, and this probe must return false (→ fireTrigger
    // pauses the trigger) rather than propagate and error-loop every tick.
    const client = getSlackClient();
    const result = await client.conversations.info({ channel: channelId });
    const channel = result.channel as { is_archived?: boolean } | undefined;
    return channel ? channel.is_archived !== true : false;
  } catch {
    return false;
  }
}


/**
 * Post a question to a thread and wait for a response
 * This is a simplified implementation - in production you'd use Slack's interactive features
 */
export async function askUserInThread(
  channel: string,
  threadTs: string,
  question: string,
  options?: string[]
): Promise<void> {
  let message = question;

  if (options && options.length > 0) {
    message += '\n\nPlease reply with one of the following:\n';
    message += options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
  }

  await postSlackMessage({ channel, threadTs, text: message });
}

/**
 * Extract bot mention from message text
 */
export function extractMentionText(text: string, botUserId: string): string {
  // Remove the bot mention from the text
  const mentionPattern = new RegExp(`<@${botUserId}>\\s*`, 'g');
  return text.replace(mentionPattern, '').trim();
}

/**
 * Check if a message mentions the bot
 */
export function isBotMention(text: string, botUserId: string): boolean {
  return text.includes(`<@${botUserId}>`);
}

/**
 * Clean a single Slack message text by replacing mentions with <@ID:Name> format
 */
export async function cleanSlackText(text: string, channelId?: string): Promise<string> {
  const channelIds = channelId ? new Set<string>([channelId]) : new Set<string>();
  const { userInfoMap, groupInfoMap, channelInfoMap } = await fetchMentionInfo([{ text }], channelIds);
  return applyMentionReplacements(text, userInfoMap, groupInfoMap, channelInfoMap);
}

/**
 * Download a Slack file to a local path
 * Requires files:read scope in the bot token
 */
export async function downloadSlackFile(
  fileUrl: string,
  destPath: string
): Promise<void> {
  const client = getSlackClient();
  const token = (client as unknown as { token: string }).token;

  logger.slack(`Downloading file from: ${fileUrl}`);

  const response = await fetch(fileUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  const { writeFile, mkdir } = await import('fs/promises');
  const { dirname } = await import('path');

  // Get content as buffer first
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';

  // Check content-type to detect HTML error pages
  if (contentType.includes('text/html')) {
    // Slack returned HTML instead of file - likely auth issue or wrong URL
    const body = buffer.toString('utf-8');
    const isSlackPage = body.includes('slack.com') || body.includes('slack-edge.com');
    if (isSlackPage) {
      throw new Error(
        `Slack returned HTML instead of file content. ` +
        `This usually means the token lacks files:read scope or the URL requires browser authentication. ` +
        `URL: ${fileUrl}`
      );
    }
  }

  // Ensure directory exists
  await mkdir(dirname(destPath), { recursive: true });

  await writeFile(destPath, buffer);

  logger.slack(`Downloaded file to ${destPath} (${buffer.length} bytes, type: ${contentType})`);
}

/**
 * Fetch a complete Slack thread with all API work done in one place:
 * channel info, thread history, user info resolution, bot message filtering.
 *
 * Returns a fully-resolved SlackThread ready for consumption by triage and Task.
 */
export async function fetchSlackThread(
  channelId: string,
  threadTs: string,
  currentMessageTs: string,
): Promise<SlackThread> {
  const [channelInfo, rawMessages, shared] = await Promise.all([
    getChannelInfo(channelId),
    fetchThreadHistory(channelId, threadTs),
    isChannelShared(channelId),
  ]);

  // Detect whether OUR bot authored the thread root, computed BEFORE filtering.
  // This is the signal the router uses to seed a task when a human replies to a
  // thread Archie itself started (see handleSlackEvent).
  const root = rawMessages[0];
  const rootAuthorWasBot =
    !!root && ((!!root.user && root.user === botUserId) || (!!root.botId && root.botId === botId));

  // Filter rules:
  //  - drop our own bot's messages — EXCEPT the thread root, so a task seeded
  //    from a bot-started thread still carries Archie's originating post.
  //  - drop external bots (messages from another workspace).
  // Keep: real users, and internal bots (e.g. bug-tracker integrations) so their
  // thread starters survive into the knowledge log.
  const visibleMessages = rawMessages.filter((msg, i) => {
    const isRoot = i === 0;
    if (msg.user) {
      if (msg.user === botUserId) return isRoot; // our own bot — keep only at root
      return true;
    }
    if (msg.botId) {
      if (msg.botId === botId) return isRoot; // our own bot — keep only at root
      if (homeTeamId && msg.teamId && msg.teamId !== homeTeamId) return false; // external bot
      return true;
    }
    // No user and no bot id — drop (system message, file_comment, etc.)
    return false;
  });

  const messages = await resolveAuthorsAndMap(visibleMessages);

  return {
    threadId: threadTs,
    channel: channelInfo,
    shared,
    taskVisibility: channelInfo.isPrivate || channelInfo.isIm ? 'private' : 'public',
    messages,
    currentMessageTs,
    rootAuthorWasBot,
  };
}

// ============================================================================
// Channel Formatting
// ============================================================================

/**
 * Format a Slack channel reference for logs (includes IDs).
 * e.g., "slack:#<C123:bot-test>:threadTs"
 */
export function formatSlackChannelRef(channelId: string, channelName: string, threadId: string): string {
  return `slack:#<${channelId}:${channelName}>:${threadId}`;
}

/**
 * Format a Slack channel for human-readable display.
 * e.g., "#bot-test"
 */
export function formatSlackChannelDisplay(channelName: string): string {
  return `#${channelName}`;
}

// ============================================================================
// User Lookup
// ============================================================================

export interface SlackUserInfo {
  id: string;
  name: string;          // @handle
  realName: string;      // Full name
  displayName: string;   // Display name (may differ from realName)
  title: string;         // Job title (e.g., "Senior Engineer")
  timezone: string;      // Human timezone label (e.g., "Eastern Time (US & Canada)")
  tz: string;            // IANA timezone (e.g., "America/New_York") — pass to parse_datetime
  isAdmin: boolean;      // Workspace admin
  isOwner: boolean;      // Workspace owner
  teamId?: string;             // Slack team_id — used for external-org classification
  isRestricted?: boolean;      // Multi-channel guest
  isUltraRestricted?: boolean; // Single-channel guest
}

let userCache: SlackUserInfo[] = [];
let userCacheTimestamp = 0;
const USER_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * List all workspace users (cached, refreshed every 10 minutes).
 * Filters out bots and deactivated accounts.
 */
export async function listWorkspaceUsers(): Promise<SlackUserInfo[]> {
  if (userCache.length > 0 && Date.now() - userCacheTimestamp < USER_CACHE_TTL) {
    return userCache;
  }

  const client = getSlackClient();
  const users: SlackUserInfo[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.users.list({ cursor, limit: 200 });
    for (const member of result.members ?? []) {
      if (member.deleted || member.is_bot || member.id === 'USLACKBOT') continue;
      users.push({
        id: member.id!,
        name: member.name ?? member.id!,
        realName: member.real_name ?? member.name ?? member.id!,
        displayName: member.profile?.display_name || member.real_name || member.name || member.id!,
        title: member.profile?.title ?? '',
        timezone: member.tz_label ?? '',
        tz: member.tz ?? '',
        isAdmin: member.is_admin ?? false,
        isOwner: member.is_owner ?? false,
        teamId: member.team_id ?? undefined,
        isRestricted: member.is_restricted ?? false,
        isUltraRestricted: member.is_ultra_restricted ?? false,
      });
    }
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  userCache = users;
  userCacheTimestamp = Date.now();
  logger.slack(`Cached ${users.length} workspace users`);
  return users;
}

/**
 * Find Slack users by ID or name.
 * - If query looks like a Slack user ID (starts with U), returns exact match
 * - Otherwise, case-insensitive substring match against name, realName, displayName
 */
export async function findSlackUsers(query: string): Promise<SlackUserInfo[]> {
  const users = await listWorkspaceUsers();

  // Exact ID match
  if (/^U[A-Z0-9]+$/.test(query)) {
    const user = users.find(u => u.id === query);
    return user ? [user] : [];
  }

  // Name search
  const q = query.toLowerCase();
  return users.filter(u =>
    u.name.toLowerCase().includes(q) ||
    u.realName.toLowerCase().includes(q) ||
    u.displayName.toLowerCase().includes(q)
  );
}

// ============================================================================
// Channel Lookup
// ============================================================================

export interface SlackChannelInfo {
  id: string;
  name: string;
  topic: string;
  purpose: string;
  memberCount: number;
  isPrivate: boolean;
  isArchived: boolean;
}

let channelCache: SlackChannelInfo[] = [];
let channelCacheTimestamp = 0;

/**
 * List all workspace channels the bot can see (cached, refreshed every 10 minutes).
 * Filters out archived channels.
 */
export async function listWorkspaceChannels(): Promise<SlackChannelInfo[]> {
  if (channelCache.length > 0 && Date.now() - channelCacheTimestamp < USER_CACHE_TTL) {
    return channelCache;
  }

  const client = getSlackClient();
  const channels: SlackChannelInfo[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.conversations.list({
      cursor,
      limit: 200,
      exclude_archived: true,
      types: 'public_channel,private_channel',
    });
    for (const ch of result.channels ?? []) {
      channels.push({
        id: ch.id!,
        name: ch.name ?? ch.id!,
        topic: (ch.topic as { value?: string })?.value ?? '',
        purpose: (ch.purpose as { value?: string })?.value ?? '',
        memberCount: (ch as { num_members?: number }).num_members ?? 0,
        isPrivate: ch.is_private ?? false,
        isArchived: ch.is_archived ?? false,
      });
    }
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  channelCache = channels;
  channelCacheTimestamp = Date.now();
  logger.slack(`Cached ${channels.length} workspace channels`);
  return channels;
}

/**
 * List the channels the bot is actually a MEMBER of — i.e. the channels the
 * explore/post tools can act on. Uses `users.conversations` (membership of the
 * calling token), so it never includes channels the bot was not invited to.
 * Archived excluded; not cached (membership changes when the bot is
 * invited/removed, and freshness matters right after an invite).
 *
 * PUBLIC channels only — never enumerates private channels. The task's own
 * private channel / DM, when relevant, is appended by the `list_channels` tool
 * from task metadata, so a public-channel or DM requester never learns that
 * other private channels exist.
 */
export async function listBotChannels(): Promise<SlackChannelInfo[]> {
  const client = getSlackClient();
  const channels: SlackChannelInfo[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.users.conversations({
      cursor,
      limit: 200,
      exclude_archived: true,
      types: 'public_channel',
    });
    for (const ch of result.channels ?? []) {
      channels.push({
        id: ch.id!,
        name: ch.name ?? ch.id!,
        topic: (ch.topic as { value?: string })?.value ?? '',
        purpose: (ch.purpose as { value?: string })?.value ?? '',
        memberCount: (ch as { num_members?: number }).num_members ?? 0,
        isPrivate: ch.is_private ?? false,
        isArchived: ch.is_archived ?? false,
      });
    }
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels;
}

/**
 * Find Slack channels by ID or name.
 * - If query looks like a Slack channel ID (starts with C), returns exact match
 * - Otherwise, case-insensitive substring match against name, topic, purpose
 */
export async function findSlackChannels(query: string): Promise<SlackChannelInfo[]> {
  const channels = await listWorkspaceChannels();

  // Exact ID match
  if (/^C[A-Z0-9]+$/.test(query)) {
    const ch = channels.find(c => c.id === query);
    return ch ? [ch] : [];
  }

  // Name search (strip leading # if present)
  const q = query.replace(/^#/, '').toLowerCase();
  return channels.filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.topic.toLowerCase().includes(q) ||
    c.purpose.toLowerCase().includes(q)
  );
}
