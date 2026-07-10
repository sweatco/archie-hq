/**
 * memory:eval — shared types.
 *
 * Everything here is tooling-side: reports, goldens, and question sets are
 * NOT runtime memory (they live outside workdir/memory/ and outside the repo
 * when prod-derived — see the memory-layer spec).
 */

import type { EntityRecord } from '../../src/memory/types.js';

// ---- Telemetry (reader-side view of memory/tasks/*/telemetry.jsonl) ----

/** A parsed selection record (v1 lines without a `kind` field). */
export interface SelectionRecord {
  v: number;
  ts: string;
  taskId: string;
  agent: string | null;
  ctx: {
    repo: string | null;
    plugin: string | null;
    taskTitle: string | null;
    userIds: string[];
    users?: Array<{ id: string; name: string }>;
  };
  selected: Array<{ slug: string; score: number; scope: string }>;
  dropped: string[];
  zeroSignalExcluded: number;
  candidates: number;
  budgets: { org: number; nonOrg: number };
  renderedTokensEst: number;
}

/** A parsed pull record (`kind: "pull"`). */
export interface PullRecord {
  v: number;
  kind: 'pull';
  ts: string;
  taskId: string;
  agent: string | null;
  tool: string;
  args: Record<string, unknown>;
  returned: string[];
  resultCount: number;
  zeroResult: boolean;
}

export interface TelemetryReadResult {
  selection: SelectionRecord[];
  pull: PullRecord[];
  /** Lines that failed to parse or carried an unknown kind — counted, skipped. */
  skipped: number;
}

// ---- Goldens (selection regression) ----

export interface GoldenCase {
  v: 1;
  harvested_at: string;
  snapshot_date: string;
  ctx: {
    repo?: string;
    plugin?: string;
    taskTitle?: string;
    users?: Array<{ userId: string; displayName: string }>;
  };
  /** Budgets the recorded spawn ran with — replay MUST use these, not the eval env's. */
  budgets: { org: number; nonOrg: number };
  expected: { selected: string[]; dropped: string[] };
}

export interface GoldenDiff {
  index: number;
  missingFromSelected: string[];
  unexpectedlySelected: string[];
  droppedDelta: { missing: string[]; unexpected: string[] };
}

// ---- Questions (functional tier) ----

export interface QuestionRecord {
  v: 1;
  id: string;
  question: string;
  /** Gold answer the judge scores against. */
  gold: string;
  /** Entity slugs whose pages contain the evidence — the recall labels. */
  evidenceEntities: string[];
  /** Optional pointer back to the source transcript (task ID, benchmark question id). */
  sourceTranscriptRef?: string;
}

export interface QuestionSet {
  v: 1;
  name: string;
  created_at: string;
  snapshot_date?: string;
  questions: QuestionRecord[];
}

// ---- Functional results ----

export type ArmName = 'no-memory' | 'memory' | 'oracle';

export interface ArmAnswer {
  arm: ArmName;
  answer: string;
  correct?: boolean;
  judgeReason?: string;
}

export interface FunctionalCaseResult {
  id: string;
  question: string;
  surfaced: string[];
  contextRecall: number;
  contextPrecision: number;
  contextTokensEst: number;
  arms: ArmAnswer[];
}

export interface JudgeValidation {
  kappa: number;
  positionBias: number;
  at: string;
  sampleSize: number;
}

export interface JudgeStamp {
  readerModel: string;
  judgeModel: string;
  /** claude / gpt / gemini / … — derived from the model id prefix. */
  judgeFamily: string;
  extractorFamily: string;
  validation: JudgeValidation | null;
  /** True when the judge may gate changes: validated AND cross-family. */
  gating: boolean;
  nonGatingReasons: string[];
}

/** LLM caller — injected so tests never touch the network. */
export type LlmCall = (opts: { model: string; system?: string; prompt: string; maxTokens?: number }) => Promise<string>;

export type { EntityRecord };
