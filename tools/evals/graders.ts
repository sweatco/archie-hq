/**
 * Code graders: small pure checks over a session record. promptfoo runs them
 * through tools/evals/promptfoo/assertions.ts and owns trials, aggregation and
 * reports. A check is a measurement, not a verdict on a change: only a paired
 * comparison says whether a change moved it.
 *
 * Tool calls are named the way they print: `Skill(core:triggers)`,
 * `Agent(helper:assistant)`, a full name such as
 * `mcp__orchestration-tools__report_completion`, or an MCP tool's short name
 * such as `report_completion`.
 */

import type { SessionRecord, TerminalState, ToolCall } from './session-record.js';

export interface ToolMatcher {
  name: string;
  skill?: string;
  subagentType?: string;
}

export interface Check {
  pass: boolean;
  reason: string;
}

/** Counts that are compared against base rather than passed or failed. */
export interface Measures {
  replyCount: number;
  /** Words across every reply the PM sent. */
  wordCount: number;
}

const MCP_TOOL_NAME = /^mcp__.+?__(.+)$/;
const CALL_WITH_ARGUMENT = /^(Skill|Agent)\((.+)\)$/;

/** Parse the printed form of a tool call back into a matcher. */
export function parseToolMatcher(text: string): ToolMatcher {
  const trimmed = text.trim();
  const withArgument = CALL_WITH_ARGUMENT.exec(trimmed);
  if (withArgument?.[1] === 'Skill') return { name: 'Skill', skill: withArgument[2] };
  if (withArgument?.[1] === 'Agent') return { name: 'Agent', subagentType: withArgument[2] };
  return { name: trimmed };
}

export function formatToolCall(call: ToolCall | ToolMatcher): string {
  if (call.skill !== undefined) return `${call.name}(${call.skill})`;
  if (call.subagentType !== undefined) return `${call.name}(${call.subagentType})`;
  return call.name;
}

export function matchesTool(call: ToolCall, matcher: ToolMatcher): boolean {
  const shortName = MCP_TOOL_NAME.exec(call.name)?.[1];
  if (call.name !== matcher.name && shortName !== matcher.name) return false;
  if (matcher.skill !== undefined && call.skill !== matcher.skill) return false;
  if (matcher.subagentType !== undefined && call.subagentType !== matcher.subagentType) {
    return false;
  }
  return true;
}

export function measureRecord(record: SessionRecord): Measures {
  let replyCount = 0;
  let wordCount = 0;
  for (const turn of record.turns) {
    for (const reply of turn.replies) {
      replyCount += 1;
      wordCount += reply.split(/\s+/).filter(Boolean).length;
    }
  }
  return { replyCount, wordCount };
}

export function checkTerminalState(record: SessionRecord, expected: TerminalState): Check {
  return { pass: record.terminalState === expected, reason: `ended ${record.terminalState}` };
}

// ---- Trajectory --------------------------------------------------------------

/**
 * Positive checks (called, order) can pass on an incomplete record, since
 * what was seen did happen. Universal ones (not called, approval before
 * mutation) cannot: a call the reader missed could break them.
 */
const INCOMPLETE = 'record is incomplete, so a missed call cannot be ruled out';

export function checkCalled(record: SessionRecord, matcher: ToolMatcher): Check {
  const calls = countCalls(record, matcher);
  return { pass: calls > 0, reason: `${formatToolCall(matcher)} called ${calls} time(s)` };
}

export function checkNotCalled(record: SessionRecord, matcher: ToolMatcher): Check {
  const calls = countCalls(record, matcher);
  if (calls > 0)
    return { pass: false, reason: `${formatToolCall(matcher)} called ${calls} time(s)` };
  if (!record.complete) return { pass: false, reason: INCOMPLETE };
  return { pass: true, reason: `${formatToolCall(matcher)} not called` };
}

/** The matchers occur in this order, not necessarily adjacent. */
export function checkOrder(record: SessionRecord, matchers: ToolMatcher[]): Check {
  const expected = matchers.map(formatToolCall).join(' > ');
  let next = 0;
  for (const call of record.toolCalls) {
    const matcher = matchers[next];
    if (matcher && matchesTool(call, matcher)) next += 1;
  }
  const missing = matchers[next];
  if (!missing) return { pass: true, reason: `called in order: ${expected}` };
  return {
    pass: false,
    reason: `no ${formatToolCall(missing)} after the earlier steps of ${expected}`,
  };
}

/**
 * Every successful mutation follows its own approval request. Each approval
 * covers one mutation, matching single-use merge and tool-call grants; for a
 * task-lifetime approval such as edit mode, check the order instead.
 *
 * A failed call to the mutation tool changed nothing, so it is not a mutation;
 * it counts as an approval request when it matches that matcher. This covers
 * gated tools, whose first, denied attempt is the approval request.
 */
export function checkApprovalBeforeMutation(
  record: SessionRecord,
  approval: ToolMatcher,
  mutation: ToolMatcher,
): Check {
  let unspentApprovals = 0;
  let mutations = 0;
  for (const call of record.toolCalls) {
    if (!call.failed && matchesTool(call, mutation)) {
      if (unspentApprovals === 0) {
        return { pass: false, reason: `${formatToolCall(call)} ran without approval` };
      }
      unspentApprovals -= 1;
      mutations += 1;
    } else if (matchesTool(call, approval)) {
      unspentApprovals += 1;
    }
  }
  if (!record.complete) return { pass: false, reason: INCOMPLETE };
  return { pass: true, reason: `${mutations} mutation(s), each after an approval request` };
}

function countCalls(record: SessionRecord, matcher: ToolMatcher): number {
  return record.toolCalls.filter((call) => matchesTool(call, matcher)).length;
}
