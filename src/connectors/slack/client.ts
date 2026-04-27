/**
 * Slack Client
 *
 * Wrapper around Slack API for posting messages, fetching thread history,
 * and handling webhooks.
 */

import { WebClient } from '@slack/web-api';
import type { SlackThreadRef, SlackFile, SlackThread, SlackThreadMessage, SlackAuthor, SlackAttachment } from '../../types/index.js';

/**
 * Internal raw shape produced by `fetchThreadHistory`. Carries the unresolved
 * top-level `user` ID; attachment authors are already resolved to SlackAuthor.
 * Only consumed by `fetchSlackThread`, which resolves the top-level user and
 * returns the public `SlackThreadMessage`. Not exported.
 */
interface RawSlackMessage {
  user: string;
  text: string;
  ts: string;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
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
}): Promise<string | undefined> {
  const { channel, text, threadTs } = args;
  if (dryRun) {
    const target = threadTs ? `${channel}:${threadTs}` : channel;
    logger.system(`[DRY RUN] postSlackMessage ${target} — ${text.slice(0, 120)}`);
    return undefined;
  }
  const renderedText = restoreMentions(text);
  assertSlackMarkdownLength(renderedText);
  const client = getSlackClient();
  const result = await client.chat.postMessage({
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: renderedText,
    blocks: markdownBlock(renderedText) as any,
  });
  return result.ts;
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
 * Restore @<ID:Name> mention format back to Slack's <@ID> syntax for outgoing messages.
 * Agents see users as @<U123:John Smith> in conversation history and are taught to use
 * this format when mentioning users. This converts them back so Slack sends notifications.
 */
function restoreMentions(text: string): string {
  return text.replace(/@<([A-Z0-9]+):[^>]+>/g, '<@$1>');
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

  // Replace user mentions <@U123> with @<U123:Real Name>
  result = result.replace(/<@([A-Z0-9]+)>/g, (match, userId) => {
    const userInfo = userInfoMap.get(userId);
    return userInfo ? `@<${userId}:${userInfo.realName}>` : match;
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

  if (!result.messages) {
    return [];
  }

  // Intermediate shape: we extract authorId here; the public SlackAttachment
  // exposes a fully resolved SlackAuthor — resolution happens after this loop.
  interface RawAttachment { authorId?: string; text: string }

  // Extract a message into the forwarder's own text plus a list of structured
  // attachments. Each attachment carries its own text and the original
  // author's user ID when Slack provides one. Keeping author+text correlated
  // per attachment lets downstream code redact / label individual attachments.
  const extractMessageParts = (msg: typeof result.messages[0]): {
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
  const messages = result.messages.map((m) => {
    const { ownText, attachments } = extractMessageParts(m);
    return {
      text: [ownText, ...attachments.map((a) => a.text)].filter(Boolean).join('\n'),
    };
  });
  const channelIds = new Set([channel]); // Include the thread's channel
  const { userInfoMap, groupInfoMap, channelInfoMap } = await fetchMentionInfo(messages, channelIds);

  // Extract files from a message (including from attachments/forwarded messages)
  const extractFiles = (msg: typeof result.messages[0]): SlackFile[] | undefined => {
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

  // Resolve attachment authors to SlackAuthor objects up-front so each
  // attachment carries its full author info (name, team, restriction flags).
  const extractedPerMessage = result.messages.map((m) => extractMessageParts(m));
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
  return result.messages.map((msg, i) => {
    const files = extractFiles(msg);
    const { ownText, attachments } = extractedPerMessage[i];
    const resolvedAttachments: SlackAttachment[] = attachments.map((a) => {
      const author = a.authorId ? authorMap.get(a.authorId) ?? undefined : undefined;
      return {
        ...(author ? { author } : {}),
        text: applyMentionReplacements(a.text, userInfoMap, groupInfoMap, channelInfoMap),
      };
    });
    return {
      user: msg.user || 'unknown',
      text: applyMentionReplacements(ownText, userInfoMap, groupInfoMap, channelInfoMap),
      ts: msg.ts || '',
      ...(files && files.length > 0 ? { files } : {}),
      ...(resolvedAttachments.length > 0 ? { attachments: resolvedAttachments } : {}),
    };
  });
}

/**
 * Get user info
 */
export async function getUserInfo(userId: string): Promise<{
  name: string;
  realName: string;
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
    profile?: { real_name?: string; display_name?: string; real_name_normalized?: string };
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

// ---- Shared-channel detection (Slack Connect) -----------------------------
// Cached per-channel with a 1-minute TTL: a channel can flip to shared mid-task
// when an external org is added, and the warning logic depends on observing
// the transition promptly. 1 min is well under Slack's tier-3 rate limit
// (50+/min) even for >50 simultaneously active threads.

interface ChannelSharedCacheEntry {
  isShared: boolean;
  fetchedAt: number;
}
const channelSharedCache = new Map<string, ChannelSharedCacheEntry>();
const CHANNEL_SHARED_TTL_MS = 60_000;

/**
 * Returns whether a channel is shared with one or more external Slack
 * workspaces (Slack Connect). DMs are never shared. Result is cached for
 * 1 minute. On API failure, returns false (fail-open).
 */
export async function isChannelShared(channelId: string): Promise<boolean> {
  if (channelId.startsWith('D')) return false;

  const cached = channelSharedCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < CHANNEL_SHARED_TTL_MS) {
    return cached.isShared;
  }

  try {
    const client = getSlackClient();
    const result = await client.conversations.info({ channel: channelId });
    const channel = result.channel as {
      is_ext_shared?: boolean;
      is_pending_ext_shared?: boolean;
      connected_team_ids?: string[];
    } | undefined;
    const isShared =
      !!channel?.is_ext_shared ||
      !!channel?.is_pending_ext_shared ||
      ((channel?.connected_team_ids?.length ?? 0) > 1);
    channelSharedCache.set(channelId, { isShared, fetchedAt: Date.now() });
    return isShared;
  } catch (error) {
    logger.warn('Slack', `Failed to fetch shared-channel status for ${channelId}`, error);
    return false;
  }
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
export async function getChannelInfo(channelId: string): Promise<{ id: string; name: string }> {
  const client = getSlackClient();

  try {
    const result = await client.conversations.info({ channel: channelId });
    const channel = result.channel as { name?: string; is_im?: boolean; user?: string } | undefined;

    // For DMs, resolve the other user's name instead of showing a raw ID
    if (channel?.is_im && channel.user) {
      const userInfo = await getUserInfo(channel.user);
      return { id: channelId, name: `DM with ${userInfo.realName}` };
    }

    return {
      id: channelId,
      name: channel?.name || channelId,
    };
  } catch (error) {
    logger.warn('Slack', `Failed to get channel info for ${channelId}`);
    return { id: channelId, name: channelId };
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
 * Clean a single Slack message text by replacing mentions with @<ID:Name> format
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

  // Filter out bot messages
  const humanMessages = rawMessages.filter(
    (msg) => msg.user && msg.user !== 'unknown' && msg.user !== botUserId
  );

  // Resolve top-level message authors. Attachment authors are already
  // resolved on each msg.attachments[].author by fetchThreadHistory.
  const authorIds = new Set(humanMessages.map((msg) => msg.user));
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

  // Surface structured pieces (text, attachments, files) and let consumers
  // decide redaction / labeling using `thread.shared` + `isExternalUser`.
  const messages: SlackThreadMessage[] = humanMessages.map((msg) => {
    const author = userInfoMap.get(msg.user)!;
    return {
      user: author,
      text: msg.text,
      ts: msg.ts,
      ...(msg.files && msg.files.length > 0 ? { files: msg.files } : {}),
      ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
    };
  });

  return {
    threadId: threadTs,
    channel: channelInfo,
    shared,
    messages,
    currentMessageTs,
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
  timezone: string;      // Timezone label (e.g., "Eastern Time (US & Canada)")
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
        timezone: member.tz_label ?? member.tz ?? '',
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
        memberCount: ch.num_members ?? 0,
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

// ============================================================================
// DM & Channel Messaging
// ============================================================================

/**
 * Open (or get existing) DM channel with a user.
 * Returns the DM channel ID (e.g., "D1234567").
 */
export async function openDMChannel(userId: string): Promise<string> {
  if (dryRun) {
    logger.system(`[DRY RUN] openDMChannel for user ${userId}`);
    return `D_DRYRUN_${userId}`;
  }
  const client = getSlackClient();
  const result = await client.conversations.open({ users: userId });
  return result.channel!.id!;
}

