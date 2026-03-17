/**
 * Slack Client
 *
 * Wrapper around Slack API for posting messages, fetching thread history,
 * and handling webhooks.
 */

import { WebClient } from '@slack/web-api';
import type { SlackMessage, SlackThreadRef, SlackFile, SlackThread, SlackThreadMessage } from '../../types/index.js';
import slackifyMarkdown from 'slackify-markdown';
import { logger } from '../../system/logger.js';

let slackClient: WebClient | null = null;
let botUserId: string | null = null;
let botId: string | null = null;

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
    logger.slack(`Bot user ID: ${botUserId}, bot ID: ${botId}`);
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
 * Get the Slack client instance
 */
export function getSlackClient(): WebClient {
  if (!slackClient) {
    throw new Error('Slack client not initialized. Call initSlackClient first.');
  }
  return slackClient;
}

/**
 * Post a message to a Slack thread
 */
export async function postToThread(
  channel: string,
  threadTs: string,
  text: string
): Promise<string | undefined> {
  const client = getSlackClient();

  // Convert markdown to Slack mrkdwn format
  const slackText = slackifyMarkdown(text);

  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: slackText,
    mrkdwn: true,
  });

  return result.ts;
}

/**
 * Post a message to multiple threads (for tasks with multiple linked threads)
 */
export async function postToThreads(
  threads: SlackThreadRef[],
  text: string
): Promise<void> {
  for (const thread of threads) {
    await postToThread(thread.channel_id, thread.thread_id, text);
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
 * Update an existing message (e.g., to remove buttons after action)
 */
export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  blocks?: unknown[]
): Promise<void> {
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
 * Fetch thread history from Slack with mentions replaced
 */
export async function fetchThreadHistory(
  channel: string,
  threadTs: string,
  oldest?: string
): Promise<SlackMessage[]> {
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

  // Extract text from message, handling all Slack message formats
  const extractMessageText = (msg: typeof result.messages[0]): string => {
    const parts: string[] = [];

    // 1. Primary: use main text field
    if (msg.text) {
      parts.push(msg.text);
    }

    // 2. Extract from blocks (Block Kit / rich_text)
    const blocks = msg.blocks as Array<{
      type: string;
      text?: { text?: string };
      elements?: Array<unknown>;
    }> | undefined;

    if (blocks && Array.isArray(blocks)) {
      for (const block of blocks) {
        const blockText = extractBlockText(block);
        if (blockText && !parts.includes(blockText)) {
          parts.push(blockText);
        }
      }
    }

    // 3. Extract from attachments (forwarded messages, shared content, unfurls)
    const attachments = msg.attachments as Array<{
      text?: string;
      fallback?: string;
      pretext?: string;
      title?: string;
      message_blocks?: Array<{ message?: { blocks?: Array<unknown> } }>;
    }> | undefined;

    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        // Try structured message_blocks first (forwarded messages)
        if (att.message_blocks) {
          for (const mb of att.message_blocks) {
            if (mb.message?.blocks) {
              for (const block of mb.message.blocks) {
                const blockText = extractBlockText(block as { type: string; elements?: Array<unknown> });
                if (blockText && !parts.includes(blockText)) {
                  parts.push(`[Forwarded] ${blockText}`);
                }
              }
            }
          }
        }

        // Fall back to text/fallback fields
        const attText = att.text || att.fallback;
        if (attText && !parts.includes(attText)) {
          // Check if this looks like a forwarded message (has is_share or from_url)
          const isForwarded = (att as { is_share?: boolean }).is_share;
          parts.push(isForwarded ? `[Forwarded] ${attText}` : attText);
        }
      }
    }

    // 4. Extract from files (file shares)
    const files = msg.files as Array<{ name?: string; title?: string }> | undefined;
    if (files && Array.isArray(files)) {
      const fileDescriptions = files
        .map(f => f.title || f.name)
        .filter(Boolean);
      if (fileDescriptions.length > 0) {
        parts.push(`[Files: ${fileDescriptions.join(', ')}]`);
      }
    }

    return parts.join('\n');
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

  // Batch fetch user/group/channel info for all messages
  const messages = result.messages.map(m => ({ text: extractMessageText(m) }));
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

  // Apply replacements to all messages
  return result.messages.map((msg) => {
    const files = extractFiles(msg);
    return {
      type: msg.type || 'message',
      channel,
      user: msg.user || 'unknown',
      text: applyMentionReplacements(extractMessageText(msg), userInfoMap, groupInfoMap, channelInfoMap),
      ts: msg.ts || '',
      thread_ts: msg.thread_ts,
      ...(files && files.length > 0 ? { files } : {}),
    };
  });
}

/**
 * Fetch new messages in a thread since a timestamp
 */
export async function fetchNewMessages(
  channel: string,
  threadTs: string,
  sinceTs: string
): Promise<SlackMessage[]> {
  return fetchThreadHistory(channel, threadTs, sinceTs);
}

/**
 * Get user info
 */
export async function getUserInfo(userId: string): Promise<{ name: string; realName: string }> {
  const client = getSlackClient();

  const result = await client.users.info({ user: userId });

  return {
    name: result.user?.name || userId,
    realName: result.user?.real_name || userId,
  };
}

/**
 * Get channel info
 */
export async function getChannelInfo(channelId: string): Promise<{ id: string; name: string }> {
  const client = getSlackClient();

  try {
    const result = await client.conversations.info({ channel: channelId });
    return {
      id: channelId,
      name: result.channel?.name || channelId,
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

  await postToThread(channel, threadTs, message);
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
  const [channelInfo, rawMessages] = await Promise.all([
    getChannelInfo(channelId),
    fetchThreadHistory(channelId, threadTs),
  ]);

  // Filter out bot messages
  const humanMessages = rawMessages.filter(
    (msg) => msg.user && msg.user !== 'unknown' && msg.user !== botUserId
  );

  // Batch-resolve user info for all unique authors
  const uniqueUserIds = [...new Set(humanMessages.map((msg) => msg.user))];
  const userInfoEntries = await Promise.all(
    uniqueUserIds.map(async (uid) => {
      const info = await getUserInfo(uid);
      return [uid, info] as const;
    })
  );
  const userInfoMap = new Map(userInfoEntries);

  // Build resolved messages
  const messages: SlackThreadMessage[] = humanMessages.map((msg) => {
    const info = userInfoMap.get(msg.user)!;
    return {
      user: { id: msg.user, username: info.name, realName: info.realName },
      text: msg.text,
      ts: msg.ts,
      ...(msg.files && msg.files.length > 0 ? { files: msg.files } : {}),
    };
  });

  return {
    threadId: threadTs,
    channel: channelInfo,
    messages,
    currentMessageTs,
  };
}
