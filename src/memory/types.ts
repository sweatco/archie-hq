/**
 * Memory Module Types
 *
 * All memory interfaces. No ARCHIE-specific dependencies.
 */

import { z } from 'zod';

// ---- Configuration ----

export interface MemoryConfig {
  memoryDir: string;
  llmCall: (prompt: string, systemPrompt: string) => Promise<string>;
  logger?: (level: string, message: string) => void;
}

// ---- Extraction I/O ----

export interface ExtractionInput {
  taskId: string;
  transcript: string;
  participants: string[];
  currentOrgKnowledge: string;
  currentUserFile?: string;
  metadata?: Record<string, unknown>;
}

export interface ExtractionResult {
  task_summary: {
    title: string;
    overview: string;
    outcome: string;
    key_decisions: string[];
    tags: string[];
  };
  org_updates: OrgUpdate[];
  user_updates: UserUpdate[];
}

export interface OrgUpdate {
  action: 'add' | 'update';
  section: string;
  fact: string;
  replaces: string | null;
}

export interface UserUpdate {
  user_id: string;
  user_name: string;
  action: 'add' | 'update';
  section: string;
  fact: string;
  replaces: string | null;
}

// ---- Zod schemas for LLM output validation ----

export const OrgUpdateSchema = z.object({
  action: z.enum(['add', 'update']),
  section: z.string(),
  fact: z.string(),
  replaces: z.string().nullable(),
});

export const UserUpdateSchema = z.object({
  user_id: z.string(),
  user_name: z.string(),
  action: z.enum(['add', 'update']),
  section: z.string(),
  fact: z.string(),
  replaces: z.string().nullable(),
});

export const ExtractionResultSchema = z.object({
  task_summary: z.object({
    title: z.string(),
    overview: z.string(),
    outcome: z.string(),
    key_decisions: z.array(z.string()),
    tags: z.array(z.string()),
  }),
  org_updates: z.array(OrgUpdateSchema),
  user_updates: z.array(UserUpdateSchema),
});

// ---- Update operations ----

export interface UpdateFactParams {
  scope: 'org' | 'user';
  userId?: string;
  userName?: string;
  section: string;
  action: 'add' | 'update' | 'remove';
  fact: string;
  replaces?: string;
}

// ---- Context assembly ----

export interface ContextParams {
  role: 'pm' | 'repo' | 'plugin';
  userId?: string;
  repoKey?: string;
  taskDescription?: string;
}

// ---- Memory Manager interface ----

export interface MemoryManager {
  // Lifecycle
  init(): Promise<void>;

  // Read
  getOrgKnowledge(): Promise<string>;
  getUserPreferences(userId: string): Promise<string | null>;
  getActivityIndex(): Promise<string>;
  getTaskSummary(taskId: string): Promise<string | null>;

  // Write
  extractFromTranscript(input: ExtractionInput): Promise<ExtractionResult>;
  applyExtraction(result: ExtractionResult, taskId: string): Promise<void>;
  updateFact(params: UpdateFactParams): Promise<void>;

  // Context assembly
  assembleContext(params: ContextParams): Promise<string>;
}
