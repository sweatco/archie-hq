/**
 * Triage Agent
 *
 * Lightweight message classifier using Haiku model.
 * Determines if a message is a new task, existing task, status request, or cancellation.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { join } from 'path';
import pc from 'picocolors';
import type { TriageResult, SlackMessage } from '../types/index.js';
import { findTaskIdByThread } from '../system/task-runtime.js';
import { processAgentEventForLogging, logger } from '../system/logger.js';
import { loadPrompt } from '../utils/prompt-loader.js';

/**
 * Zod schema for triage result
 */
const TriageResultSchema = z.object({
  action: z.enum(['new_task', 'existing_task', 'status_request', 'cancel_task', 'noop']),
  task_id: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']),
  similar_tasks: z.array(z.string()).optional(),
  reasoning: z.string(),
});

/**
 * Load triage system prompt from template
 */
async function getTriageSystemPrompt(): Promise<string> {
  return loadPrompt('triage-agent', {});
}

/**
 * Build context about existing tasks for the triage agent
 */
function buildTriageContext(threadId: string): string {
  // Fast O(1) lookup in memory
  const existingTaskId = findTaskIdByThread(threadId);

  if (existingTaskId) {
    return `THREAD MATCH: This thread (${threadId}) belongs to task ${existingTaskId}`;
  }

  return 'No thread match found in active tasks. Use tools if needed to search historical tasks.';
}

/**
 * Run the triage agent to classify a Slack message
 */
export async function triageMessage(
  message: SlackMessage,
  threadHistory: SlackMessage[]
): Promise<TriageResult> {
  const threadId = message.thread_ts || message.ts;

  // Build context about existing tasks
  const context = buildTriageContext(threadId);

  // Build the message for triage
  const triageInput = `
Thread ID: ${threadId}
Channel: ${message.channel}
User: ${message.user}

Thread History:
${threadHistory.map((m) => `[${m.user}]: ${m.text}`).join('\n')}

Current Message:
${message.text}

${context}

Classify this message and respond with JSON only.`;

  let result: TriageResult = {
    action: 'new_task',
    confidence: 'low',
  };

  // Convert Zod schema to JSON Schema
  const jsonSchema = zodToJsonSchema(TriageResultSchema, { $refStrategy: 'none' });

  // Get absolute path to sessions directory for consistency with other agents
  const sessionsDir = join(process.cwd(), 'sessions');

  // Run the triage agent with tools and structured output
  // Set cwd to sessions directory for searching task metadata
  const systemPrompt = await getTriageSystemPrompt();

  logger.system('Running triage-agent...');

  for await (const event of query({
    prompt: triageInput,
    options: {
      model: (process.env.HAIKU_MODEL || 'claude-haiku-4-5-20251001') as any,
      systemPrompt,
      cwd: sessionsDir,
      executable: 'node',
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude',
      env: {
        NODE_ENV: process.env.NODE_ENV || 'development',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        PATH: process.env.PATH,
      },
      allowedTools: ['Glob', 'Grep', 'Read'],
      outputFormat: {
        type: 'json_schema',
        schema: jsonSchema,
      },
    },
  })) {
    // Log file operation tool calls
    processAgentEventForLogging(event, 'triage-agent', [sessionsDir]);

    if (event.type === 'result') {
      if (event.subtype === 'success' && event.structured_output) {
        // Validate with Zod and extract result
        const parsed = TriageResultSchema.safeParse(event.structured_output);
        if (parsed.success) {
          result = parsed.data;
          const decision = {
            action: result.action,
            taskId: result.task_id || '(none)',
            confidence: result.confidence,
            reasoning: parsed.data.reasoning,
          };
          const label = pc.yellow('[triage-agent]');
          console.log(`${label} ${pc.yellow('[decision]')}:`, decision);
        } else {
          logger.error('triage-agent', 'Validation failed', parsed.error);
        }
      } else if (event.subtype === 'error_max_structured_output_retries') {
        logger.error('triage-agent', 'Failed to produce valid structured output after retries');
      } else if (event.subtype === 'error_during_execution') {
        logger.error('triage-agent', 'Error during execution', event.errors);
      }
    }
  }

  return result;
}
