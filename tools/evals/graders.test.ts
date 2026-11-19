import { describe, expect, it } from 'vitest';
import {
  formatToolCall,
  gradeApprovalBeforeMutation,
  gradeCalled,
  gradeCost,
  gradeNotCalled,
  gradeOrder,
  gradeRecord,
  gradeReplyCount,
  gradeTerminalState,
  gradeWordCount,
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
    grades: [],
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
    expect(gradeCalled(record(), m('propose_trigger')).pass).toBe(true);
    expect(gradeCalled(record(), m('mcp__orchestration-tools__propose_trigger')).pass).toBe(true);
    expect(gradeCalled(record(), m('Skill')).pass).toBe(true);
    expect(gradeCalled(record(), m('Skill(core:self-awareness)'))).toEqual({
      grader: 'called:Skill(core:self-awareness)',
      pass: false,
      reason: 'no matching call',
    });
  });
});

describe('measures', () => {
  it('counts replies and words, with a verdict only when bounds are given', () => {
    expect(gradeReplyCount(record())).toEqual({ grader: 'reply_count', value: 3 });
    expect(gradeWordCount(record())).toEqual({ grader: 'word_count', value: 6 });
    expect(gradeReplyCount(record(), { max: 2 })).toEqual({
      grader: 'reply_count',
      value: 3,
      pass: false,
      reason: 'above 2',
    });
    expect(gradeWordCount(record(), { min: 1, max: 6 }).pass).toBe(true);
  });

  it('never passes a cost cap when cost was not recorded', () => {
    const unmeasured = record({ usage: { costUsd: null, models: [] } });
    expect(gradeCost(unmeasured)).toEqual({ grader: 'cost_usd' });
    expect(gradeCost(unmeasured, 1)).toEqual({
      grader: 'cost_usd',
      pass: false,
      reason: 'cost was not recorded',
    });
    expect(gradeCost(record(), 0.5)).toEqual({ grader: 'cost_usd', value: 0.25, pass: true });
  });

  it('compares the terminal state', () => {
    expect(gradeTerminalState(record(), 'completed').pass).toBe(true);
    expect(gradeTerminalState(record({ terminalState: 'stopped' }), 'completed')).toEqual({
      grader: 'terminal_state:completed',
      pass: false,
      reason: 'ended stopped',
    });
  });
});

describe('trajectory assertions', () => {
  it('does not pass "not called" on an incomplete record', () => {
    expect(gradeNotCalled(record(), m('merge_pull_request')).pass).toBe(true);
    expect(gradeNotCalled(record({ complete: false }), m('merge_pull_request'))).toEqual({
      grader: 'not_called:merge_pull_request',
      pass: false,
      reason: 'record is incomplete, so a missed call cannot be ruled out',
    });
    expect(gradeNotCalled(record(), m('ToolSearch')).reason).toBe('called 1 time(s)');
    // What was seen did happen, so a positive assertion still holds.
    expect(gradeCalled(record({ complete: false }), m('ToolSearch')).pass).toBe(true);
  });

  it('checks order as a subsequence', () => {
    const steps = [m('Skill(core:triggers)'), m('propose_trigger'), m('report_completion')];
    expect(gradeOrder(record(), steps)).toEqual({
      grader: 'order:Skill(core:triggers) > propose_trigger > report_completion',
      pass: true,
    });
    expect(gradeOrder(record(), [m('report_completion'), m('propose_trigger')])).toMatchObject({
      pass: false,
      reason: 'no propose_trigger after the earlier steps',
    });
  });

  it('requires one approval request per successful mutation', () => {
    const approval = m('request_merge');
    const mutation = m('merge_pull_request');
    const grade = (toolCalls: ToolCall[], complete = true) =>
      gradeApprovalBeforeMutation(record({ toolCalls, complete }), approval, mutation);

    expect(grade([call('request_merge'), call('merge_pull_request')]).pass).toBe(true);
    expect(grade([call('merge_pull_request'), call('request_merge')])).toMatchObject({
      pass: false,
      reason: 'merge_pull_request ran without approval',
    });
    expect(
      grade([call('request_merge'), call('merge_pull_request'), call('merge_pull_request')]).pass,
    ).toBe(false);
    // A failed mutation changed nothing, so it needs no approval.
    expect(grade([call('merge_pull_request', { failed: true })]).pass).toBe(true);
    expect(grade([call('request_merge'), call('merge_pull_request')], false).pass).toBe(false);
  });

  it('treats the denied first attempt of a gated tool as its approval request', () => {
    const gated = m('mcp__github__merge');
    const toolCalls = [
      call('mcp__github__merge', { failed: true }),
      call('mcp__github__merge'),
      call('mcp__github__merge'),
    ];
    expect(
      gradeApprovalBeforeMutation(record({ toolCalls: toolCalls.slice(0, 2) }), gated, gated),
    ).toMatchObject({ pass: true });
    expect(gradeApprovalBeforeMutation(record({ toolCalls }), gated, gated).pass).toBe(false);
  });
});

describe('gradeRecord', () => {
  it('always measures, then applies the requested assertions in order', () => {
    const grades = gradeRecord(record(), {
      terminalState: 'completed',
      called: [m('Agent(helper:assistant)')],
      notCalled: [m('merge_pull_request')],
      order: [[m('propose_trigger'), m('report_completion')]],
    });
    expect(grades.map((g) => g.grader)).toEqual([
      'reply_count',
      'word_count',
      'cost_usd',
      'terminal_state:completed',
      'called:Agent(helper:assistant)',
      'not_called:merge_pull_request',
      'order:propose_trigger > report_completion',
    ]);
    expect(grades.every((g) => g.pass !== false)).toBe(true);
  });
});
