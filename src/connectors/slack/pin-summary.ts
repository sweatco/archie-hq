/**
 * One-line index entries for pinned Slack messages.
 *
 * A pin that is already short is its own best index entry, so it is used verbatim; only a long one is worth a Haiku call, and then exactly one. Any model failure — a bad subtype, output that misses the schema, a thrown error — falls back to truncating the original rather than dropping the pin, because a pin missing from the index is indistinguishable from nothing being pinned: the agent cannot tell "we failed to summarise this" from "the channel has no standing context", and silently answering as if the channel were empty is worse than a blunt truncation.
 */

import { createHash } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z, toJSONSchema } from 'zod';
import { logger } from '../../system/logger.js';

/** Pins at or below this length are indexed verbatim — no model call. */
export const VERBATIM_MAX = 200;

const SummarySchema = z.object({
  summary: z.string(),
});
const rawSummarySchema = toJSONSchema(SummarySchema) as Record<string, unknown>;
// Strip JSON Schema dialect URL — some SDK validators reject it.
const { $schema: _drop, ...summaryJsonSchema } = rawSummarySchema;

const SYSTEM_PROMPT = `You write a one-line index entry for a message someone pinned in a Slack channel.

Rules:
- One sentence, at most 150 characters
- Say what the message is ABOUT so a reader can decide whether to open it
- Do not judge whether it matters
- No quotes, no trailing punctuation
- Match the message's language

Respond with JSON only.`;

/**
 * Flatten a pin's text to a single line fit for an index entry.
 *
 * Whitespace collapses to single spaces, and the invisible characters `\s` does not cover — zero-width space, soft hyphen, the bidi and isolate marks, word joiner, BOM, the C0 controls and the Unicode tag block — are deleted outright. None of them render, so none of them carry meaning in a one-line index; what they do carry is the ability to make text look one way in Slack and another way in a prompt.
 *
 * This is hygiene, NOT containment. An earlier version tried to make the block safe by stripping `</pin>` and `</channel_pinned_messages>` out of the text, and that approach cannot be made to work: it neutralises closing tags while OPENING tags pass through verbatim, so a pin body could still forge a `<pin by="…">` element with any attribution it liked, and no blocklist of invisible characters is ever complete — a sweep of the Unicode `Cf` category found 189 of 197 codepoints still got through. Containment lives at render time in `channel-pins.ts`, where every value is XML-escaped and therefore cannot produce a tag of any kind.
 */
export function normalisePinText(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufe00-\ufe0f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Short stable hash of the text a summary was derived from — drives re-summarise-on-edit. */
export function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Cut `text` to `max` characters, marking the cut with an ellipsis. */
export function truncateTo(text: string, max = VERBATIM_MAX): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Produce the one-line index entry for a pin's text, and say where it came from.
 * Never throws and never returns nothing for non-empty input.
 */
export async function summarisePinText(raw: string): Promise<{ summary: string; source: 'verbatim' | 'model' }> {
  const text = normalisePinText(raw);
  if (!text) return { summary: '', source: 'verbatim' };
  if (text.length <= VERBATIM_MAX) return { summary: text, source: 'verbatim' };

  try {
    let result: z.infer<typeof SummarySchema> | null = null;

    const prompt = `Write a one-line index entry for the following pinned Slack message.

${text}

Respond with JSON only.`;

    for await (const event of query({
      prompt,
      options: {
        model: 'haiku',
        systemPrompt: SYSTEM_PROMPT,
        executable: 'node',
        env: {
          NODE_ENV: process.env.NODE_ENV || 'development',
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          // Forward CA-trust to the spawned CLI (TLS-intercepting proxy); no-op when unset.
          ...(process.env.NODE_USE_SYSTEM_CA ? { NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA } : {}),
          ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
          PATH: process.env.PATH,
        },
        tools: [],
        maxTurns: 2,
        outputFormat: {
          type: 'json_schema',
          schema: summaryJsonSchema,
        },
      },
    })) {
      if (event.type !== 'result') continue;
      if (event.subtype === 'success') {
        const parsed = SummarySchema.safeParse(event.structured_output);
        if (parsed.success) {
          result = parsed.data;
        } else {
          logger.warn('pin-summary', `schema validation failed: ${parsed.error.message}`);
        }
      } else {
        logger.warn('pin-summary', `haiku call failed: ${event.subtype}`);
      }
    }

    // An empty summary passes the schema — `z.string()` accepts "" — so it has to be
    // caught here rather than by validation. A blank index line is worse than a blunt
    // truncation: it tells the agent a pin exists and nothing about what it is, which
    // is the one outcome this whole path is meant to avoid.
    const summary = result ? normalisePinText(truncateTo(result.summary)) : '';
    if (!summary) return { summary: truncateTo(text), source: 'verbatim' };
    return { summary, source: 'model' };
  } catch (err) {
    logger.warn('pin-summary', `unexpected failure: ${err}`);
    return { summary: truncateTo(text), source: 'verbatim' };
  }
}
