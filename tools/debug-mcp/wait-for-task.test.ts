import { describe, it, expect } from 'vitest';
import { waitForTask, type TaskClient } from './wait-for-task.js';

type Ev = { type: string; data?: Record<string, unknown> };

function makeClient(opts: {
  tasks?: Array<{ task_id: string; log: string }>;
  events?: Record<string, Ev[]>;
}): TaskClient {
  const tasks = opts.tasks ?? [];
  const events = opts.events ?? {};
  return {
    async listTasks() {
      return tasks.map((t) => ({ task_id: t.task_id }));
    },
    async getTaskDetail(id: string) {
      const t = tasks.find((x) => x.task_id === id);
      return { knowledgeLog: t?.log ?? '' };
    },
    async getEvents(id: string, after?: number) {
      const all = (events[id] ?? []).map((e) => ({ type: e.type, data: e.data ?? {} }));
      const start = after ?? 0;
      return { events: all.slice(start), total: all.length };
    },
  };
}

// Deterministic clock: sleep advances virtual time instead of waiting on a real timer.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}
const tunables = { capSeconds: 10, pollIntervalMs: 2000 };

describe('waitForTask — state detection', () => {
  it('returns completed and collects pm-agent replies', async () => {
    const c = makeClient({
      events: {
        t1: [
          { type: 'message', data: { from: 'pm-agent', message: 'noted' } },
          { type: 'task:completed' },
        ],
      },
    });
    const r = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), ...tunables });
    expect(r.state).toBe('completed');
    expect(r.pm_replies).toContain('noted');
  });

  it('returns stopped', async () => {
    const c = makeClient({ events: { t1: [{ type: 'task:stopped' }] } });
    const r = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), ...tunables });
    expect(r.state).toBe('stopped');
  });

  it('returns approval_requested with the approval type', async () => {
    const c = makeClient({ events: { t1: [{ type: 'approval:requested', data: { approvalType: 'edit_mode' } }] } });
    const r = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), ...tunables });
    expect(r.state).toBe('approval_requested');
    expect(r.approval_type).toBe('edit_mode');
  });

  it('surfaces a merge approval gate with its deferred stop (APPROVAL_TYPE=merge)', async () => {
    const c = makeClient({
      events: { t1: [{ type: 'approval:requested', data: { approvalType: 'merge' } }, { type: 'task:stopped' }] },
    });
    const r = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), ...tunables });
    expect(r.state).toBe('approval_requested');
    expect(r.approval_type).toBe('merge');
  });

  it('prefers a terminal state over a replayed approval (precedence)', async () => {
    const c = makeClient({
      events: {
        t1: [
          { type: 'approval:requested', data: { approvalType: 'edit_mode' } },
          { type: 'task:completed' },
        ],
      },
    });
    const r = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), ...tunables });
    expect(r.state).toBe('completed');
  });

  it('captures attribution from the first knowledge-log line', async () => {
    const c = makeClient({
      tasks: [{ task_id: 't1', log: '@<U123:Dana> in slack:#dm  hello (E2E-abcd)\nmore' }],
      events: { t1: [{ type: 'task:completed' }] },
    });
    const r = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), ...tunables });
    expect(r.attribution).toContain('@<U123:Dana>');
  });
});

describe('waitForTask — correlation', () => {
  it('finds the task by nonce', async () => {
    const c = makeClient({
      tasks: [
        { task_id: 't-new', log: 'hello (E2E-zzzz)' },
        { task_id: 't-old', log: 'something else' },
      ],
      events: { 't-new': [{ type: 'task:completed' }] },
    });
    const r = await waitForTask(c, { nonce: 'E2E-zzzz' }, { ...fakeClock(), ...tunables });
    expect(r.task_id).toBe('t-new');
    expect(r.state).toBe('completed');
  });

  it('returns not_found when the nonce never appears', async () => {
    const c = makeClient({ tasks: [{ task_id: 't1', log: 'nope' }] });
    const r = await waitForTask(c, { nonce: 'E2E-absent' }, { ...fakeClock(), ...tunables });
    expect(r.state).toBe('not_found');
    expect(r.task_id).toBeNull();
  });

  it('throws when neither task_id nor nonce is given', async () => {
    const c = makeClient({});
    await expect(waitForTask(c, {}, { ...fakeClock(), ...tunables })).rejects.toThrow(/nonce/i);
  });
});

describe('waitForTask — bounded & resumable', () => {
  it('returns pending with a cursor when the cap is reached', async () => {
    const c = makeClient({ events: { t1: [{ type: 'task:created' }] } });
    const r = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), capSeconds: 5, pollIntervalMs: 2000 });
    expect(r.state).toBe('pending');
    expect(r.cursor).toBe(1);
  });

  it('resumes from a cursor without reprocessing earlier events', async () => {
    const evs: Ev[] = [{ type: 'message', data: { from: 'pm-agent', message: 'early' } }];
    const c = makeClient({ events: { t1: evs } });

    const first = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), capSeconds: 5, pollIntervalMs: 2000 });
    expect(first.state).toBe('pending');
    expect(first.pm_replies).toContain('early');

    // task completes after the first call returned
    evs.push({ type: 'task:completed' });

    const second = await waitForTask(c, { taskId: 't1', cursor: first.cursor }, { ...fakeClock(), ...tunables });
    expect(second.state).toBe('completed');
    expect(second.pm_replies).not.toContain('early'); // events before the cursor are not reprocessed
  });
});

describe('waitForTask — approval-gate ordering', () => {
  it('reports approval_requested even when the gate stop lands in the same window', async () => {
    const c = makeClient({
      events: { t1: [{ type: 'approval:requested', data: { approvalType: 'edit_mode' } }, { type: 'task:stopped' }] },
    });
    const r = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), ...tunables });
    expect(r.state).toBe('approval_requested');
    expect(r.approval_type).toBe('edit_mode');
  });

  it('a task:resumed cancels an earlier task:stopped (no spurious stopped)', async () => {
    const c = makeClient({ events: { t1: [{ type: 'task:stopped' }, { type: 'task:resumed' }] } });
    const r = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), capSeconds: 5, pollIntervalMs: 2000 });
    expect(r.state).toBe('pending');
  });

  it('reaches completed across a resume that follows the gate stop', async () => {
    const c = makeClient({
      events: { t1: [{ type: 'task:stopped' }, { type: 'task:resumed' }, { type: 'task:completed' }] },
    });
    const r = await waitForTask(c, { taskId: 't1' }, { ...fakeClock(), ...tunables });
    expect(r.state).toBe('completed');
  });
});
