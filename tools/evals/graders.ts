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

// ---- Replies -----------------------------------------------------------------

/** Texts the replies to one turn must hold and must not hold, compared ignoring case. */
export interface ReplyTexts {
  contains: string[];
  omits: string[];
}

/**
 * The PM replied to the turn, and its replies together hold every `contains`
 * text and none of the `omits`. Turns are numbered from 1, as a case lists them.
 */
export function checkTurnReply(
  record: SessionRecord,
  turnNumber: number,
  texts: ReplyTexts,
): Check {
  const turn = record.turns[turnNumber - 1];
  if (!turn) return turnNotPlayed(record, turnNumber);
  if (turn.replies.length === 0) return { pass: false, reason: `no reply to turn ${turnNumber}` };

  const reply = turn.replies.join('\n\n').toLowerCase();
  const holds = (text: string) => reply.includes(text.toLowerCase());
  const missing = texts.contains.filter((text) => !holds(text));
  const unwanted = texts.omits.filter(holds);
  if (missing.length === 0 && unwanted.length === 0) {
    return { pass: true, reason: `the reply to turn ${turnNumber} has the expected text` };
  }
  const problems = [
    ...(missing.length > 0 ? [`lacks ${quoteAll(missing)}`] : []),
    ...(unwanted.length > 0 ? [`has ${quoteAll(unwanted)}`] : []),
  ];
  return { pass: false, reason: `the reply to turn ${turnNumber} ${problems.join(' and ')}` };
}

/** The turn was played and the PM sent nothing in reply. */
export function checkNoReply(record: SessionRecord, turnNumber: number): Check {
  const turn = record.turns[turnNumber - 1];
  if (!turn) return turnNotPlayed(record, turnNumber);
  const replies = turn.replies.length;
  return { pass: replies === 0, reason: `${replies} reply(ies) to turn ${turnNumber}` };
}

/** A turn the trial never reached proves nothing about how the PM would have answered it. */
function turnNotPlayed(record: SessionRecord, turnNumber: number): Check {
  return {
    pass: false,
    reason: `turn ${turnNumber} was not played: the record has ${record.turns.length} turn(s)`,
  };
}

function quoteAll(texts: string[]): string {
  return texts.map((text) => `"${text}"`).join(', ');
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
