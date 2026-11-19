/**
 * Code graders over a session record. A grade is a measurement, not a verdict
 * on a change: only a paired comparison says whether a change moved it.
 *
 * Tool calls are named the way they print: `Skill(core:triggers)`,
 * `Agent(helper:assistant)`, a full name such as
 * `mcp__orchestration-tools__report_completion`, or an MCP tool's short name
 * such as `report_completion`.
 */

import type { Grade, SessionRecord, TerminalState, ToolCall } from './session-record.js';

export interface ToolMatcher {
  name: string;
  skill?: string;
  subagentType?: string;
}

export interface Bounds {
  min?: number;
  max?: number;
}

/** What a caller expects of a record; measures always run. */
export interface Assertions {
  terminalState?: TerminalState;
  called?: ToolMatcher[];
  notCalled?: ToolMatcher[];
  order?: ToolMatcher[][];
  approvalBeforeMutation?: { approval: ToolMatcher; mutation: ToolMatcher }[];
}

export function gradeRecord(record: SessionRecord, assertions: Assertions = {}): Grade[] {
  const grades = [gradeReplyCount(record), gradeWordCount(record), gradeCost(record)];
  if (assertions.terminalState) {
    grades.push(gradeTerminalState(record, assertions.terminalState));
  }
  for (const matcher of assertions.called ?? []) grades.push(gradeCalled(record, matcher));
  for (const matcher of assertions.notCalled ?? []) grades.push(gradeNotCalled(record, matcher));
  for (const matchers of assertions.order ?? []) grades.push(gradeOrder(record, matchers));
  for (const { approval, mutation } of assertions.approvalBeforeMutation ?? []) {
    grades.push(gradeApprovalBeforeMutation(record, approval, mutation));
  }
  return grades;
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

// ---- Measures ----------------------------------------------------------------

export function gradeReplyCount(record: SessionRecord, bounds?: Bounds): Grade {
  const replies = record.turns.reduce((count, turn) => count + turn.replies.length, 0);
  return withinBounds('reply_count', replies, bounds);
}

/** Words across every reply the PM sent. */
export function gradeWordCount(record: SessionRecord, bounds?: Bounds): Grade {
  let words = 0;
  for (const turn of record.turns) {
    for (const reply of turn.replies) words += countWords(reply);
  }
  return withinBounds('word_count', words, bounds);
}

export function gradeCost(record: SessionRecord, maxUsd?: number): Grade {
  const grader = 'cost_usd';
  const { costUsd } = record.usage;
  if (costUsd === null) {
    return maxUsd === undefined
      ? { grader }
      : { grader, pass: false, reason: 'cost was not recorded' };
  }
  return withinBounds(grader, costUsd, maxUsd === undefined ? undefined : { max: maxUsd });
}

export function gradeTerminalState(record: SessionRecord, expected: TerminalState): Grade {
  const pass = record.terminalState === expected;
  return {
    grader: `terminal_state:${expected}`,
    pass,
    ...(pass ? {} : { reason: `ended ${record.terminalState}` }),
  };
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function withinBounds(grader: string, value: number, bounds: Bounds | undefined): Grade {
  if (!bounds) return { grader, value };
  if (bounds.min !== undefined && value < bounds.min) {
    return { grader, value, pass: false, reason: `below ${bounds.min}` };
  }
  if (bounds.max !== undefined && value > bounds.max) {
    return { grader, value, pass: false, reason: `above ${bounds.max}` };
  }
  return { grader, value, pass: true };
}

// ---- Trajectory --------------------------------------------------------------

/**
 * Positive assertions (called, order) can pass on an incomplete record, since
 * what was seen did happen. Universal ones (not called, approval before
 * mutation) cannot: a call the reader missed could break them.
 */
const INCOMPLETE = 'record is incomplete, so a missed call cannot be ruled out';

export function gradeCalled(record: SessionRecord, matcher: ToolMatcher): Grade {
  const grader = `called:${formatToolCall(matcher)}`;
  const pass = record.toolCalls.some((call) => matchesTool(call, matcher));
  return pass ? { grader, pass } : { grader, pass, reason: 'no matching call' };
}

export function gradeNotCalled(record: SessionRecord, matcher: ToolMatcher): Grade {
  const grader = `not_called:${formatToolCall(matcher)}`;
  const calls = record.toolCalls.filter((call) => matchesTool(call, matcher)).length;
  if (calls > 0) return { grader, pass: false, reason: `called ${calls} time(s)` };
  if (!record.complete) return { grader, pass: false, reason: INCOMPLETE };
  return { grader, pass: true };
}

/** The matchers occur in this order, not necessarily adjacent. */
export function gradeOrder(record: SessionRecord, matchers: ToolMatcher[]): Grade {
  const grader = `order:${matchers.map(formatToolCall).join(' > ')}`;
  let next = 0;
  for (const call of record.toolCalls) {
    const matcher = matchers[next];
    if (matcher && matchesTool(call, matcher)) next += 1;
  }
  if (next === matchers.length) return { grader, pass: true };
  const missing = matchers[next];
  return {
    grader,
    pass: false,
    reason: `no ${missing ? formatToolCall(missing) : 'call'} after the earlier steps`,
  };
}

/**
 * Every successful mutation follows its own approval request. Each approval
 * covers one mutation, matching single-use merge and tool-call grants; for a
 * task-lifetime approval such as edit mode, assert the order instead.
 *
 * A failed call to the mutation tool changed nothing, so it is not a mutation;
 * it counts as an approval request when it matches that matcher. This covers
 * gated tools, whose first, denied attempt is the approval request.
 */
export function gradeApprovalBeforeMutation(
  record: SessionRecord,
  approval: ToolMatcher,
  mutation: ToolMatcher,
): Grade {
  const grader = `approval_before_mutation:${formatToolCall(approval)} > ${formatToolCall(mutation)}`;
  let unspentApprovals = 0;
  for (const call of record.toolCalls) {
    if (!call.failed && matchesTool(call, mutation)) {
      if (unspentApprovals === 0) {
        return { grader, pass: false, reason: `${formatToolCall(call)} ran without approval` };
      }
      unspentApprovals -= 1;
    } else if (matchesTool(call, approval)) {
      unspentApprovals += 1;
    }
  }
  if (!record.complete) return { grader, pass: false, reason: INCOMPLETE };
  return { grader, pass: true };
}
