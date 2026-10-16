import { getChannelInfo, getUserInfo, isExternalUser, postSlackMessage } from '../slack/client.js';
import { issueCode, revokeUser } from './connections.js';
import { logger } from '../../system/logger.js';

type RichText = { type?: string; text?: unknown; elements?: RichText[] };

// What the person typed lives in the rich_text blocks; `text` can carry more, e.g. a client's "Sent using <@app>" attribution.
function typedText(raw: unknown): string {
  const message = raw as { text?: unknown; blocks?: RichText[] } | null;
  const rich = Array.isArray(message?.blocks) ? message.blocks.filter((b) => b?.type === 'rich_text') : [];
  if (rich.length === 0) {
    return typeof message?.text === 'string' ? message.text : '';
  }
  const flatten = (node: RichText): string =>
    typeof node.text === 'string' ? node.text : (node.elements ?? []).map(flatten).join('');
  return rich.map(flatten).join('\n');
}

export async function handleClaudeCommand(event: { channel: string; user: string; thread_ts?: string; raw: unknown }): Promise<boolean> {
  const match = /^(dis)?connect claude[.!]?$/i.exec(typedText(event.raw).trim());
  if (!(event.channel.startsWith('D') && event.user && match)) {
    return false;
  }
  if (!match[1]) {
    // The external-author bail-out before this fails open on a lookup error; a credential must not.
    if (isExternalUser(await getUserInfo(event.user))) {
      return true;
    }
    const info = await getChannelInfo(event.channel);
    const code = await issueCode({ user_id: event.user, channel_id: event.channel, channel_name: info.name });
    await postSlackMessage({
      channel: event.channel,
      threadTs: event.thread_ts,
      text: `Your code for Claude: \`${code}\`\nPaste it into Claude within 10 minutes. It works once.\nSay \`disconnect claude\` here to disconnect Claude.`,
    });
    logger.system(`Issued a Claude connect code for ${event.user}`);
  } else {
    const removed = await revokeUser(event.user);
    await postSlackMessage({
      channel: event.channel,
      threadTs: event.thread_ts,
      text: removed > 0 ? 'Claude is disconnected. Say `connect claude` here to connect again.' : 'No Claude was connected.',
    });
    logger.system(`Revoked ${removed} Claude credential(s) for ${event.user}`);
  }
  return true;
}
