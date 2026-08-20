import { describe, it, expect } from 'vitest';
import {
  toolCallApprovalRequests,
  firstToolCallRef,
  nonceCount,
  decideGate,
  type GateEvent,
} from './tool-gate-check.js';

const approval = (ref: string): GateEvent => ({
  type: 'approval:requested',
  data: { approvalType: 'tool_call', ref },
});

describe('event scanning', () => {
  it('finds tool_call approvals and ignores every other approval type', () => {
    const events: GateEvent[] = [
      { type: 'task:created' },
      { type: 'approval:requested', data: { approvalType: 'edit_mode' } },
      approval('d1'),
      { type: 'approval:resolved', data: { type: 'tool_call', approve: true } },
    ];
    expect(toolCallApprovalRequests(events)).toHaveLength(1);
    expect(firstToolCallRef(events)).toBe('d1');
  });

});


describe('decideGate', () => {
  const good = { approvalRequests: 1, markerCountAtApprovalRequest: 0, markerCountAfterApproval: 1 };

  it('passes the intended run', () => {
    expect(decideGate(good)).toEqual({ pass: true, failures: [] });
  });

  it('fails when the gate never intercepted', () => {
    const verdict = decideGate({ ...good, approvalRequests: 0 });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join()).toContain('did not intercept');
  });

  // The regression this whole check exists for: deny not blocking execution.
  it('fails when the mutation ran before approval', () => {
    const verdict = decideGate({ ...good, markerCountAtApprovalRequest: 1, markerCountAfterApproval: 2 });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join()).toContain('deny did not block execution');
  });

  it('fails when the grant is never spent or spent twice', () => {
    expect(decideGate({ ...good, markerCountAfterApproval: 0 }).failures.join()).toContain('never spent');
    expect(decideGate({ ...good, markerCountAfterApproval: 2 }).failures.join()).toContain('more than once');
  });

  it('fails when extra approvals were requested', () => {
    const verdict = decideGate({ ...good, approvalRequests: 2 });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join()).toContain('expected 1');
  });
});
