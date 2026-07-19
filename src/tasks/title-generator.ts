/**
 * Title Generator
 *
 * Generates a concise, AI-authored title for a task from its initial Slack
 * thread. Single Haiku call via the Claude Agent SDK with structured JSON
 * output. Returns null on any failure (logged, not thrown) — caller treats
 * absence of a title as a benign fallback to channel_name.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeCredentialEnv } from '../system/claude-credential.js';
import { z, toJSONSchema } from 'zod';
import type { SlackThread } from '../types/index.js';
import { renderMessageForContext } from './persistence.js';
import { isExternalUser } from '../connectors/slack/client.js';
import { logger } from '../system/logger.js';

const REDACTION_PLACEHOLDER = '[redacted: external participant in shared channel]';

const TitleSchema = z.object({
  title: z.string(),
});
const rawTitleSchema = toJSONSchema(TitleSchema) as Record<string, unknown>;
// Strip JSON Schema dialect URL — some SDK validators reject it.
const { $schema: _drop, ...titleJsonSchema } = rawTitleSchema;

const SYSTEM_PROMPT = `You generate a concise title for a task based on the initial conversation that started it.

Rules:
- Maximum 60 characters
- Free-form style (imperative, noun phrase, question — whatever fits)
- No quotes, no trailing punctuation
- Match the conversation's primary language
- Capture the actual subject, not generic phrases

Respond with JSON only.`;

/**
 * Render the thread as a transcript for the title generator. Per-message
 * redaction matches what the agent sees in knowledge.log (parity via the
 * shared renderMessageForContext helper).
 */
function buildTranscript(thread: SlackThread): { transcript: string; hasUsableContent: boolean } {
  const lines: string[] = [];
  let hasUsableContent = false;

  for (const msg of thread.messages) {
    const redacted = thread.shared && isExternalUser(msg.user);
    const body = renderMessageForContext(msg, { redacted });
    const author = redacted ? 'external' : msg.user.realName;
    lines.push(`[${author}]: ${body}`);
    if (!redacted && body.trim() !== '' && body !== REDACTION_PLACEHOLDER) {
      hasUsableContent = true;
    }
  }

  return { transcript: lines.join('\n'), hasUsableContent };
}

function cleanTitle(raw: string): string | null {
  let t = raw.trim();
  if (!t) return null;
  // Strip surrounding matching quotes (single, double, or smart)
  const quotePairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
  for (const [open, close] of quotePairs) {
    if (t.startsWith(open) && t.endsWith(close) && t.length >= 2) {
      t = t.slice(1, -1).trim();
      break;
    }
  }
  // Strip trailing punctuation
  t = t.replace(/[.!?…]+$/u, '').trim();
  if (!t) return null;
  if (t.length > 60) t = t.slice(0, 60).trim();
  return t || null;
}

/**
 * Generate a title for a task from its initial Slack thread.
 * Returns null on any failure (network error, malformed output, empty result,
 * fully-redacted input).
 */
export async function generateTaskTitle(thread: SlackThread): Promise<string | null> {
  try {
    const { transcript, hasUsableContent } = buildTranscript(thread);
    if (!hasUsableContent) {
      return null;
    }

    let result: z.infer<typeof TitleSchema> | null = null;

    const prompt = `Generate a concise title for the following conversation.

${transcript}

Respond with JSON only.`;

    for await (const event of query({
      prompt,
      options: {
        model: 'haiku',
        systemPrompt: SYSTEM_PROMPT,
        executable: 'node',
        env: {
          NODE_ENV: process.env.NODE_ENV || 'development',
          ...claudeCredentialEnv(),
          // Forward CA-trust to the spawned CLI (TLS-intercepting proxy); no-op when unset.
          ...(process.env.NODE_USE_SYSTEM_CA ? { NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA } : {}),
          ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
          PATH: process.env.PATH,
        },
        tools: [],
        maxTurns: 2,
        outputFormat: {
          type: 'json_schema',
          schema: titleJsonSchema,
        },
      },
    })) {
      if (event.type !== 'result') continue;
      if (event.subtype === 'success') {
        const parsed = TitleSchema.safeParse((event as any).structured_output);
        if (parsed.success) {
          result = parsed.data;
        } else {
          logger.warn('title-generator', `schema validation failed: ${parsed.error.message}`);
        }
      } else {
        logger.warn('title-generator', `haiku call failed: ${event.subtype}`);
      }
    }

    if (!result) return null;
    return cleanTitle(result.title);
  } catch (err) {
    logger.warn('title-generator', `unexpected failure: ${err}`);
    return null;
  }
}
