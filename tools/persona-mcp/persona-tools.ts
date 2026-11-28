/**
 * The MCP tools of the persona server: one tool per persona action, plus the setup notice
 * shown on a machine without a persona config. Kept apart from server.ts so the tools can be
 * exercised over an in-memory MCP connection with stand-in Slack clients.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PersonaConfig } from './config.js';
import {
  deleteAs,
  describeSlackFailure,
  dmArchieAs,
  editAs,
  postAs,
  reactAs,
  readAs,
  type PersonaSlack,
} from './persona-actions.js';
import type { ActingPersona } from './persona-clients.js';
import { sendSyntheticClick } from './synthetic-click.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
export type Actor = ActingPersona<PersonaSlack>;

/** What `click_as` needs beyond the config: the secret, read only when a click is sent. */
export interface SyntheticClicks {
  readSigningSecret: () => Promise<string>;
  send?: typeof fetch;
}

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});
const failure = (message: string): ToolResult => ({ ...text(message), isError: true });

const persona = z.string().describe('Persona key from list_personas, such as "alice"');
const channel = z.string().describe('Slack conversation ID (C…, G… or D…)');
const messageTs = z.string().describe('Slack message timestamp, such as "1800000000.000100"');

export function registerSetupNotice(server: McpServer, missingConfigPath: string): void {
  server.tool(
    'list_personas',
    'List the test personas this machine can act as. None are configured yet.',
    () =>
      text(
        `No persona config at ${missingConfigPath}. Follow docs/guides/slack-test-personas.md to set one up.`,
      ),
  );
}

export function registerPersonaTools(
  server: McpServer,
  config: PersonaConfig,
  actors: Actor[],
  clicks: SyntheticClicks,
): void {
  /** Run an action as one persona, turning an unknown key or a Slack refusal into a tool error. */
  async function actAs(
    personaKey: string,
    action: (actor: Actor) => Promise<unknown>,
  ): Promise<ToolResult> {
    const actor = actors.find((candidate) => candidate.persona.key === personaKey);
    if (!actor) {
      const known = actors.map((candidate) => candidate.persona.key).join(', ');
      return failure(`unknown persona "${personaKey}" (configured: ${known})`);
    }
    try {
      return text(await action(actor));
    } catch (error) {
      return failure(describeSlackFailure(error, personaKey));
    }
  }

  server.tool(
    'list_personas',
    'List the test personas this machine can act as, with the Slack IDs a scenario needs: each member, Archie, and the public channel they share.',
    () =>
      text({
        environment: config.environment,
        archieBotUserId: config.archieBotUserId ?? null,
        sharedChannelId: config.probeChannelId ?? null,
        personas: actors.map(({ persona: p }) => ({ key: p.key, slackUserId: p.slackUserId })),
      }),
  );

  server.tool(
    'post_as',
    'Post a top-level message in a conversation as a persona. To address Archie in a channel, start the text with <@ARCHIE_BOT_USER_ID>. Returns the channel and ts.',
    { persona, channel, text: z.string().describe('Message text; include a fresh nonce') },
    ({ persona: key, channel: target, text: body }) =>
      actAs(key, ({ slack }) => postAs(slack, { channel: target, text: body })),
  );

  server.tool(
    'reply_as',
    'Reply in a thread as a persona. Returns the channel and ts.',
    { persona, channel, thread_ts: messageTs, text: z.string() },
    ({ persona: key, channel: target, thread_ts, text: body }) =>
      actAs(key, ({ slack }) =>
        postAs(slack, { channel: target, text: body, threadTs: thread_ts }),
      ),
  );

  const { archieBotUserId } = config;
  if (archieBotUserId) {
    server.tool(
      'dm_archie_as',
      "Post in a persona's own DM with Archie, opening it if needed. Returns the DM channel and ts; pass thread_ts to continue a thread there.",
      { persona, text: z.string(), thread_ts: messageTs.optional() },
      ({ persona: key, text: body, thread_ts }) =>
        actAs(key, ({ slack }) =>
          dmArchieAs(slack, archieBotUserId, { text: body, threadTs: thread_ts }),
        ),
    );
  }

  server.tool(
    'edit_as',
    'Replace the text of a message the persona posted.',
    { persona, channel, ts: messageTs, text: z.string() },
    ({ persona: key, channel: target, ts, text: body }) =>
      actAs(key, async ({ slack }) => {
        await editAs(slack, { channel: target, ts, text: body });
        return { edited: ts };
      }),
  );

  server.tool(
    'delete_as',
    'Delete a message the persona posted.',
    { persona, channel, ts: messageTs },
    ({ persona: key, channel: target, ts }) =>
      actAs(key, async ({ slack }) => {
        await deleteAs(slack, { channel: target, ts });
        return { deleted: ts };
      }),
  );

  server.tool(
    'react_as',
    'Add an emoji reaction to a message as a persona.',
    { persona, channel, ts: messageTs, emoji: z.string().describe('Emoji name, such as "eyes"') },
    ({ persona: key, channel: target, ts, emoji }) =>
      actAs(key, async ({ slack }) => {
        await reactAs(slack, { channel: target, ts, emoji });
        return { reacted: emoji };
      }),
  );

  server.tool(
    'read_as',
    'Read a conversation, or one thread of it, exactly as a persona can see it: oldest first, with authors, reactions, buttons and whether Slack marked each message as app-authored. Fails if that member cannot see the conversation.',
    {
      persona,
      channel,
      thread_ts: messageTs.optional().describe('Read this thread instead of the conversation'),
      limit: z.number().int().min(1).max(100).optional().describe('Messages to return (20)'),
    },
    ({ persona: key, channel: target, thread_ts, limit }) =>
      actAs(key, ({ slack }) => readAs(slack, { channel: target, threadTs: thread_ts, limit })),
  );

  const { slackWebhookUrl, signingSecret } = config;
  if (slackWebhookUrl && signingSecret) {
    server.tool(
      'click_as',
      "SYNTHETIC: press a button on a message as a persona by sending the instance a signed request, without Slack in between. Proves the handler's checks, not that Slack showed the button to that member; label it as synthetic in evidence. Take action_id and value from read_as. Needs the instance to run the HTTP receiver.",
      {
        persona,
        channel,
        ts: messageTs.describe('The message that carries the button'),
        thread_ts: messageTs.optional().describe('threadTs of that message, from read_as'),
        action_id: z.string(),
        value: z.string().optional(),
      },
      ({ persona: key, channel: target, ts, thread_ts, action_id, value }) =>
        actAs(key, async ({ persona: p }) =>
          sendSyntheticClick(
            { webhookUrl: slackWebhookUrl, signingSecret: await clicks.readSigningSecret() },
            {
              teamId: config.teamId,
              userId: p.slackUserId,
              channelId: target,
              messageTs: ts,
              threadTs: thread_ts,
              actionId: action_id,
              value,
            },
            undefined,
            clicks.send,
          ),
        ),
    );
  }
}
