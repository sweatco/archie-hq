/**
 * The single place a Slack message becomes agent-facing text.
 *
 * Every path that shows a Slack message to an agent — knowledge log, title generation, channel pins, edit re-renders, explore reads — routes through `renderMessageBody` here. Keeping one renderer is what makes the rendering rules (redaction placeholder, forwarded-from provenance, attachment and reaction suffixes) consistent across those paths instead of drifting per call site, and it means a change to how messages read is a single edit rather than a hunt.
 */

import type { SlackFile, SlackAttachment, SlackReaction, SlackAuthor } from '../../types/index.js';
import { isExternalUser, extractMessageContent } from './client.js';

/**
 * The exact text substituted for a redacted message body. Consumers that need to recognise a redacted body (e.g. deciding whether a transcript has usable content) must compare against this constant rather than re-declaring the literal, so the placeholder text stays a single fact.
 */
export const REDACTION_PLACEHOLDER = '[redacted: external participant in shared channel]';

/** The parts of a Slack message that contribute to its rendered body. */
export interface SlackMessageParts {
  ownText: string;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  reactions?: SlackReaction[];
}

/**
 * Render the body of a Slack message for context (knowledge log, title generator, etc.).
 *
 * Single source of truth for redaction + forwarded-attachment rendering.
 * - Redacted: fixed placeholder.
 * - With externally-authored attachment: forwarder's text first, then a
 *   provenance label, then the forwarded content. Other (non-external)
 *   attachments fold into the inline body.
 * - Normal: author's text plus inline attachments and file list.
 *
 * `includeReactions` defaults to true; pass false for consumers where reactions are noise or would destabilise a derived value (the pin path feeds the body into a content digest, and a reaction arriving would otherwise look like an edit).
 */
export function renderMessageBody(
  parts: SlackMessageParts,
  options: { redacted: boolean; includeReactions?: boolean }
): string {
  if (options.redacted) {
    return REDACTION_PLACEHOLDER;
  }

  const inlineParts: string[] = [];
  if (parts.ownText) inlineParts.push(parts.ownText);

  let forwardedBlock = '';
  for (const att of parts.attachments ?? []) {
    if (att.author && isExternalUser(att.author)) {
      // Render the externally-authored attachment under a provenance label.
      // Only the first one gets the label block; subsequent ones (rare)
      // fold inline so the agent still sees them.
      if (!forwardedBlock) {
        const teamSuffix = att.author.teamId ? `, team ${att.author.teamId}` : '';
        const label = `[forwarded from <@${att.author.id}:${att.author.realName}> — external${teamSuffix}]`;
        forwardedBlock = `${label}\n${att.text}`;
        continue;
      }
    }
    if (att.text) inlineParts.push(att.text);
  }
  if (forwardedBlock) inlineParts.push(forwardedBlock);

  let fullMessage = inlineParts.join('\n');

  if (parts.files && parts.files.length > 0) {
    const fileInfo = parts.files.map(f => {
      const pathInfo = f.localPath ? ` (${f.localPath})` : '';
      return `${f.name}${pathInfo}`;
    }).join(', ');
    fullMessage += `\n  [Attachments: ${fileInfo}]`;
  }

  if (options.includeReactions !== false && parts.reactions && parts.reactions.length > 0) {
    const reactionInfo = parts.reactions
      .map((r) => `:${r.name}:${r.count > 1 ? ` ×${r.count}` : ''}`)
      .join(', ');
    fullMessage += `\n  [Reactions: ${reactionInfo}]`;
  }

  return fullMessage;
}

/**
 * The single place the redaction question is answered: a message is redacted when the channel is shared with an external workspace (Slack Connect) *and* the message's author is external to the home team.
 *
 * Routing every path through this predicate is what lets the redaction rule change in one edit — no call site re-derives `shared && isExternalUser(...)` for itself.
 */
export function shouldRedact(msg: { user: SlackAuthor }, ctx: { shared: boolean }): boolean {
  return ctx.shared && isExternalUser(msg.user);
}

/**
 * Render an ingested thread message: apply the redaction policy, then render.
 *
 * The parameter is typed structurally rather than as `SlackThreadMessage` so this module keeps no dependency on the task types beyond the message-part shapes it actually reads.
 */
export function messageBody(msg: SlackMessageParts & { user: SlackAuthor }, ctx: { shared: boolean }): string {
  return renderMessageBody(msg, { redacted: shouldRedact(msg, ctx) });
}

/**
 * Render a message read by an explore tool (`read_channel_history` / `read_thread`).
 *
 * Explore reads are deliberately never redacted: the agent asked to look at a channel, and redacting there would hand back a wall of placeholders instead of the content it went to read. This is the one sanctioned unredacted path, and it exists as a named function so the decision is greppable in a single place rather than scattered as inline `redacted: false` literals whose intent nobody can audit.
 */
export function exploreBody(msg: SlackMessageParts): string {
  return renderMessageBody(msg, { redacted: false });
}

/**
 * Render a raw Slack message payload by running it through the full inbound extraction first (blocks, attachment cards, files, mention resolution) — for callers holding a payload rather than a fetched thread, notably the `message_changed` edit handler.
 *
 * This path cannot emit the forwarded-from-external provenance label: `extractMessageContent` strips attachment authors, handing back an authorless `{ text }` shape, so `renderMessageBody` has no author to classify. Extraction may also yield neither attachments nor files at all (a bare `{ text: '' }` when the resolver produces nothing), which renders as an empty body.
 */
export async function rawMessageBody(raw: unknown, channelId: string): Promise<string> {
  const extracted = await extractMessageContent(raw, channelId);
  return renderMessageBody(
    { ownText: extracted.text, attachments: extracted.attachments, files: extracted.files },
    { redacted: false },
  );
}
