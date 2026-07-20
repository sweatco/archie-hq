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
      .filter((r): r is { name: string; count?: number; users?: string[] } => Boolean(r) && typeof r?.name === 'string')
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

  // Undo Slack's escaping last, after every `<…>` construct has been parsed, so
  // a user who literally typed "&lt;" doesn't turn into a bogus mention.
  return decodeSlackEntities(result);
}

/**
 * Reverse the only three escapes Slack applies to message text. Left encoded,
 * `&amp;` corrupts every URL with a query string the agent reads back — and it
 * appears in `text` but not in `blocks`, so decoding is also what lets the two
 * dialects be compared.
 */
function decodeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
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

  // `conversations.replies` returns oldest-first and pages, so ignoring
  // `next_cursor` would drop the NEWEST replies — including, on a long enough
  // thread, the very message that triggered this fetch. Follow the cursor, with
  // a page cap so a runaway thread can't stall the turn.
  const raw: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  let page = 0;
  do {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      oldest,
      inclusive: oldest ? false : true,
      cursor,
      limit: 1000,
    });
    raw.push(...(result.messages ?? []));
    cursor = result.response_metadata?.next_cursor || undefined;
    page += 1;
    if (cursor && page >= THREAD_PAGE_LIMIT) {
      logger.warn(
        'Slack',
        `Thread ${channel}:${threadTs} exceeds ${THREAD_PAGE_LIMIT} pages (${raw.length} messages) — older replies kept, newest truncated`,
      );
      break;
    }
  } while (cursor);

  return resolveRawMessages(raw, channel);
}

/** Max `conversations.replies` pages per thread fetch (1000 messages each). */
const THREAD_PAGE_LIMIT = 5;

/**
 * Slack encodes links in the legacy `text` field as `<url>` or `<url|label>`.
 * Mentions share that bracket syntax (`<@U…>`, `<#C…>`, `<!here>`) but never
 * carry a scheme, so requiring one isolates real URLs.
 */
const TEXT_FIELD_URL = /<((?:https?|mailto):[^|>\s]+)(?:\|[^>]*)?>/g;

/**
 * Recover URLs that the Block Kit walk dropped.
 *
 * `blocks` is the richer source and is preferred, but Slack renders an
 * ever-growing set of pasted links as "smart link" chips carried by rich_text
 * element types we don't know about (`message_mention`, `canvas`, the Jira
 * issue chip, …). An unrecognised element contributes nothing, so the link
 * vanishes from the agent's view entirely — the user sees a link in Slack and
 * Archie insists no link was sent. The legacy `text` field always spells the
 * raw URL out, so treat it as the backstop: append anything `extracted` is
 * missing, deduped and in order.
 */
function recoverMissingUrls(extracted: string, textField: string | undefined): string[] {
  if (!textField || typeof textField !== 'string') return [];
  const missing: string[] = [];
  for (const match of textField.matchAll(TEXT_FIELD_URL)) {
    // Decode before comparing: `text` escapes `&` but `blocks` does not, so a
    // query-string URL that the block walk DID render still looked absent and
    // got appended a second time — which is every Grafana silence link and
    // Bugsnag error URL.
    const url = decodeSlackEntities(match[1]);
    if (extracted.includes(url) || missing.includes(url)) continue;
    missing.push(url);
  }
  return missing;
}

/**
 * Object keys whose string values are Slack plumbing, never message content:
 * ids, timestamps, colours, asset URLs, enum tags, layout hints. Everything not
 * listed here is treated as potential content by `collectUnrenderedText`.
 */
const PLUMBING_KEYS = new Set([
  'type', 'subtype', 'ts', 'id', 'user', 'team', 'channel', 'mrkdwn_in', 'verbatim',
  'emoji', 'short', 'style', 'indent', 'border', 'offset', 'length', 'range',
  'username', 'name', 'unicode', 'skin_tone', 'locale', 'lang', 'color', 'inviter',
  // Accessibility label. On an image *block* it is the only content and the
  // `image` case renders it; on an image *element* inside a context row it is
  // just an icon name ("vcs", "app").
  'alt_text',
  'mimetype', 'filetype', 'pretty_type', 'permalink', 'permalink_public',
  // Attachment author identity is carried structurally in `SlackAttachment.author`
  // (a resolved SlackAuthor), and the card path renders `author_name` when Slack
  // gave us no id to resolve — so these are never the only copy.
  'author_name', 'author_subname', 'author_link',
  // Deliberately rendered by the structural pass above; listing them here keeps
  // the same content from being reported twice when phrasing differs.
  'fallback', 'value',
]);

/**
 * Slack's naming is regular enough to classify plumbing by suffix, which beats
 * enumerating keys we haven't met yet (`canvas_update_section_ids` was not on
 * anyone's list). Content keys are plain nouns — `text`, `title`, `pretext`,
 * `footer`, `description`, `alt_text`.
 */
const PLUMBING_KEY_SUFFIX = /_(id|ids|ts|url|urls|icon|icons|users|type|subtype|color|code|link|team|hash|name|files)$/;

function isPlumbingKey(key: string): boolean {
  return PLUMBING_KEYS.has(key) || PLUMBING_KEY_SUFFIX.test(key);
}

/**
 * Normalise text before asking "did we already render this?".
 *
 * Slack ships the same content twice in different dialects: `blocks` carry
 * structure while the legacy `text` field carries mrkdwn (`*bold*`,
 * `<url|label>`). A raw substring test calls those a mismatch and reports the
 * whole message body as unrendered, which would bury the real signal.
 */
function normalizeForMatch(text: string): string {
  return decodeSlackEntities(text)
    // Link brackets become separators, not nothing: `<url|label>` names the same
    // target twice, and deleting the delimiters would weld the url's tail to the
    // label's head into a token ("comAshkenia") that matches nothing.
    .replace(/[<>|]/g, '/')
    .replace(/\b(?:https?:\/\/|mailto:)/g, '') // one dialect keeps the scheme, one drops it
    .replace(/[*_~`]/g, '')            // mrkdwn emphasis, absent from rich_text
    .replace(/[-•·‣]/g, '')            // list bullets: "- item" vs "• item"
    // Whitespace is dropped entirely, not collapsed: the two dialects disagree
    // about where paragraph and list breaks fall, and a break is never the only
    // thing a fragment contributes.
    .replace(/\s+/g, '');
}

/**
 * Words worth matching on: alphanumeric runs of 4+ characters, lowercased.
 * URL schemes are dropped because one dialect prints them and the other doesn't.
 * Derived from the ORIGINAL string, not the whitespace-stripped form — stripping
 * first welds "…#6887 archie/…" into the token "6887archie", which matches
 * nothing and reads as a loss.
 */
function contentTokens(text: string): string[] {
  return (decodeSlackEntities(text).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])
    .filter((token) => token !== 'http' && token !== 'https' && token !== 'mailto');
}

/**
 * Is `candidate` already accounted for in the rendered output?
 *
 * Exact containment first. Failing that, token coverage: the legacy `text` field
 * and `blocks` describe the same content in different dialects — mrkdwn
 * emphasis, different list bullets, and a link like `<http://x.com/a|x.com/a>`
 * that names its target twice where rich_text names it once. Requiring every
 * substantial word to appear somewhere, rather than the whole run verbatim,
 * tolerates the dialects without tolerating real loss: a dropped Jira link takes
 * its distinctive tokens with it.
 */
function isCovered(candidate: string, normalizedRendered: string, renderedTokens: Set<string>): boolean {
  const normalized = normalizeForMatch(candidate);
  if (!normalized) return true;
  if (normalizedRendered.includes(normalized)) return true;
  const tokens = contentTokens(candidate);
  if (tokens.length === 0) return false;
  return tokens.every((token) => renderedTokens.has(token));
}

/**
 * Whole subtrees with no message content, or content already handled by a
 * dedicated extractor (`files` → `[Files: …]`, `reactions` → `[Reactions: …]`,
 * `actions` → button labels).
 */
const PLUMBING_SUBTREES = new Set([
  'bot_profile', 'icons', 'profile', 'user_profile', 'edited', 'reactions', 'files',
  'metadata', 'third_party_auth', 'accessory', 'actions', 'root', 'shares',
  'pinned_info', 'pinned_to',
  // Interactive-control chrome, not message content: an app's overflow menu and
  // select options ("More actions…", "Why am I seeing this?").
  'placeholder', 'options', 'option_groups', 'initial_option', 'confirm',
]);

/** Cap on salvaged fragments, so a pathological payload can't flood the log. */
const MAX_UNRENDERED_FRAGMENTS = 10;
const MAX_UNRENDERED_FRAGMENT_CHARS = 300;

/**
 * Find text present in the raw Slack payload that our structural extraction did
 * not surface.
 *
 * This is the backstop that makes capture *reliable* rather than merely correct
 * today. Every extractor above is an allowlist — a `switch` over block types, a
 * fixed set of attachment fields — and Slack keeps shipping new shapes (smart
 * link chips, `markdown` and `table` blocks, Lists, canvases). An allowlist
 * meets a new shape by silently dropping it, which is exactly how a pasted Jira
 * link and a Grafana alert headline both vanished. So instead of trusting the
 * allowlist to be complete, walk the payload and diff: anything that looks like
 * human-readable text and does not already appear in the rendered output is
 * reported. The caller appends it (nothing is lost) and logs it (we find out,
 * and can then render it properly).
 *
 * Returns fragments in document order, deduped, each with its JSON path for the
 * log line.
 */
function collectUnrenderedText(
  payload: unknown,
  rendered: string,
): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = [];
  const seen = new Set<string>();
  const normalizedRendered = normalizeForMatch(rendered);
  const renderedTokens = new Set(contentTokens(rendered));

  const walk = (node: unknown, key: string, path: string): void => {
    if (found.length >= MAX_UNRENDERED_FRAGMENTS) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, key, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [childKey, child] of Object.entries(node)) {
        if (PLUMBING_SUBTREES.has(childKey)) continue;
        walk(child, childKey, path ? `${path}.${childKey}` : childKey);
      }
      return;
    }
    if (typeof node !== 'string') return;
    if (isPlumbingKey(key)) return;
    // Content is prose: it has letters. This filters ids, hex colours,
    // timestamps and enum-ish tokens without needing to name them all.
    if (!/\p{L}/u.test(node)) return;
    const text = node.trim();
    const normalized = normalizeForMatch(text);
    if (!normalized || seen.has(normalized) || isCovered(text, normalizedRendered, renderedTokens)) return;
    seen.add(normalized);
    found.push({ path, text: text.slice(0, MAX_UNRENDERED_FRAGMENT_CHARS) });
  };

  try {
    walk(payload, '', '');
  } catch (error) {
    // This is a diagnostic over an arbitrary third-party payload. It must never
    // be the reason a Slack message fails to reach an agent, so a fault here
    // degrades to "found nothing" rather than propagating out of the fetch.
    logger.warn('Slack', 'collectUnrenderedText failed; skipping the backstop for this message', error);
    return [];
  }
  return found;
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

    if (consumedTopBlocks) {
      // `text` is a first-class content field, not a lossless mirror of the
      // blocks: an app's notification headline ("Production release was
      // started!") often lives ONLY there.
      //
      // Reconciled line by line rather than as one blob. Taking the whole field
      // whenever any part of it was missing duplicated the entire message body
      // on 47 of 3,778 real messages — one unmatched line, usually a link,
      // dragged every already-rendered line in with it. Lines with no
      // substantial word are skipped (they carry nothing `recoverMissingUrls`
      // won't catch) so stray punctuation isn't echoed back.
      const body = ownParts.join('\n');
      const normalizedBody = normalizeForMatch(body);
      const bodyTokens = new Set(contentTokens(body));
      for (const line of String(msg.text ?? '').split('\n')) {
        const trimmed = line.trim();
        if (contentTokens(trimmed).length === 0) continue;
        if (isCovered(trimmed, normalizedBody, bodyTokens)) continue;
        ownParts.push(trimmed);
      }
      ownParts.push(...recoverMissingUrls(ownParts.join('\n'), msg.text));
    } else if (msg.text) {
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

    // Attachments (forwarded messages, shared content, unfurls, and every
    // bot-posted alert card). Each entry becomes one SlackAttachment with its
    // author + text correlated.
    const rawAttachments = msg.attachments as Array<{
      author_id?: string;
      author_name?: string;
      service_name?: string;
      text?: string;
      fallback?: string;
      pretext?: string;
      title?: string;
      title_link?: string;
      footer?: string;
      fields?: Array<{ title?: string; value?: string }>;
      blocks?: Array<unknown>;
      actions?: Array<{ text?: string; url?: string }>;
      message_blocks?: Array<{ message?: { user?: string; blocks?: Array<unknown> } }>;
    }> | undefined;

    const attachments: RawAttachment[] = [];
    if (rawAttachments && Array.isArray(rawAttachments)) {
      for (const att of rawAttachments) {
        if (!att || typeof att !== 'object') continue;
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

        if (consumedFromBlocks) {
          // A forwarded Slack message: the body came from message_blocks and the
          // author is resolved from `authorId`, so only the trailing provenance
          // line and an unresolvable author name are left to pick up.
          if (!authorId && att.author_name) seg.unshift(att.author_name);
          if (att.footer && !seg.includes(att.footer)) seg.push(att.footer);
          // The forwarder's own `text` is usually a duplicate of the blocks, but
          // not always — on a shared Slack message it can hold the pings that
          // aren't in the quoted body.
          const body = normalizeForMatch(seg.join('\n'));
          if (att.text && !body.includes(normalizeForMatch(att.text))) seg.push(att.text);
          seg.push(...recoverMissingUrls(seg.join('\n'), att.text || att.fallback));
        } else {
          // A bot-posted attachment is a card, not a paragraph: Grafana and
          // Alertmanager put the alert name in `title` and its dashboard URL in
          // `title_link`, the paged group in `pretext`, and Bugsnag puts the
          // error location in `fields`. Reading only `text`/`fallback` left the
          // agent with a bare "**Firing** / Value: C=1" and no idea which alert
          // fired or where to look.
          const push = (part: string | undefined) => {
            if (part && !seg.includes(part)) seg.push(part);
          };
          push(att.pretext);
          push(att.service_name ?? att.author_name);
          push(att.title && att.title_link ? `${att.title} (${att.title_link})` : att.title ?? att.title_link);
          const fieldLines = (Array.isArray(att.fields) ? att.fields : [])
            .filter((field) => field && typeof field === 'object')
            .map((field) => [field.title, field.value].filter(Boolean).join(': '))
            .filter(Boolean);
          // `fallback` is a flat restatement of the whole card, so when the
          // structured fields already say it (Bugsnag) printing both just
          // doubles the error string.
          const coveredByFields = (candidate: string | undefined) =>
            Boolean(candidate) && fieldLines.length > 0
            && isCovered(
              candidate!,
              normalizeForMatch(fieldLines.join('\n')),
              new Set(contentTokens(fieldLines.join('\n'))),
            );
          push(att.text || (coveredByFields(att.fallback) ? undefined : att.fallback));
          fieldLines.forEach(push);
          // Block Kit nested inside the attachment. Distinct from
          // `message_blocks` (a forwarded Slack message) and previously unread,
          // which is why a #bugs report's "Ticket" button rendered as the
          // fallback string "[no preview available]".
          for (const block of Array.isArray(att.blocks) ? att.blocks : []) {
            push(extractBlockText(block as { type: string; elements?: Array<unknown> }));
          }
          push(att.footer);
          for (const action of Array.isArray(att.actions) ? att.actions : []) {
            if (!action || typeof action !== 'object') continue;
            push(action.text ? `[${action.text}]${action.url ? ` ${action.url}` : ''}` : undefined);
          }
          seg.push(...recoverMissingUrls(seg.join('\n'), att.text || att.fallback));
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
  const extractBlockText = (block: { type: string; text?: { text?: string } | string; elements?: Array<unknown> }): string => {
    if (!block) return '';

    // `text` is an object on section/header, a bare string on markdown blocks.
    const blockText = typeof block.text === 'string' ? block.text : block.text?.text;

    switch (block.type) {
      case 'rich_text':
        // A rich_text block's direct children are paragraph-level: sections,
        // lists, quotes, code blocks. Render each separately and join on newline
        // — extractRichTextElements concatenates its input with no separator
        // (correct for the words *inside* a section, wrong across them, which
        // used to run a list straight onto the end of the preceding sentence).
        return (block.elements || [])
          .map((el) => extractRichTextElements([el]))
          .filter(Boolean)
          .join('\n');

      case 'section':
      case 'header':
      case 'markdown':
        // Single text payload. `markdown` is what Archie posts with; Slack
        // normally hands it back as rich_text, but not contractually.
        return blockText || '';

      case 'image':
        // Alt text / caption is the only readable content; the URL keeps the
        // reference resolvable.
        return [blockText, (block as { alt_text?: string }).alt_text, (block as { image_url?: string }).image_url]
          .filter(Boolean).join(' — ');

      case 'video': {
        const v = block as { title?: { text?: string }; description?: { text?: string }; title_url?: string };
        return [v.title?.text, v.description?.text, v.title_url].filter(Boolean).join(' — ');
      }

      case 'actions':
        // Button rows. The label plus its link is often the whole point of the
        // block (e.g. a bug tracker's "Ticket" button).
        return (block.elements ?? [])
          .map((el) => {
            const e = el as { text?: { text?: string }; url?: string };
            if (!e.text?.text) return '';
            return `[${e.text.text}]${e.url ? ` ${e.url}` : ''}`;
          })
          .filter(Boolean)
          .join(' ');

      case 'table': {
        // `rows` is a cell matrix, each cell its own rich_text block. Archie
        // posts markdown tables and Slack hands them back in this shape, so
        // without this the agent re-reading its own message sees no table at all.
        const rows = (block as { rows?: Array<Array<unknown>> }).rows;
        if (!Array.isArray(rows)) return '';
        return rows
          .filter((row): row is Array<unknown> => Array.isArray(row))
          .map((row) => `| ${row.map((cell) => extractBlockText(cell as { type: string })).join(' | ')} |`)
          .join('\n');
      }

      case 'card': {
        // Link-preview card (a GitHub PR unfurl, for one). Both halves are
        // mrkdwn, and the title is where the URL lives — `text` carries only the
        // flattened label.
        const card = block as { title?: { text?: string }; subtitle?: { text?: string } };
        return [card.title?.text, card.subtitle?.text].filter(Boolean).join('\n');
      }

      case 'divider':
        return '';

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
        // Unknown block type — Slack adds them (`table`, `markdown`, …) faster
        // than this switch grows. Salvage the two shapes every block follows
        // rather than returning nothing; `collectUnrenderedText` catches the
        // rest.
        if (blockText) return blockText;
        if (block.elements) return extractRichTextElements(block.elements);
        return '';
    }
  };

  /**
   * Extract text from rich_text elements recursively
   */
  const extractRichTextElements = (elements: Array<unknown>): string => {
    const parts: string[] = [];

    for (const element of elements) {
      // Slack's arrays are typed, but this walks a third-party payload — a
      // primitive or null where an element belongs must not take the whole
      // thread fetch down with it.
      if (!element || typeof element !== 'object') continue;
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

        case 'emoji': {
          // Slack's own text dialect spells a modified emoji `:pray::skin-tone-2:`.
          const skinTone = (el as { skin_tone?: number }).skin_tone;
          parts.push(skinTone ? `:${el.name}::skin-tone-${skinTone}:` : `:${el.name}:`);
          break;
        }

        // `attachment_mention` is the "smart link" chip a third-party app's
        // unfurl turns a pasted URL into — a Jira issue link is one, which is
        // exactly the element that used to make a linked ticket vanish. Same
        // shape as `link`: url plus a display label worth keeping (the ticket
        // title).
        case 'attachment_mention':
        case 'link': {
          // Keep the label when it says something the URL doesn't — "(details)"
          // on a Bugsnag link, a page title on a Notion one. Slack's own
          // auto-generated labels are just the truncated URL, so those collapse.
          const url = el.url ?? '';
          const label = el.text && !normalizeForMatch(url).includes(normalizeForMatch(el.text))
            ? el.text
            : undefined;
          parts.push(label ? `${label} (${url})` : url || el.text || '');
          break;
        }

        case 'canvas':
          // Canvas chip. Sometimes only a file id — which is itself the
          // information — and sometimes a docs URL alongside it.
          parts.push(
            `[canvas ${(el as { file_id?: string }).file_id}]`
            + (el.url ? ` ${el.url}` : ''),
          );
          break;

        case 'usergroup':
          // User group mention
          parts.push(`<!subteam^${(el as { usergroup_id?: string }).usergroup_id}>`);
          break;

        case 'broadcast':
          // @here, @channel, @everyone
          parts.push(`<!${(el as { range?: string }).range}>`);
          break;

        default:
          // Slack keeps adding rich_text element types for "smart link" chips
          // (message_mention, canvas, and whatever ships next). Salvage whatever
          // the unknown element carries rather than dropping it silently —
          // `recoverMissingUrls` below is the second line of defence.
          if (el.url) parts.push(el.url);
          else if (el.text) parts.push(el.text);
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
        if (!att || typeof att !== 'object') continue;
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
      .filter((r): r is { name: string; count?: number } => Boolean(r) && typeof r?.name === 'string')
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

    // Backstop: whatever the structural pass above failed to surface gets
    // appended here and logged, so a Slack shape we don't know about degrades
    // into slightly untidy text instead of silently disappearing.
    let ownTextWithResidue = ownText;
    // File ids count as accounted-for: Slack's text fallback for a file share is
    // the bare id, and we capture it structurally on `SlackFile.id` even though
    // only the name is printed.
    const fileNames = (files ?? []).map((f) => `${f.name} ${f.id}`).join('\n');
    const unrendered = collectUnrenderedText(
      msg,
      [ownText, ...attachments.map((a) => a.text), fileNames].join('\n'),
    );
    if (unrendered.length > 0) {
      logger.warn(
        'Slack',
        `Unrendered message content at ${unrendered.map((u) => u.path).join(', ')} ` +
        `(ts ${msg.ts}) — extend extractBlockText/extractMessageParts to render it properly`,
      );
      ownTextWithResidue = [ownText, `[unparsed: ${unrendered.map((u) => u.text).join(' | ')}]`]
        .filter(Boolean)
        .join('\n');
    }

    return {
      user: msg.user || '',
      text: applyMentionReplacements(ownTextWithResidue, userInfoMap, groupInfoMap, channelInfoMap),
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
 *
 * Returns `null` when the lookup FAILED, as distinct from `[]` meaning the channel
 * genuinely has no canvas tabs. Callers reconcile persisted state against this
 * list, so conflating the two would let one transient API error look like "every
 * canvas was removed" and discard standing channel context.
 */
export async function getChannelCanvasTabs(channelId: string): Promise<CanvasTab[] | null> {
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
    return null;
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
 * Run one raw Slack message payload through the full inbound extraction —
 * blocks, attachment cards, files, mention resolution, entity decoding — the
 * same path `fetchSlackThread` uses.
 *
 * For callers that hold a message payload directly rather than fetching a
 * thread, notably the `message_changed` edit handler. Resolving mentions alone
 * (`cleanSlackText`) leaves that caller with Slack's flat `text` fallback, so an
 * edited message rendered its links as raw `<url|label>` mrkdwn and anything
 * living in `blocks` or `attachments` did not survive at all.
 */
export async function extractMessageContent(
  message: unknown,
  channelId: string,
): Promise<{ text: string; attachments?: SlackAttachment[]; files?: SlackFile[] }> {
  const [resolved] = await resolveRawMessages([message as SlackHistoryMessage], channelId);
  if (!resolved) return { text: '' };
  const authorless = (resolved.attachments ?? []).map((a) => ({ text: a.text }));
  return {
    text: resolved.text,
    ...(authorless.length > 0 ? { attachments: authorless } : {}),
    ...(resolved.files?.length ? { files: resolved.files } : {}),
  };
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

/** A human in a task: the log's own mention marker, plus their job title. */
export interface TaskPerson {
  /** Slack user id — every decision (bot, external, title) is made from this. */
  id: string;
  /** The `<@ID:Name>` marker verbatim from the log, passed through untouched. */
  marker: string;
  /** `profile.title`, or `''` when we won't vouch for it. Callers must tolerate empty. */
  title: string;
}

/**
 * Maximum characters of a Slack job title we will place in a system prompt.
 * Real titles are short ("Backend Lead", "Full Stack Engineer | DAU Squad");
 * anything longer is being used as a payload, not a job title.
 */
const MAX_TITLE_LENGTH = 80;

/**
 * Flatten a job title to one short prompt-safe span.
 *
 * Two shapes are removed because this text lands in a system prompt. Newlines,
 * because a multi-line title could close the line it sits on and forge a new
 * prompt section. And angle brackets, so a title cannot write a tag at all —
 * stronger than cutting one known closing tag, and a job title has no legitimate
 * use for them. With no way to write `</people_in_task>`, the block that carries
 * these titles holds by construction.
 */
function sanitizeJobTitle(title: string): string {
  return title
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/**
 * Job titles for people we are willing to quote one for, keyed by user id.
 *
 * A job title is self-authored free text, so carrying one into a system prompt
 * extends trust to whoever wrote it. Excluded are external (Slack Connect) users
 * and home-workspace guests, whose profiles belong to people outside the org.
 * Unlike `isExternalUser`, which fails open to keep the bot usable, this fails
 * *closed*: with no home team we cannot tell insider from outsider, so the map is
 * empty and nobody gets a title. Same on any Slack failure — a missing title is
 * a cosmetic loss, and this feeds prompt context that must never block a spawn.
 */
async function loadTrustedJobTitles(): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (getHomeTeamId() === null) return titles;
  let users: SlackUserInfo[];
  try {
    users = await listWorkspaceUsers();
  } catch (error) {
    logger.warn('Slack', 'Failed to load job titles — omitting them', error);
    return titles;
  }
  for (const user of users) {
    if (isExternalUser(user) || !user.title) continue;
    titles.set(user.id, sanitizeJobTitle(user.title));
  }
  return titles;
}

/**
 * List the humans a task transcript names, as `{ id, name, title }`.
 *
 * Every marker (both bracket orders — see `restoreMentions`) is passed through
 * verbatim; only the id inside it is interpreted. That matters for more than
 * simplicity — on a shared channel `appendSlackMessage` masks an external
 * author's display name to "external" on purpose, and reassembling the marker
 * from user records would undo that.
 *
 * The only thing looked up is the job title, and only for people we will vouch
 * for (see `loadTrustedJobTitles`). Bots are skipped: `B…` ids and Archie's own
 * user id, so a workflow like "Report a bug" never reads as a colleague.
 * Order is first-seen.
 */
export async function resolvePeopleFromTranscript(transcript: string): Promise<TaskPerson[]> {
  const seen = new Map<string, string>();
  const re = /(?:@<|<@)([A-Z0-9]+):[^>]+>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(transcript)) !== null) {
    const [marker, id] = match;
    if (id.startsWith('B') || id === getBotUserId()) continue;
    if (!seen.has(id)) seen.set(id, marker);
  }
  if (seen.size === 0) return [];

  const titles = await loadTrustedJobTitles();
  return Array.from(seen, ([id, marker]) => ({ id, marker, title: titles.get(id) ?? '' }));
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
