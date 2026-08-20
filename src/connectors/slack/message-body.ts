/**
 * The single place a Slack message becomes agent-facing text.
 *
 * Every path that shows a Slack message to an agent — knowledge log, title generation, channel pins, edit re-renders, explore reads — routes through `renderMessageBody` here. Keeping one renderer is what makes the rendering rules (redaction placeholder, forwarded-from provenance, attachment and reaction suffixes) consistent across those paths instead of drifting per call site, and it means a change to how messages read is a single edit rather than a hunt.
 */

import type { SlackFile, SlackAttachment, SlackReaction, SlackAuthor } from '../../types/index.js';
import { isTrustedIngestAuthor, extractMessageContent } from './client.js';

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
    // An attachment whose author could not be resolved is labelled like an
    // external one: unknown provenance must not read as the forwarder's words.
    if (att.author && !isTrustedIngestAuthor(att.author)) {
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
 * The single place the redaction question is answered: a message is redacted unless its author is positively verified as a home-workspace human (or an allowlisted automation).
 *
 * The verdict deliberately ignores whether the channel is currently shared. A transcript outlives that state, and a guest or a relay app in an ordinary channel is no more accountable for its content than a Slack Connect member in a shared one.
 */
export function shouldRedact(msg: { user: SlackAuthor }): boolean {
  return !isTrustedIngestAuthor(msg.user);
}

/**
 * Render an ingested thread message: apply the redaction policy, then render.
 *
 * The parameter is typed structurally rather than as `SlackThreadMessage` so this module keeps no dependency on the task types beyond the message-part shapes it actually reads.
 */
export function messageBody(msg: SlackMessageParts & { user: SlackAuthor }): string {
  return renderMessageBody(msg, { redacted: shouldRedact(msg) });
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
 * Render a pinned message for the channel pin index.
 *
 * Two things are deliberate here and both are load-bearing. Reactions are excluded because the rendered string feeds `digestOf` in the pin index, which is what makes "re-summarise once when the pin is edited" work — reactions change without the pin ever being edited, so digesting them would spend a model call per emoji forever. And the render is unredacted because pins are gated upstream by a two-principal trust check that DROPS an externally-authored or externally-pinned item outright before it can reach a renderer, so there is nothing here for a redaction policy to decide.
 *
 * Existing as a named function rather than an inline `renderMessageBody(..., { redacted: false, includeReactions: false })` at the call site is the point: it keeps the pin path from being a second place that answers the redaction question, and keeps the partial `ownText` field read inside this module.
 */
export function pinBody(pin: SlackMessageParts | { ownText?: string; files?: SlackFile[]; attachments?: SlackAttachment[]; reactions?: SlackReaction[] }): string {
  return renderMessageBody(
    { ownText: pin.ownText ?? '', attachments: pin.attachments, files: pin.files, reactions: pin.reactions },
    { redacted: false, includeReactions: false },
  );
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
