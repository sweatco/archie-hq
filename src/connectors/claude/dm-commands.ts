import { getChannelInfo, postSlackMessage } from '../slack/client.js';
import { issueCode, revokeUser } from './connections.js';
import { logger } from '../../system/logger.js';

export async function handleClaudeCommand(event: { channel: string; user: string; thread_ts?: string; raw: unknown }): Promise<boolean> {
  const text = typeof (event.raw as { text?: unknown } | null)?.text === 'string' ? (event.raw as { text: string }).text.trim() : '';
  const match = /^(dis)?connect claude[.!]?$/i.exec(text);
  if (!(event.channel.startsWith('D') && event.user && match)) {
    return false;
  }
  if (!match[1]) {
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
