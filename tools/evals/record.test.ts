import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parseInvocation } from './record.js';

describe('parseInvocation', () => {
  it('turns options into assertions', () => {
    const invocation = parseInvocation([
      'sessions/task-20260101-0900-evalfx',
      '--source',
      'eval',
      '--expect-state',
      'approval_requested',
      '--called',
      'Skill(core:triggers)',
      '--not-called',
      'merge_pull_request',
      '--order',
      'Skill(core:triggers),propose_trigger',
      '--approval-before',
      'request_merge,merge_pull_request',
    ]);

    expect(invocation).toEqual({
      taskDir: resolve('sessions/task-20260101-0900-evalfx'),
      source: 'eval',
      assertions: {
        terminalState: 'approval_requested',
        called: [{ name: 'Skill', skill: 'core:triggers' }],
        notCalled: [{ name: 'merge_pull_request' }],
        order: [[{ name: 'Skill', skill: 'core:triggers' }, { name: 'propose_trigger' }]],
        approvalBeforeMutation: [
          { approval: { name: 'request_merge' }, mutation: { name: 'merge_pull_request' } },
        ],
      },
    });
  });

  it('rejects malformed input', () => {
    expect(() => parseInvocation([])).toThrow('expected exactly one task folder');
    expect(() => parseInvocation(['a', '--approval-before', 'only_one'])).toThrow(
      '--approval-before needs APPROVAL,MUTATION',
    );
    expect(() => parseInvocation(['a', '--source', 'staging'])).toThrow();
    expect(() => parseInvocation(['a', '--expect-state', 'done'])).toThrow();
  });
});
