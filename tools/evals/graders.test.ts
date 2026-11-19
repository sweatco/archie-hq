import { describe, expect, it } from 'vitest';
import {
  checkApprovalBeforeMutation,
  checkCalled,
  checkNotCalled,
  checkOrder,
  checkTerminalState,
  formatToolCall,
  measureRecord,
  parseToolMatcher,
} from './graders.js';
import type { SessionRecord, ToolCall } from './session-record.js';

function call(name: string, extra: Partial<ToolCall> = {}): ToolCall {
  return { agent: 'pm', name, failed: false, ...extra };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    source: 'eval',
    taskId: 'task-20260101-0900-graders',
    turns: [
      { inbound: 'First question', replies: ['One two three.', 'Four five.'] },
      { inbound: 'Second question', replies: ['Six.'] },
    ],
    toolCalls: [
      call('Skill', { skill: 'core:triggers' }),
      call('ToolSearch'),
      call('mcp__orchestration-tools__propose_trigger'),
      call('Agent', { subagentType: 'helper:assistant' }),
      call('Bash', { agent: 'helper:assistant' }),
      call('mcp__orchestration-tools__report_completion'),
    ],
    complete: true,
    terminalState: 'completed',
    usage: { costUsd: 0.25, models: ['claude-opus-5-5'] },
    manifest: 'unknown',
    ...overrides,
  };
}

const m = parseToolMatcher;

describe('tool matchers', () => {
  it('parses the printed form of skills, workers and tool names', () => {
    expect(m('Skill(core:triggers)')).toEqual({ name: 'Skill', skill: 'core:triggers' });
    expect(m('Agent(helper:assistant)')).toEqual({
      name: 'Agent',
      subagentType: 'helper:assistant',
    });
    expect(m(' report_completion ')).toEqual({ name: 'report_completion' });
    expect(formatToolCall(call('Skill', { skill: 'core:triggers' }))).toBe('Skill(core:triggers)');
  });

  it('matches an MCP tool by its short name, and a skill only by its own name', () => {
    expect(checkCalled(record(), m('propose_trigger')).pass).toBe(true);
    expect(checkCalled(record(), m('mcp__orchestration-tools__propose_trigger')).pass).toBe(true);
    expect(checkCalled(record(), m('Skill')).pass).toBe(true);
    expect(checkCalled(record(), m('Skill(core:self-awareness)'))).toEqual({
      pass: false,
      reason: 'Skill(core:self-awareness) called 0 time(s)',
    });
  });
});

describe('measures and state', () => {
  it('counts replies and the words across them', () => {
    expect(measureRecord(record())).toEqual({ replyCount: 3, wordCount: 6 });
    expect(measureRecord(record({ turns: [] }))).toEqual({ replyCount: 0, wordCount: 0 });
  });

  it('compares the terminal state', () => {
    expect(checkTerminalState(record(), 'completed').pass).toBe(true);
    expect(checkTerminalState(record({ terminalState: 'stopped' }), 'completed')).toEqual({
      pass: false,
      reason: 'ended stopped',
    });
  });
});

describe('trajectory checks', () => {
  it('does not pass "not called" on an incomplete record', () => {
    expect(checkNotCalled(record(), m('merge_pull_request')).pass).toBe(true);
    expect(checkNotCalled(record({ complete: false }), m('merge_pull_request'))).toEqual({
      pass: false,
      reason: 'record is incomplete, so a missed call cannot be ruled out',
    });
    expect(checkNotCalled(record(), m('ToolSearch')).reason).toBe('ToolSearch called 1 time(s)');
    // What was seen did happen, so a positive check still holds.
    expect(checkCalled(record({ complete: false }), m('ToolSearch')).pass).toBe(true);
  });

  it('checks order as a subsequence', () => {
    const steps = [m('Skill(core:triggers)'), m('propose_trigger'), m('report_completion')];
    expect(checkOrder(record(), steps).pass).toBe(true);
    expect(checkOrder(record(), [m('report_completion'), m('propose_trigger')])).toEqual({
      pass: false,
      reason: 'no propose_trigger after the earlier steps of report_completion > propose_trigger',
    });
  });

  it('requires one approval request per successful mutation', () => {
    const approval = m('request_merge');
    const mutation = m('merge_pull_request');
    const check = (toolCalls: ToolCall[], complete = true) =>
      checkApprovalBeforeMutation(record({ toolCalls, complete }), approval, mutation);

    expect(check([call('request_merge'), call('merge_pull_request')]).pass).toBe(true);
    expect(check([call('merge_pull_request'), call('request_merge')])).toEqual({
      pass: false,
      reason: 'merge_pull_request ran without approval',
    });
    expect(
      check([call('request_merge'), call('merge_pull_request'), call('merge_pull_request')]).pass,
    ).toBe(false);
    // A failed mutation changed nothing, so it needs no approval.
    expect(check([call('merge_pull_request', { failed: true })]).pass).toBe(true);
    expect(check([call('request_merge'), call('merge_pull_request')], false).pass).toBe(false);
  });

  it('treats the denied first attempt of a gated tool as its approval request', () => {
    const gated = m('mcp__github__merge');
    const toolCalls = [
      call('mcp__github__merge', { failed: true }),
      call('mcp__github__merge'),
      call('mcp__github__merge'),
    ];
    const approvedOnce = record({ toolCalls: toolCalls.slice(0, 2) });
    expect(checkApprovalBeforeMutation(approvedOnce, gated, gated).pass).toBe(true);
    expect(checkApprovalBeforeMutation(record({ toolCalls }), gated, gated).pass).toBe(false);
  });
});
