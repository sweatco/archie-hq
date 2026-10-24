/**
 * The `/archie` slash command (name set by ARCHIE_SLASH_COMMAND): `connect <server>`, `disconnect <server>` and `connections`, answered by the engine and never by the PM. Every reply is ephemeral, so the authorize link is visible only to the caller and never lands in channel history.
 */

import type { App as AppType } from '@slack/bolt';
import { getChannelInfo, getUserInfo, isInternalMemoryUser } from './client.js';
import { beginConnect, publicRedirectUri } from '../../system/oauth/connect.js';
import { deletePersonalRecord, listPersonalRecords } from '../../system/oauth/storage.js';
import { logger } from '../../system/logger.js';

const USAGE = 'Say `connect <server>`, `disconnect <server>` or `connections`.';

export function registerConnectCommand(boltApp: Pick<AppType, 'command'>): void {
  const name = process.env.ARCHIE_SLASH_COMMAND?.trim() || '/archie';
  boltApp.command(name, async ({ command, ack, respond }) => {
    await ack();
    const text = await connectCommandReply(command);
    await respond({ response_type: 'ephemeral', text }).catch((err) => logger.warn('Slack', `Could not answer ${name}`, err));
  });
  logger.plain(`Slack command: ${name}`);
}

export async function connectCommandReply(command: { user_id: string; channel_id: string; text: string }): Promise<string> {
  const channel = command.channel_id.startsWith('D') ? await getChannelInfo(command.channel_id) : null;
  if (!channel?.isIm || channel.imUserId !== command.user_id) return 'Use this in your DM with Archie.';

  let internal: boolean;
  try {
    internal = isInternalMemoryUser(await getUserInfo(command.user_id));
  } catch (err) {
    logger.warn('Slack', `Could not look up ${command.user_id} for a connect command`, err);
    return "I couldn't confirm your Slack account just now, so I can't change connections. Try again in a minute.";
  }
  if (!internal) return 'Only members of this workspace can connect their own accounts.';

  const text = command.text.trim().toLowerCase();
  const match = /^(connect|disconnect)\s+(\S+)$/.exec(text);
  if (text !== 'connections' && !match) return USAGE;

  try {
    if (!match) {
      const records = await listPersonalRecords(command.user_id);
      if (records.length === 0) {
        return "You haven't connected anything yet. Use `connect <name>` to use one of my tools with your own account.";
      }
      const lines = records.map(
        (record) => `• \`${record.server_name}\`, connected ${new Date(record.created_at * 1000).toISOString().slice(0, 10)}`,
      );
      return `Your connections:\n${lines.join('\n')}\nUse \`disconnect <name>\` to remove one.`;
    }
    const [, verb, name] = match;
    if (verb === 'connect') {
      const { authorizeUrl } = await beginConnect({
        serverName: name,
        redirectUri: publicRedirectUri(),
        person: { slackUserId: command.user_id, channelId: command.channel_id },
      });
      return `Open this link to connect \`${name}\` with your own account. It works once and expires in an hour.\n[Connect ${name}](${authorizeUrl})`;
    }
    const removed = await deletePersonalRecord(command.user_id, name);
    return removed ? `Disconnected \`${name}\`.` : `\`${name}\` wasn't connected.`;
  } catch (err) {
    logger.error('Slack', `Connect command failed for ${command.user_id}`, err);
    const message = err instanceof Error ? err.message : String(err);
    return `That didn't work: ${message}`;
  }
}
