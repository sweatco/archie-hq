/**
 * Memory Extraction Side-Agent
 *
 * Calls a Sonnet side-agent to extract learnings from a completed task session.
 * Returns structured MemoryUpdate arrays and task/activity summaries.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadPrompt } from '../utils/prompt-loader.js';
import { logger } from '../system/logger.js';
import type { ExtractionResult, MemoryUpdate, EntityUpdate } from './types.js';

// ============================================================================
// Types
// ============================================================================

export interface ExtractionInput {
  collaborationProfiles: string;
  /** Current entity index (thin table) so the extractor resolves to existing entities. */
  entityIndex: string;
  taskId: string;
  participants: string;
  taskOwner: string;
  status: string;
  createdAt: string;
  transcript: string;
}

// ============================================================================
// Constants
// ============================================================================

const TRANSCRIPT_LIMIT = 100_000;

const FALLBACK_TEMPLATE = `You are reviewing a completed task session. Extract durable collaboration-profile and entity learnings.

COLLABORATION PROFILES: emit user_updates only for durable ways a user explicitly says, in their own first-person message, that others should collaborate with them. The only valid sections are Communication, Deliverables, Workflow, Decision Making, and Constraints. Reject general facts, skills, personality judgments, inferred behavior, and task-specific requests. Every update must cite one or more msg:<ts> evidence ids authored by that target user. Never emit user_updates for cli: or local: identities.

Current collaboration profiles:
<collaboration_profiles>
{{COLLABORATION_PROFILES}}
</collaboration_profiles>

Known entities (resolve against these — do not duplicate):
<entity_index>
{{ENTITY_INDEX}}
</entity_index>

Task metadata:
<task_metadata>
Task ID: {{TASK_ID}}
Participants: {{PARTICIPANTS}}
Task Owner: {{TASK_OWNER}}
Status: {{STATUS}}
Created: {{CREATED_AT}}
</task_metadata>

Task transcript:
<transcript>
{{TRANSCRIPT}}
</transcript>

Respond with ONLY a JSON object:
{
  "user_updates": {},
  "entity_updates": [],
  "task_summary": "Summary of what happened.",
  "activity_summary": "One-line activity description",
  "domain": "engineering|marketing|operations|product|other"
}`;

// ============================================================================
// buildExtractionPrompt
// ============================================================================

/**
 * Load the memory-extractor template and substitute all {{VAR}} placeholders.
 * Transcript is truncated at 100K chars if needed.
 * Falls back to an inline template if the prompt file does not exist.
 */
export async function buildExtractionPrompt(input: ExtractionInput): Promise<string> {
  let transcript = input.transcript;
  if (transcript.length > TRANSCRIPT_LIMIT) {
    transcript = transcript.slice(0, TRANSCRIPT_LIMIT) + '\n[truncated]';
  }

  const variables: Record<string, string> = {
    COLLABORATION_PROFILES: input.collaborationProfiles,
    ENTITY_INDEX: input.entityIndex,
    TASK_ID: input.taskId,
    PARTICIPANTS: input.participants,
    TASK_OWNER: input.taskOwner,
    STATUS: input.status,
    CREATED_AT: input.createdAt,
    TRANSCRIPT: transcript,
  };

  try {
    return await loadPrompt('memory-extractor', variables);
  } catch {
    logger.warn('memory', 'memory-extractor prompt template not found, using inline fallback');
    let template = FALLBACK_TEMPLATE;
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`{{${key}}}`, 'g');
      template = template.replace(pattern, value);
    }
    return template;
  }
}

// ============================================================================
// parseExtractionResponse
// ============================================================================

/**
 * Validate a single update has required fields. `evidence` is normalized to a
 * string array here; whether the citations actually resolve to lines authored
 * by the target user is enforced by the lifecycle (own-statements check).
 */
function isValidUpdate(u: unknown): u is MemoryUpdate {
  if (typeof u !== 'object' || u === null) return false;
  const obj = u as Record<string, unknown>;
  if (obj.action !== 'add' && obj.action !== 'update') return false;
  if (typeof obj.content !== 'string') return false;
  if (obj.evidence !== undefined) {
    if (!Array.isArray(obj.evidence)) return false;
    obj.evidence = obj.evidence.filter((e) => typeof e === 'string');
  }
  return true;
}

/**
 * Parse the `entity_updates` array leniently. Entity writes are additive and
 * fully sanitized downstream (applyEntityUpdate), so a malformed individual
 * item is dropped with a warning rather than failing the whole extraction.
 * A missing or non-array field yields [].
 */
function parseEntityUpdates(raw: unknown): EntityUpdate[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logger.warn('memory', 'parseExtractionResponse: entity_updates is not an array — ignored');
    return [];
  }
  const out: EntityUpdate[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.slug !== 'string' || !obj.slug.trim()) continue;
    out.push(obj as unknown as EntityUpdate);
  }
  return out;
}

/**
 * Parse and validate the Sonnet side-agent response.
 *
 * - Strips markdown code fences.
 * - Returns null on any structural failure.
 * - When `allowedUserIds` is provided, any `user_updates` keyed by a user
 *   outside the allowed set is dropped (with a warning) rather than failing
 *   the whole result. This constrains the extractor to only modify memory
 *   for users whose existing memory was loaded into the prompt.
 */
export function parseExtractionResponse(
  response: string,
  allowedUserIds?: Set<string>
): ExtractionResult | null {
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const stripped = response
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Validate required string fields
  if (typeof obj.task_summary !== 'string') return null;
  if (typeof obj.activity_summary !== 'string') return null;
  if (typeof obj.domain !== 'string') return null;

  // Validate user_updates is a plain object (not array, not null)
  if (typeof obj.user_updates !== 'object' || obj.user_updates === null || Array.isArray(obj.user_updates)) return null;
  const userUpdates = obj.user_updates as Record<string, unknown>;
  const filteredUserUpdates: Record<string, MemoryUpdate[]> = {};
  for (const username of Object.keys(userUpdates)) {
    const updates = userUpdates[username];
    if (!Array.isArray(updates)) return null;
    for (const u of updates) {
      if (!isValidUpdate(u)) return null;
    }
    if (allowedUserIds && !allowedUserIds.has(username)) {
      logger.warn('memory', `parseExtractionResponse: dropping ${updates.length} update(s) for unknown user "${username}"`);
      continue;
    }
    filteredUserUpdates[username] = updates as MemoryUpdate[];
  }

  return {
    user_updates: filteredUserUpdates,
    entity_updates: parseEntityUpdates(obj.entity_updates),
    task_summary: obj.task_summary,
    activity_summary: obj.activity_summary,
    domain: obj.domain,
  };
}

// ============================================================================
// runExtraction
// ============================================================================

/**
 * Run the memory extraction side-agent.
 * Builds prompt, calls Claude Agent SDK query() with sonnet + maxTurns 1,
 * collects text output, parses result.
 * Returns null on any error.
 *
 * @param input  - extraction context (memory + transcript + metadata)
 * @param allowedUserIds - if provided, user_updates keyed outside this set are dropped
 */
export async function runExtraction(
  input: ExtractionInput,
  allowedUserIds?: Set<string>
): Promise<ExtractionResult | null> {
  let prompt: string;
  try {
    prompt = await buildExtractionPrompt(input);
  } catch (err) {
    logger.warn('memory', 'Failed to build extraction prompt', err);
    return null;
  }

  try {
    const agentQuery = query({
      prompt,
      options: {
        model: 'sonnet' as any,
        maxTurns: 1,
        tools: [],
        executable: 'node',
        env: {
          NODE_ENV: process.env.NODE_ENV || 'development',
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          // Forward CA-trust to the spawned CLI (TLS-intercepting proxy); no-op when unset.
          // Adds TLS trust only — not tools/permissions — so the minimal-env invariant holds.
          ...(process.env.NODE_USE_SYSTEM_CA ? { NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA } : {}),
          ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
          PATH: process.env.PATH,
        },
        stderr: (data: string) => {
          logger.debug('memory', `extraction stderr: ${data.trim()}`);
        },
      },
    });

    let responseText = '';

    for await (const event of agentQuery) {
      if (event.type === 'assistant') {
        const content = (event as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              responseText += block.text;
            }
          }
        }
      }
      if (event.type === 'result') {
        if (event.subtype === 'success') {
          const resultText = (event as any).result;
          if (typeof resultText === 'string' && resultText.trim()) {
            responseText = resultText;
          }
        } else {
          const errs = ((event as any).errors as string[] | undefined)?.join('; ') ?? '';
          logger.warn('memory', `Extraction agent for task ${input.taskId} ended with subtype=${event.subtype}${errs ? `: ${errs}` : ''}`);
        }
      }
    }

    if (!responseText.trim()) {
      logger.warn('memory', `Extraction agent for task ${input.taskId} returned no text`);
      return null;
    }

    const result = parseExtractionResponse(responseText, allowedUserIds);
    if (!result) {
      logger.warn('memory', `Extraction agent for task ${input.taskId} returned unparseable response`);
    }
    return result;
  } catch (err) {
    logger.warn('memory', `Extraction agent failed for task ${input.taskId}`, err);
    return null;
  }
}
