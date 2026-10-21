// SPDX-License-Identifier: AGPL-3.0-or-later
import { getSlackClient, getHomeTeamId, getBotId, getBotUserId, postSlackMessage, extractMessageContent, isSlackDryRun, buildThreadUrl } from '../connectors/slack/client.js';
import { exploreBody } from '../connectors/slack/message-body.js';
import { WebClient } from '@slack/web-api';
import { getActiveTaskIds, getTask } from '../tasks/task.js';
import type { Delivery, SourceMessage } from '../memory/observation-types.js';

export interface SourceAccess { shared: boolean; ownerCanRead: boolean }
export interface SlackPage { messages: SourceMessage[]; cursor?: string }

export interface ObservationSlack {
  inspect(channel: string, verifyOwner?: boolean): Promise<SourceAccess | null>;
  channels(): Promise<string[]>;
  page(channel: string, oldest: string, latest: string, cursor?: string, thread?: string): Promise<SlackPage>;
  ownerDm(): Promise<string>;
  verifyDm(channel: string): Promise<boolean>;
  send(delivery: Delivery): Promise<string | undefined>;
  find(delivery: Delivery): Promise<string | undefined>;
  active(channel: string, thread: string): boolean;
  link(channel: string, thread: string): string;
}

type Payload = Record<string, unknown>;

export async function normalizeSlackSource(raw: Payload, channel: string, context = false): Promise<SourceMessage | null> {
  const edited = raw.edited as { ts?: string } | undefined;
  const ts = typeof raw.ts === 'string' ? raw.ts : '';
  if (!ts || (typeof raw.user !== 'string' && typeof raw.bot_id !== 'string')) return null;
  // The common renderer receives no attachment bodies, downloads or external-link expansion.
  const content = await extractMessageContent({ ...raw, files: [], attachments: [] }, channel);
  return {
    channel, thread: typeof raw.thread_ts === 'string' ? raw.thread_ts : ts, ts,
    version: edited?.ts ?? ts, author: String(raw.user ?? raw.bot_id),
    text: exploreBody({ ownText: content.text }),
    own: raw.user === getBotUserId() || (raw.bot_id !== undefined && raw.bot_id === getBotId()), context,
    bot: typeof raw.bot_id === 'string' || typeof raw.app_id === 'string' || !!raw.bot_profile || raw.subtype === 'bot_message' || raw.user === 'USLACKBOT',
  };
}

export class PublicSlack implements ObservationSlack {
  private readonly client = new WebClient(getSlackClient().token, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 15_000 });
  constructor(private readonly owner: string) {}

  async inspect(channel: string, verifyOwner = false): Promise<SourceAccess | null> {
    if (!/^C[A-Z0-9]+$/.test(channel) || !getHomeTeamId()) return null;
    const result = await this.client.conversations.info({ channel });
    const c = result.channel;
    if (!c || c.is_private !== false || c.is_im !== false || c.is_mpim !== false || c.is_member !== true || c.is_archived !== false
      || typeof c.is_shared !== 'boolean' || typeof c.is_ext_shared !== 'boolean' || typeof c.is_pending_ext_shared !== 'boolean') return null;
    let cursor: string | undefined;
    let ownerCanRead = false;
    while (verifyOwner) {
      const page = await this.client.conversations.members({ channel, cursor, limit: 200 });
      ownerCanRead ||= page.members?.includes(this.owner) === true;
      cursor = page.response_metadata?.next_cursor || undefined;
      if (!cursor || ownerCanRead) break;
    }
    return { shared: c.is_shared || c.is_ext_shared || c.is_pending_ext_shared, ownerCanRead };
  }

  async channels(): Promise<string[]> {
    const channels: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.users.conversations({ types: 'public_channel', exclude_archived: true, limit: 200, cursor });
      for (const c of page.channels ?? []) if (c.id) channels.push(c.id);
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return channels;
  }

  async page(channel: string, oldest: string, latest: string, cursor?: string, thread?: string): Promise<SlackPage> {
    if (!await this.inspect(channel)) throw new Error('Public source unavailable');
    const args = { channel, oldest, latest, cursor, inclusive: true, limit: 200 };
    const page = thread
      ? await this.client.conversations.replies({ ...args, ts: thread })
      : await this.client.conversations.history(args);
    const messages: SourceMessage[] = [];
    for (const raw of page.messages ?? []) {
      const message = await normalizeSlackSource(raw as Payload, channel);
      if (message) messages.push(message);
    }
    if (!await this.inspect(channel)) throw new Error('Source changed audience during collection');
    return { messages, cursor: page.response_metadata?.next_cursor || undefined };
  }

  private async verifyOwner(): Promise<void> {
    const result = await this.client.users.info({ user: this.owner });
    const user = result.user;
    if (!user || user.team_id !== getHomeTeamId() || user.is_restricted !== false || user.is_ultra_restricted !== false
      || user.is_bot !== false || user.is_app_user === true || user.deleted !== false) throw new Error('Unverified initiative owner');
  }

  async ownerDm(): Promise<string> {
    await this.verifyOwner();
    const result = await this.client.conversations.open({ users: this.owner });
    if (!result.channel?.id || !await this.verifyDm(result.channel.id)) throw new Error('Owner DM unavailable');
    return result.channel.id;
  }

  async verifyDm(channel: string): Promise<boolean> {
    if (!/^D[A-Z0-9]+$/.test(channel)) return false;
    await this.verifyOwner();
    const result = await this.client.conversations.info({ channel });
    const conversation = result.channel as { is_im?: boolean; user?: string } | undefined;
    return conversation?.is_im === true && conversation.user === this.owner;
  }

  send(delivery: Delivery): Promise<string | undefined> {
    if (isSlackDryRun()) return Promise.resolve(undefined);
    return postSlackMessage({ channel: delivery.channel, threadTs: delivery.thread ?? undefined,
      text: delivery.text.replace(/<!(?:channel|here|everyone)>/g, '[group mention]'), correlationId: delivery.id,
      actions: delivery.matters.length === 1 ? ['handled', 'later', 'not useful', 'stop following'].map((action) => ({
        type: 'button', text: { type: 'plain_text', text: action }, action_id: `initiative_${action.replaceAll(' ', '_')}`,
        value: `${delivery.id}:${action}`,
      })) : undefined,
    });
  }

  async find(delivery: Delivery): Promise<string | undefined> {
    // Owner-DM reconciliation examines only our outbound correlation IDs; no DM content is ingested.
    if (delivery.channel.startsWith('D') ? !await this.verifyDm(delivery.channel) : !await this.inspect(delivery.channel)) return undefined;
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 10; pageNo++) {
      const args = { channel: delivery.channel, cursor, oldest: String(delivery.created / 1000 - 60), include_all_metadata: true, limit: 200 };
      const page = delivery.thread
        ? await this.client.conversations.replies({ ...args, ts: delivery.thread })
        : await this.client.conversations.history(args);
      const found = page.messages?.find((m) => m.metadata?.event_type === 'archie_initiative'
        && (m.metadata.event_payload as Record<string, unknown> | undefined)?.delivery === delivery.id && (m.user === getBotUserId() || m.bot_id === getBotId()));
      if (found?.ts) return found.ts;
      cursor = page.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return undefined;
  }

  active(channel: string, thread: string): boolean {
    return getActiveTaskIds().some((id) => {
      const task = getTask(id);
      return task?.agent?.session.active === true && Object.values(task.metadata.channels).some((c) => c.type === 'slack' && c.channel_id === channel && c.thread_id === thread);
    });
  }

  link(channel: string, thread: string): string { return buildThreadUrl(channel, thread) ?? `https://app.slack.com/archives/${channel}/p${thread.replace('.', '')}`; }
}
