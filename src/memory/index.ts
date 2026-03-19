/**
 * Memory Module — Public API
 *
 * Self-contained memory system for persistent cross-task knowledge.
 * No dependencies on ARCHIE internals (agents, tasks, Slack, event bus).
 */

import { mkdir } from 'fs/promises';
import { join } from 'path';
import type {
  MemoryConfig,
  MemoryManager,
  ExtractionInput,
  ExtractionResult,
  UpdateFactParams,
  ContextParams,
} from './types.js';
import { readMarkdownFile, appendToSection, replaceInSection, removeFromSection } from './file-ops.js';
import { extractFromTranscript, applyExtraction } from './extraction.js';
import { assembleContext } from './retrieval.js';

export type { MemoryConfig, MemoryManager, ExtractionInput, ExtractionResult, UpdateFactParams, ContextParams };

/**
 * Create a MemoryManager instance.
 *
 * The module is fully standalone — ARCHIE provides the LLM call and logger
 * via the config object.
 */
export function createMemoryManager(config: MemoryConfig): MemoryManager {
  const { memoryDir } = config;
  const log = config.logger ?? (() => {});

  return {
    async init(): Promise<void> {
      await mkdir(memoryDir, { recursive: true });
      await mkdir(join(memoryDir, 'users'), { recursive: true });
      await mkdir(join(memoryDir, 'tasks'), { recursive: true });
      log('info', `Memory directory initialized at ${memoryDir}`);
    },

    async getOrgKnowledge(): Promise<string> {
      return readMarkdownFile(join(memoryDir, 'org.md'));
    },

    async getUserPreferences(userId: string): Promise<string | null> {
      const { readdirSync } = await import('fs');
      const usersDir = join(memoryDir, 'users');
      try {
        const files = readdirSync(usersDir);
        const match = files.find((f) => f.startsWith(userId) && f.endsWith('.md'));
        if (match) {
          const content = await readMarkdownFile(join(usersDir, match));
          return content || null;
        }
      } catch {
        // users/ directory doesn't exist yet
      }
      return null;
    },

    async getActivityIndex(): Promise<string> {
      return readMarkdownFile(join(memoryDir, 'activity.md'));
    },

    async getTaskSummary(taskId: string): Promise<string | null> {
      // Task summaries are date-prefixed, so we need to scan
      const { readdirSync } = await import('fs');
      const tasksDir = join(memoryDir, 'tasks');
      try {
        const files = readdirSync(tasksDir);
        // Task summaries contain the task ID inside — search by reading files
        // For now, return null (Phase 2 search will make this efficient)
        for (const file of files) {
          const content = await readMarkdownFile(join(tasksDir, file));
          if (content.includes(taskId)) {
            return content;
          }
        }
      } catch {
        // tasks/ directory doesn't exist yet
      }
      return null;
    },

    async extractFromTranscript(input: ExtractionInput): Promise<ExtractionResult> {
      return extractFromTranscript(config, input);
    },

    async applyExtraction(result: ExtractionResult, taskId: string): Promise<void> {
      return applyExtraction(config, result, taskId);
    },

    async updateFact(params: UpdateFactParams): Promise<void> {
      let filePath: string;
      if (params.scope === 'org') {
        filePath = join(memoryDir, 'org.md');
      } else {
        const nameSlug = (params.userName || 'unknown')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        filePath = join(memoryDir, 'users', `${params.userId}-${nameSlug}.md`);
      }

      if (params.action === 'add') {
        await appendToSection(filePath, params.section, params.fact);
      } else if (params.action === 'update' && params.replaces) {
        await replaceInSection(filePath, params.section, params.replaces, params.fact);
      } else if (params.action === 'remove') {
        await removeFromSection(filePath, params.section, params.fact);
      }

      log('info', `Updated ${params.scope} memory: [${params.action}] ${params.section} — ${params.fact}`);
    },

    async assembleContext(params: ContextParams): Promise<string> {
      return assembleContext(memoryDir, params);
    },
  };
}
