/**
 * Memory Extraction
 *
 * LLM-based fact extraction from task transcripts.
 * Parses structured JSON output and applies updates to memory files.
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import type {
  MemoryConfig,
  ExtractionInput,
  ExtractionResult,
} from './types.js';
import { ExtractionResultSchema } from './types.js';
import {
  readMarkdownFile,
  writeMarkdownFile,
  appendToSection,
  replaceInSection,
  prependTableRow,
} from './file-ops.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPT_PATH = join(__dirname, '..', '..', 'prompts', 'memory-extraction.md');

/**
 * Load the extraction prompt template.
 */
async function loadExtractionPrompt(): Promise<string> {
  return readFile(PROMPT_PATH, 'utf-8');
}

/**
 * Extract facts from a task transcript using an LLM.
 */
export async function extractFromTranscript(
  config: MemoryConfig,
  input: ExtractionInput,
): Promise<ExtractionResult> {
  const log = config.logger ?? (() => {});

  const systemPrompt = await loadExtractionPrompt();

  const userPrompt = `## Task ID
${input.taskId}

## Participants
${input.participants.join(', ')}

## Current Organization Knowledge
\`\`\`
${input.currentOrgKnowledge}
\`\`\`

${input.currentUserFile ? `## Current User File\n\`\`\`\n${input.currentUserFile}\n\`\`\`\n` : ''}

## Task Transcript
\`\`\`
${input.transcript}
\`\`\`

Respond with a JSON object. No markdown fences, no explanation — just the JSON.`;

  let rawOutput: string;
  try {
    rawOutput = await config.llmCall(userPrompt, systemPrompt);
  } catch (err) {
    log('error', `LLM call failed during extraction: ${err}`);
    return emptyResult();
  }

  // Parse JSON from LLM output (strip markdown fences if present)
  let parsed: unknown;
  try {
    const cleaned = rawOutput
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    log('warn', `Failed to parse extraction JSON: ${err}`);
    return emptyResult();
  }

  // Validate with Zod
  const result = ExtractionResultSchema.safeParse(parsed);
  if (!result.success) {
    log('warn', `Extraction output validation failed: ${result.error.message}`);
    return emptyResult();
  }

  return result.data;
}

/**
 * Apply an extraction result to the memory files on disk.
 */
export async function applyExtraction(
  config: MemoryConfig,
  result: ExtractionResult,
  taskId: string,
): Promise<void> {
  const log = config.logger ?? (() => {});
  const memoryDir = config.memoryDir;

  // 1. Write task summary
  const datePrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = result.task_summary.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  const summaryPath = join(memoryDir, 'tasks', `${datePrefix}-${slug}.md`);

  const summaryContent = `# ${result.task_summary.title}

**Task ID:** ${taskId}
**Date:** ${datePrefix}
**Tags:** ${result.task_summary.tags.join(', ')}

## Overview
${result.task_summary.overview}

## Outcome
${result.task_summary.outcome}

## Key Decisions
${result.task_summary.key_decisions.map((d) => `- ${d}`).join('\n')}
`;

  await writeMarkdownFile(summaryPath, summaryContent);
  log('info', `Wrote task summary: ${summaryPath}`);

  // 2. Update activity index
  const activityPath = join(memoryDir, 'activity.md');
  const tagsStr = result.task_summary.tags.join(', ');
  const summaryShort = result.task_summary.overview.slice(0, 80).replace(/\|/g, '/');
  const activityRow = `| ${datePrefix} | ${result.task_summary.title} | ${summaryShort} | ${tagsStr} |`;
  await prependTableRow(activityPath, activityRow, 100);

  // 3. Apply org updates
  const orgPath = join(memoryDir, 'org.md');
  for (const update of result.org_updates) {
    try {
      if (update.action === 'add') {
        await appendToSection(orgPath, update.section, update.fact);
      } else if (update.action === 'update' && update.replaces) {
        await replaceInSection(orgPath, update.section, update.replaces, update.fact);
      } else {
        await appendToSection(orgPath, update.section, update.fact);
      }
    } catch (err) {
      log('warn', `Failed to apply org update (${update.section}): ${err}`);
    }
  }

  // 4. Apply user updates
  for (const update of result.user_updates) {
    const nameSlug = update.user_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const userPath = join(memoryDir, 'users', `${update.user_id}-${nameSlug}.md`);

    try {
      // Ensure user file exists with a header
      const existing = await readMarkdownFile(userPath);
      if (!existing) {
        await writeMarkdownFile(
          userPath,
          `# ${update.user_name}\n\n**Slack ID:** ${update.user_id}\n`,
        );
      }

      if (update.action === 'add') {
        await appendToSection(userPath, update.section, update.fact);
      } else if (update.action === 'update' && update.replaces) {
        await replaceInSection(userPath, update.section, update.replaces, update.fact);
      } else {
        await appendToSection(userPath, update.section, update.fact);
      }
    } catch (err) {
      log('warn', `Failed to apply user update (${update.user_id}/${update.section}): ${err}`);
    }
  }
}

function emptyResult(): ExtractionResult {
  return {
    task_summary: {
      title: '',
      overview: '',
      outcome: '',
      key_decisions: [],
      tags: [],
    },
    org_updates: [],
    user_updates: [],
  };
}
