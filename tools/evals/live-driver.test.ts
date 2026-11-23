import { describe, expect, it } from 'vitest';
import { evalCaseSchema, playCase, type CaseTurn, type DriverClient } from './live-driver.js';

interface FakeEvent {
  type: string;
  data: Record<string, unknown>;
}

const event = (type: string, data: Record<string, unknown> = {}): FakeEvent => ({ type, data });
const turn = (message: string, approvals: CaseTurn['approvals'] = []): CaseTurn => ({
  message,
  approvals,
});

/**
 * An instance whose task log grows only when the driver acts: each create,
 * message and approval appends the events scripted for it.
 */
function fakeInstance(script: {
  onCreate: FakeEvent[];
  onMessage?: FakeEvent[][];
  onApprove?: FakeEvent[][];
  staleApprovals?: boolean;
}) {
  const events: FakeEvent[] = [];
  const calls: unknown[][] = [];
  const onMessage = [...(script.onMessage ?? [])];
  const onApprove = [...(script.onApprove ?? [])];

  const client: DriverClient = {
    listTasks: () => Promise.resolve([]),
    createTask: (message) => {
      calls.push(['createTask', message]);
      events.push(...script.onCreate);
      return Promise.resolve('task-1');
    },
    sendMessage: (taskId, message) => {
      calls.push(['sendMessage', taskId, message]);
      events.push(...(onMessage.shift() ?? []));
      return Promise.resolve();
    },
    approve: (taskId, type, approve, item) => {
      calls.push(['approve', taskId, type, approve, item]);
      events.push(...(onApprove.shift() ?? []));
      return Promise.resolve({ stale: script.staleApprovals === true });
    },
    getEvents: (taskId, after) => {
      calls.push(['getEvents', taskId, after]);
      return Promise.resolve({ events: events.slice(after ?? 0), total: events.length });
    },
  };
  /** Events the task emits on its own, between the driver's reads. */
  const emit = (...emitted: FakeEvent[]) => events.push(...emitted);
  return { client, calls, emit };
}

const options = {
  turnTimeoutSeconds: 60,
  timedOutHoldSeconds: 0,
  wait: { sleep: () => Promise.resolve(), pollIntervalMs: 0 },
};

describe('playCase', () => {
  it('creates a task from the first turn and reports when it settles', async () => {
    const { client, calls } = fakeInstance({
      onCreate: [event('task:created'), event('task:completed')],
    });

    const outcome = await playCase(client, [turn('Look up FH-1001')], options);

    expect(outcome).toEqual({
      taskId: 'task-1',
      end: 'settled',
      turnsPlayed: 1,
      approvalsAnswered: 0,
    });
    expect(calls[0]).toEqual(['createTask', 'Look up FH-1001']);
  });

  it('sends later turns as messages and waits on the events that follow each', async () => {
    const { client, calls } = fakeInstance({
      onCreate: [event('task:created'), event('task:completed')],
      onMessage: [[event('task:resumed'), event('task:stopped')]],
    });

    const outcome = await playCase(client, [turn('First'), turn('Second')], options);

    expect(outcome).toMatchObject({ end: 'settled', turnsPlayed: 2 });
    expect(calls).toContainEqual(['sendMessage', 'task-1', 'Second']);
    // The second turn reads from where the first stopped, so the earlier completion cannot settle it.
    expect(calls.at(-1)).toEqual(['getEvents', 'task-1', 2]);
  });

  it('answers an approval the turn specifies with the ref from the event', async () => {
    const { client, calls } = fakeInstance({
      onCreate: [
        event('task:created'),
        event('approval:requested', { approvalType: 'tool_call', ref: 'digest-1' }),
        event('task:stopped'),
      ],
      onApprove: [[event('task:resumed'), event('approval:resolved'), event('task:completed')]],
    });

    const outcome = await playCase(
      client,
      [turn('Refund FH-1004', [{ type: 'tool_call', approve: true }])],
      options,
    );

    expect(outcome).toMatchObject({ end: 'settled', approvalsAnswered: 1 });
    expect(calls).toContainEqual(['approve', 'task-1', 'tool_call', true, { ref: 'digest-1' }]);
  });

  it('stops at an approval the case does not answer, without sending later turns', async () => {
    const { client, calls } = fakeInstance({
      onCreate: [
        event('task:created'),
        event('approval:requested', { approvalType: 'tool_call', ref: 'digest-1' }),
      ],
    });

    const outcome = await playCase(
      client,
      [turn('Refund FH-1004', [{ type: 'edit_mode', approve: true }]), turn('Thanks')],
      options,
    );

    expect(outcome).toEqual({
      taskId: 'task-1',
      end: 'awaiting_approval',
      turnsPlayed: 1,
      approvalsAnswered: 0,
    });
    expect(calls.map(([name]) => name)).not.toContain('approve');
    expect(calls.map(([name]) => name)).not.toContain('sendMessage');
  });

  it('uses each answer once', async () => {
    const request = event('approval:requested', { approvalType: 'tool_call', ref: 'digest-1' });
    const { client } = fakeInstance({
      onCreate: [event('task:created'), request],
      onApprove: [[event('approval:resolved'), request]],
    });

    const outcome = await playCase(
      client,
      [turn('Refund twice', [{ type: 'tool_call', approve: false }])],
      options,
    );

    expect(outcome).toMatchObject({ end: 'awaiting_approval', approvalsAnswered: 1 });
  });

  it('fails when the instance says the approval was no longer pending', async () => {
    const { client } = fakeInstance({
      onCreate: [event('approval:requested', { approvalType: 'tool_call', ref: 'digest-1' })],
      staleApprovals: true,
    });

    await expect(
      playCase(client, [turn('Refund', [{ type: 'tool_call', approve: true }])], options),
    ).rejects.toThrow('the tool_call approval on task-1 was no longer pending');
  });

  it('reports a turn that does not settle in time, and that its task is still running', async () => {
    const { client, calls } = fakeInstance({ onCreate: [event('task:created')] });

    const outcome = await playCase(client, [turn('Never ends'), turn('Unsent')], {
      ...options,
      turnTimeoutSeconds: 0,
    });

    expect(outcome).toMatchObject({ end: 'timed_out', stillRunning: true, turnsPlayed: 1 });
    expect(calls.map(([name]) => name)).not.toContain('sendMessage');
  });

  it('follows a timed-out task until it stops running, without answering its approvals', async () => {
    const { client, calls, emit } = fakeInstance({ onCreate: [event('task:created')] });
    // The turn times out on its first read; the task parks on an approval while the driver holds.
    const sleep = () => {
      emit(event('approval:requested', { approvalType: 'tool_call', ref: 'digest-1' }));
      return Promise.resolve();
    };

    const outcome = await playCase(
      client,
      [turn('Slow refund', [{ type: 'tool_call', approve: true }])],
      { turnTimeoutSeconds: 0, timedOutHoldSeconds: 60, wait: { sleep, pollIntervalMs: 0 } },
    );

    expect(outcome).toMatchObject({ end: 'timed_out', stillRunning: false, approvalsAnswered: 0 });
    expect(calls.map(([name]) => name)).not.toContain('approve');
  });
});

describe('evalCaseSchema', () => {
  it('reads a case from test vars, ignoring the vars promptfoo adds', () => {
    const parsed = evalCaseSchema.parse({
      caseId: 'orders-lookup',
      turns: [{ message: 'Look up FH-1001' }],
      __repeatIndex: 1,
    });
    expect(parsed).toEqual({
      caseId: 'orders-lookup',
      turns: [{ message: 'Look up FH-1001', approvals: [] }],
    });
  });

  it('rejects a case without turns and an approval it cannot answer', () => {
    expect(evalCaseSchema.safeParse({ caseId: 'empty', turns: [] }).success).toBe(false);
    expect(
      evalCaseSchema.safeParse({
        caseId: 'merge',
        turns: [{ message: 'Merge it', approvals: [{ type: 'merge', approve: true }] }],
      }).success,
    ).toBe(false);
  });
});
