/**
 * Test support: an in-memory Slack workspace that hands out one client per member.
 *
 * It models the two Slack rules the persona tools lean on: a member can post to and read only
 * conversations they belong to, and a message is attributed to the member whose token posted
 * it. Refusals use Slack's own error codes and error shape.
 */

import type { PersonaSlack, SlackMessage } from './persona-actions.js';
import type { IdentifiableSlack } from './persona-clients.js';

interface Conversation {
  members: Set<string>;
  messages: SlackMessage[];
}

function slackError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
}

export class FakeWorkspace {
  private readonly conversations = new Map<string, Conversation>();
  private clock = 1_800_000_000;

  constructor(readonly teamId: string) {}

  addConversation(id: string, members: string[]): void {
    this.conversations.set(id, { members: new Set(members), messages: [] });
  }

  /** Put a message in a conversation directly, as Archie or any other app would. */
  seed(channel: string, message: SlackMessage): string {
    const ts = message.ts ?? this.nextTs();
    this.visible(channel, [...this.require(channel).members][0]).messages.push({ ...message, ts });
    return ts;
  }

  messagesIn(channel: string): SlackMessage[] {
    return this.require(channel).messages;
  }

  /** A client holding `userId`'s token. `teamId` lets a test hand out a token from elsewhere. */
  clientFor(userId: string, teamId: string = this.teamId): PersonaSlack & IdentifiableSlack {
    return {
      auth: { test: () => Promise.resolve({ team_id: teamId, user_id: userId }) },
      chat: {
        postMessage: ({ channel, text, thread_ts }) => {
          const ts = this.nextTs();
          this.visible(channel, userId).messages.push({ ts, user: userId, text, thread_ts });
          return Promise.resolve({ ts, channel });
        },
        update: ({ channel, ts, text }) => {
          this.ownMessage(channel, ts, userId).text = text;
          return Promise.resolve({ ts });
        },
        delete: ({ channel, ts }) => {
          const conversation = this.visible(channel, userId);
          const target = this.ownMessage(channel, ts, userId);
          conversation.messages.splice(conversation.messages.indexOf(target), 1);
          return Promise.resolve({});
        },
      },
      reactions: {
        add: ({ channel, timestamp, name }) => {
          const target = this.visible(channel, userId).messages.find((m) => m.ts === timestamp);
          if (!target) throw slackError('message_not_found');
          target.reactions = [...(target.reactions ?? []), { name, count: 1 }];
          return Promise.resolve({});
        },
      },
      conversations: {
        open: ({ users }) => {
          // One DM per pair, as in Slack: the same two members always get the same conversation.
          const id = `D${userId.slice(1)}${users.slice(-3)}`;
          if (!this.conversations.has(id)) this.addConversation(id, [userId, users]);
          return Promise.resolve({ channel: { id } });
        },
        history: ({ channel, limit }) => {
          const topLevel = this.visible(channel, userId).messages.filter(
            (m) => !m.thread_ts || m.thread_ts === m.ts,
          );
          // Slack returns the newest messages first.
          return Promise.resolve({ messages: topLevel.slice(-(limit ?? 100)).reverse() });
        },
        replies: ({ channel, ts }) => {
          const thread = this.visible(channel, userId).messages.filter(
            (m) => m.ts === ts || m.thread_ts === ts,
          );
          if (thread.length === 0) throw slackError('thread_not_found');
          return Promise.resolve({ messages: thread });
        },
      },
    };
  }

  private nextTs(): string {
    this.clock += 1;
    return `${this.clock}.000100`;
  }

  private require(channel: string): Conversation {
    const conversation = this.conversations.get(channel);
    if (!conversation) throw slackError('channel_not_found');
    return conversation;
  }

  /** Slack hides a conversation from a non-member as if it did not exist. */
  private visible(channel: string, userId: string): Conversation {
    const conversation = this.conversations.get(channel);
    if (!conversation?.members.has(userId)) throw slackError('channel_not_found');
    return conversation;
  }

  private ownMessage(channel: string, ts: string, userId: string): SlackMessage {
    const target = this.visible(channel, userId).messages.find((m) => m.ts === ts);
    if (!target) throw slackError('message_not_found');
    if (target.user !== userId) throw slackError('cant_update_message');
    return target;
  }
}
