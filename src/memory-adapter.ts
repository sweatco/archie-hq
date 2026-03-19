/**
 * Memory Adapter — Thin Glue Layer
 *
 * Bridges ARCHIE's event bus, agent spawner, and tool system
 * with the standalone memory module.
 *
 * - Subscribes to task:completed → triggers extraction
 * - Provides getMemoryContext() for spawn.ts prompt injection
 * - Exports update_memory tool creator for PM MCP server
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { createMemoryManager } from './memory/index.js';
import type { MemoryManager, ExtractionInput } from './memory/types.js';
import { MEMORY_DIR, SESSIONS_DIR } from './system/workdir.js';
import { onEvent } from './system/event-bus.js';
import type { SystemEvent } from './system/event-bus.js';
import { logger } from './system/logger.js';
import type { Agent } from './agents/agent.js';
import type { Task } from './tasks/task.js';

// ---- Singleton ----

let memoryManager: MemoryManager;

/**
 * LLM call wrapper using Haiku for extraction.
 * Uses the Claude Agent SDK query() in one-shot mode.
 */
async function haikuLlmCall(prompt: string, systemPrompt: string): Promise<string> {
  let result = '';
  for await (const event of query({
    prompt,
    options: {
      model: 'haiku',
      systemPrompt,
      cwd: SESSIONS_DIR,
      executable: 'node',
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude',
      env: {
        NODE_ENV: process.env.NODE_ENV || 'development',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        PATH: process.env.PATH,
      },
      allowedTools: [],
      maxTurns: 1,
      permissionMode: 'dontAsk' as const,
    },
  })) {
    if (event.type === 'result' && event.subtype === 'success') {
      result = event.result ?? '';
    }
  }
  return result;
}

/**
 * Initialize the memory adapter.
 * Creates the MemoryManager, ensures directory structure, subscribes to events.
 */
export async function initMemoryAdapter(): Promise<void> {
  memoryManager = createMemoryManager({
    memoryDir: MEMORY_DIR,
    llmCall: haikuLlmCall,
    logger: (level, msg) => {
      if (level === 'error') logger.error('memory', msg);
      else if (level === 'warn') logger.warn('memory', msg);
      else logger.debug('memory', msg);
    },
  });

  await memoryManager.init();

  // Seed org.md if it doesn't exist
  const orgPath = join(MEMORY_DIR, 'org.md');
  if (!existsSync(orgPath)) {
    const { writeFile } = await import('fs/promises');
    await writeFile(orgPath, `# Organization Knowledge

## Products

## Tech Stack

## Conventions

## Processes

## People & Roles
`);
    logger.system('Seeded empty org.md in memory directory');
  }

  // Subscribe to task completions for extraction
  onEvent((event: SystemEvent) => {
    if (event.type === 'task:completed') {
      void handleTaskCompleted(event).catch((err) => {
        logger.warn('memory', `Extraction failed for ${event.taskId}: ${err}`);
      });
    }
  });

  logger.system('Memory adapter initialized');
}

/**
 * Handle a completed task — extract knowledge from its transcript.
 * Fire-and-forget: failures are logged but never block.
 */
async function handleTaskCompleted(event: SystemEvent): Promise<void> {
  const taskId = event.taskId;

  // Read transcript (knowledge.log)
  const knowledgeLogPath = join(SESSIONS_DIR, taskId, 'shared', 'knowledge.log');
  if (!existsSync(knowledgeLogPath)) {
    logger.debug('memory', `No knowledge.log for ${taskId}, skipping extraction`);
    return;
  }

  const transcript = await readFile(knowledgeLogPath, 'utf-8');

  // Gate: skip trivial tasks
  if (transcript.length < 500) {
    logger.debug('memory', `Transcript too short for ${taskId} (${transcript.length} chars), skipping`);
    return;
  }

  // Read metadata for participants
  const metadataPath = join(SESSIONS_DIR, taskId, 'shared', 'metadata.json');
  let participants: string[] = [];
  try {
    const metaRaw = await readFile(metadataPath, 'utf-8');
    const meta = JSON.parse(metaRaw);
    participants = meta.participants || [];
  } catch {
    // Metadata read failed — continue with empty participants
  }

  // Gate: skip if no participants beyond PM
  if (participants.length < 1 && transcript.length < 1000) {
    logger.debug('memory', `Insufficient activity for ${taskId}, skipping extraction`);
    return;
  }

  const currentOrgKnowledge = await memoryManager.getOrgKnowledge();

  const input: ExtractionInput = {
    taskId,
    transcript,
    participants,
    currentOrgKnowledge,
  };

  logger.system(`Extracting memory from task ${taskId}...`);
  const result = await memoryManager.extractFromTranscript(input);

  // Skip if extraction produced nothing meaningful
  if (!result.task_summary.title && result.org_updates.length === 0 && result.user_updates.length === 0) {
    logger.debug('memory', `No meaningful extraction for ${taskId}`);
    return;
  }

  await memoryManager.applyExtraction(result, taskId);

  const updateCount = result.org_updates.length + result.user_updates.length;
  logger.system(
    `Memory extraction complete for ${taskId}: "${result.task_summary.title}" (${updateCount} updates)`,
  );
}

/**
 * Get memory context for injection into an agent's system prompt.
 * Called by spawn.ts when building agent prompts.
 */
export async function getMemoryContext(
  role: 'pm' | 'repo' | 'plugin',
  userId?: string,
): Promise<string> {
  if (!memoryManager) return '';
  try {
    return await memoryManager.assembleContext({ role, userId });
  } catch (err) {
    logger.warn('memory', `Failed to assemble memory context: ${err}`);
    return '';
  }
}

/**
 * Create the update_memory MCP tool for the PM agent.
 */
export function createUpdateMemoryTool(agent: Agent, task: Task) {
  return tool(
    'update_memory',
    'Update organizational or user memory. Use this when the user tells you something about their company, team, preferences, or processes that should be remembered for future tasks.',
    {
      scope: z.enum(['org', 'user']).describe('Whether to update organization or user memory'),
      section: z.string().describe('The section to update (e.g., "Tech Stack", "Conventions", "Work Preferences")'),
      action: z.enum(['add', 'update', 'remove']).describe('Whether to add, update, or remove a fact'),
      fact: z.string().describe('The fact to add/update/remove'),
      replaces: z.string().optional().describe('For updates: the old fact text being replaced'),
      user_id: z.string().optional().describe('For user scope: the Slack user ID'),
      user_name: z.string().optional().describe('For user scope: the user display name'),
    },
    async (args) => {
      if (!memoryManager) {
        return { content: [{ type: 'text' as const, text: 'Memory system not initialized.' }] };
      }

      try {
        await memoryManager.updateFact({
          scope: args.scope,
          section: args.section,
          action: args.action,
          fact: args.fact,
          replaces: args.replaces,
          userId: args.user_id,
          userName: args.user_name,
        });
        return { content: [{ type: 'text' as const, text: `Memory updated: [${args.action}] ${args.section} — ${args.fact}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Failed to update memory: ${msg}` }] };
      }
    },
  );
}

/**
 * Get the memory directory path (for adding to PM's additionalDirectories).
 */
export function getMemoryDir(): string {
  return MEMORY_DIR;
}
