/**
 * promptfoo `javascript` assertions over the session record that the replay
 * and live providers return:
 *
 *   - type: javascript
 *     value: file://assertions.ts:called
 *     config: { tool: 'Skill(core:triggers)' }
 *
 * Each export receives promptfoo's (output, context) and reads the record from
 * `context.providerResponse.metadata` and its arguments from `context.config`.
 * Tool names follow tools/evals/graders.ts.
 */

import {
  checkApprovalBeforeMutation,
  checkCalled,
  checkNoReply,
  checkNotCalled,
  checkOrder,
  checkTerminalState,
  checkTurnReply,
  parseToolMatcher,
  type Check,
  type ToolMatcher,
} from '../graders.js';
import type { SessionRecord, TerminalState } from '../session-record.js';
import type { RecordMetadata } from './record-response.js';

/** The fields of promptfoo's assertion context these assertions read. */
interface AssertionContext {
  config?: Record<string, unknown>;
  providerResponse?: { metadata?: Partial<RecordMetadata> };
}

interface GradingResult {
  pass: boolean;
  score: number;
  reason: string;
}

const TERMINAL_STATES: readonly TerminalState[] = [
  'preparing',
  'in_progress',
  'stopped',
  'completed',
  'approval_requested',
];

export function terminalState(_output: string, context: AssertionContext): GradingResult {
  const expected = stringOption(context, 'state');
  if (!(TERMINAL_STATES as readonly string[]).includes(expected)) {
    throw new Error(`config.state must be one of ${TERMINAL_STATES.join(', ')}`);
  }
  return toResult(checkTerminalState(recordOf(context), expected as TerminalState));
}

export function called(_output: string, context: AssertionContext): GradingResult {
  return toResult(checkCalled(recordOf(context), toolOption(context, 'tool')));
}

export function notCalled(_output: string, context: AssertionContext): GradingResult {
  return toResult(checkNotCalled(recordOf(context), toolOption(context, 'tool')));
}

export function order(_output: string, context: AssertionContext): GradingResult {
  const tools = context.config?.tools;
  if (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => typeof t === 'string')) {
    throw new Error('config.tools must be a non-empty list of tool names');
  }
  return toResult(checkOrder(recordOf(context), tools.map(parseToolMatcher)));
}

export function approvalBeforeMutation(_output: string, context: AssertionContext): GradingResult {
  const approval = toolOption(context, 'approval');
  const mutation = toolOption(context, 'mutation');
  return toResult(checkApprovalBeforeMutation(recordOf(context), approval, mutation));
}

export function turnReply(_output: string, context: AssertionContext): GradingResult {
  const contains = textsOption(context, 'contains');
  const omits = textsOption(context, 'omits');
  if (contains.length === 0 && omits.length === 0) {
    throw new Error('config needs a contains or an omits list');
  }
  return toResult(checkTurnReply(recordOf(context), turnOption(context), { contains, omits }));
}

export function noReply(_output: string, context: AssertionContext): GradingResult {
  return toResult(checkNoReply(recordOf(context), turnOption(context)));
}

/** Fails loudly when the assertion runs against another provider's response. */
function recordOf(context: AssertionContext): SessionRecord {
  const record = context.providerResponse?.metadata?.record;
  if (!record)
    throw new Error('no session record in the response; use the replay or live provider');
  return record;
}

function stringOption(context: AssertionContext, key: string): string {
  const value = context.config?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`config.${key} is required`);
  return value;
}

function toolOption(context: AssertionContext, key: string): ToolMatcher {
  return parseToolMatcher(stringOption(context, key));
}

/** A turn of the case, numbered from 1. */
function turnOption(context: AssertionContext): number {
  const turn = context.config?.turn;
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) {
    throw new Error('config.turn must be a turn number, counted from 1');
  }
  return turn;
}

/** An optional list of texts; absent means none. YAML reads a bare `36` as a number, so quote it. */
function textsOption(context: AssertionContext, key: string): string[] {
  const texts = context.config?.[key] ?? [];
  if (!isTextList(texts)) throw new Error(`config.${key} must be a list of quoted texts`);
  return texts;
}

function isTextList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((text) => typeof text === 'string' && text.trim() !== '')
  );
}

function toResult(check: Check): GradingResult {
  return { pass: check.pass, score: check.pass ? 1 : 0, reason: check.reason };
}
