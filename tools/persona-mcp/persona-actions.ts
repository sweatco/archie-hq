/**
 * What a persona can do in Slack through the API transport: post, reply, edit, delete, react
 * and read, each with that member's own user token.
 *
 * Slack attributes these posts to the member, but may also stamp them with the persona app's
 * identity. Whether Archie then treats them as human-authored is a property of the message,
 * reported by `read`, not something this module can promise.
 */

/** The fields of a Slack message this module reads. */
export interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  text?: string;
  reactions?: Array<{ name?: string; count?: number }>;
  blocks?: unknown[];
}

/** The slice of Slack's Web API the persona actions use; `WebClient` satisfies it. */
export interface PersonaSlack {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
    }): Promise<{ ts?: string; channel?: string }>;
    update(args: { channel: string; ts: string; text: string }): Promise<{ ts?: string }>;
    delete(args: { channel: string; ts: string }): Promise<unknown>;
  };
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
  conversations: {
    open(args: { users: string }): Promise<{ channel?: { id?: string } }>;
    history(args: { channel: string; limit?: number }): Promise<{ messages?: SlackMessage[] }>;
    replies(args: {
      channel: string;
      ts: string;
      limit?: number;
    }): Promise<{ messages?: SlackMessage[] }>;
  };
}

export interface PostedMessage {
  channel: string;
  ts: string;
}

export async function postAs(
  slack: PersonaSlack,
  message: { channel: string; text: string; threadTs?: string },
): Promise<PostedMessage> {
  const posted = await slack.chat.postMessage({
    channel: message.channel,
    text: message.text,
    ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
  });
  if (!posted.ts) throw new Error('Slack accepted the message but returned no ts');
  return { channel: posted.channel ?? message.channel, ts: posted.ts };
}

/** Post in the persona's own DM with Archie, opening it first if needed. */
export async function dmArchieAs(
  slack: PersonaSlack,
  archieBotUserId: string,
  message: { text: string; threadTs?: string },
): Promise<PostedMessage> {
  const opened = await slack.conversations.open({ users: archieBotUserId });
  const channel = opened.channel?.id;
  if (!channel) throw new Error('Slack did not return a DM channel with Archie');
  return postAs(slack, { channel, ...message });
}

export async function editAs(
  slack: PersonaSlack,
  edit: { channel: string; ts: string; text: string },
): Promise<void> {
  await slack.chat.update(edit);
}

export async function deleteAs(
  slack: PersonaSlack,
  target: { channel: string; ts: string },
): Promise<void> {
  await slack.chat.delete(target);
}

export async function reactAs(
  slack: PersonaSlack,
  reaction: { channel: string; ts: string; emoji: string },
): Promise<void> {
  await slack.reactions.add({
    channel: reaction.channel,
    timestamp: reaction.ts,
    name: reaction.emoji.replace(/^:|:$/g, ''),
  });
}

export interface MessageButton {
  actionId: string;
  value: string;
  label: string;
}

export interface SeenMessage {
  ts: string;
  threadTs: string | null;
  /** A member's user ID, or `bot:<id>` for a post with no member behind it. */
  author: string;
  /** True when Slack stamped the post with an app identity, even if a member is its author. */
  appAuthored: boolean;
  text: string;
  reactions: string[];
  buttons: MessageButton[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Collect the buttons of a message, at any depth of its blocks, in display order. */
function findButtons(node: unknown, found: MessageButton[] = []): MessageButton[] {
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, found);
  } else if (isRecord(node)) {
    if (node.type === 'button' && typeof node.action_id === 'string') {
      const text = isRecord(node.text) && typeof node.text.text === 'string' ? node.text.text : '';
      found.push({
        actionId: node.action_id,
        value: typeof node.value === 'string' ? node.value : '',
        label: text,
      });
    }
    for (const child of Object.values(node)) findButtons(child, found);
  }
  return found;
}

export function describeSeenMessage(message: SlackMessage): SeenMessage {
  return {
    ts: message.ts ?? '',
    threadTs: message.thread_ts ?? null,
    author: message.user ?? `bot:${message.bot_id ?? 'unknown'}`,
    appAuthored: Boolean(message.bot_id ?? message.app_id) || message.subtype === 'bot_message',
    text: message.text ?? '',
    reactions: (message.reactions ?? []).map(
      (reaction) => `${reaction.name ?? '?'}×${reaction.count ?? 0}`,
    ),
    buttons: findButtons(message.blocks ?? []),
  };
}

/**
 * Read a conversation, or one thread of it, exactly as the persona's token allows.
 * Slack refuses a conversation the member is not in; that refusal is the visibility check.
 */
export async function readAs(
  slack: PersonaSlack,
  target: { channel: string; threadTs?: string; limit?: number },
): Promise<SeenMessage[]> {
  const limit = target.limit ?? 20;
  const page = target.threadTs
    ? await slack.conversations.replies({ channel: target.channel, ts: target.threadTs, limit })
    : await slack.conversations.history({ channel: target.channel, limit });
  const messages = (page.messages ?? []).map(describeSeenMessage);
  // History arrives newest first and replies oldest first; return both oldest first.
  return messages.sort((a, b) => Number(a.ts) - Number(b.ts));
}

const NOT_VISIBLE = new Set(['channel_not_found', 'not_in_channel', 'thread_not_found']);

/** Turn a Slack API failure into a sentence that says what it means for this persona. */
export function describeSlackFailure(error: unknown, personaKey: string): string {
  const code =
    isRecord(error) && isRecord(error.data) && typeof error.data.error === 'string'
      ? error.data.error
      : undefined;
  if (code && NOT_VISIBLE.has(code)) {
    return `"${personaKey}" cannot see that conversation (Slack: ${code})`;
  }
  if (code === 'restricted_action_read_only_channel') {
    return `"${personaKey}" cannot post there: the conversation is read-only. For a DM with an app, its Messages tab does not accept messages (App Home → Messages Tab) (Slack: ${code})`;
  }
  if (code === 'missing_scope') {
    return `the persona app lacks a scope for this action (Slack: missing_scope); re-run authorize after updating the manifest`;
  }
  if (code) return `Slack refused the action for "${personaKey}": ${code}`;
  return error instanceof Error ? error.message : String(error);
}
