/**
 * Engine-level DM commands: `connect <server>`, `disconnect <server>` and `connections`. They are answered here and never reach the PM.
 */

import { getUserInfo, isInternalMemoryUser, postSlackMessage } from './client.js';
import { beginConnect, publicRedirectUri } from '../../system/oauth/connect.js';
import { deletePersonalRecord, listPersonalRecords } from '../../system/oauth/storage.js';
import { logger } from '../../system/logger.js';

function flatten(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const { type, text, elements } = node as { type?: unknown; text?: unknown; elements?: unknown };
  if (type === 'text') return typeof text === 'string' ? text : '';
  return Array.isArray(elements) ? elements.map((child) => flatten(child)).join('') : '';
}

/** What the person typed. The rich_text blocks win over `text` because a client can append attribution to `text`. Never throws. */
export function typedText(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const { blocks, text } = raw as { blocks?: unknown; text?: unknown };
  const richText = Array.isArray(blocks)
    ? blocks.filter((block) => !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'rich_text')
    : [];
  if (richText.length > 0) return richText.map((block) => flatten(block)).join('\n');
  return typeof text === 'string' ? text : '';
}

export async function handleDmCommand(event: {
  channel: string;
  user: string;
  ts: string;
  thread_ts?: string;
  raw: unknown;
}): Promise<boolean> {
  // Must return before touching any import for a non-command: other Slack suites mock the client without these exports.
  if (typeof event.channel !== 'string' || !event.channel.startsWith('D') || !event.user) return false;
  const text = typedText(event.raw).trim().toLowerCase();
  const match = /^(connect|disconnect)\s+(\S+)$/.exec(text);
  if (text !== 'connections' && !match) return false;

  const reply = (body: string) => postSlackMessage({ channel: event.channel, threadTs: event.thread_ts, text: body });

  try {
    let internal: boolean;
    try {
      internal = isInternalMemoryUser(await getUserInfo(event.user));
    } catch (err) {
      logger.warn('Slack', `Could not look up the author of a DM command ${event.user}`, err);
      await reply("I couldn't confirm your Slack account just now, so I can't change connections. Try again in a minute.");
      return true;
    }
    if (!internal) {
      logger.system(`Ignoring a DM command from ${event.user}, who is not an internal member`);
      return true;
    }

    if (!match) {
      const records = await listPersonalRecords(event.user);
      if (records.length === 0) {
        await reply("You haven't connected anything yet. Say `connect <name>` to use one of my tools with your own account.");
      } else {
        const lines = records.map(
          (record) => `• \`${record.server_name}\`, connected ${new Date(record.created_at * 1000).toISOString().slice(0, 10)}`,
        );
        await reply(`Your connections:\n${lines.join('\n')}\nSay \`disconnect <name>\` to remove one.`);
      }
    } else {
      const [, verb, name] = match;
      if (verb === 'connect') {
        const { authorizeUrl } = await beginConnect({
          serverName: name,
          redirectUri: publicRedirectUri(),
          person: { slackUserId: event.user, channelId: event.channel, threadTs: event.thread_ts },
        });
        await reply(`Open this link to connect \`${name}\` with your own account. It works once and expires in an hour.\n[Connect ${name}](${authorizeUrl})`);
      } else {
        const removed = await deletePersonalRecord(event.user, name);
        await reply(removed ? `Disconnected \`${name}\`.` : `\`${name}\` wasn't connected.`);
      }
    }
  } catch (err) {
    logger.error('Slack', `DM command failed for ${event.user}`, err);
    const message = err instanceof Error ? err.message : String(err);
    await reply(`That didn't work: ${message}`).catch(() => {});
  }
  return true;
}
