import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../system/logger.js', () => ({
  logger: { agentAction: vi.fn(), warn: vi.fn(), error: vi.fn(), system: vi.fn(), debug: vi.fn() },
}));

import { createRecallPmToolsServer, getRecallPmTools, type MeetingOps } from '../pm-tools.js';
import type { Agent } from '../../../agents/agent.js';
import type { Task } from '../../../tasks/task.js';

function makeAgent(): Agent {
  return {
    def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true },
    queue: {} as any,
    session: { active: false },
  } as unknown as Agent;
}

function makeTask(taskId: string): Task {
  return { taskId, touch: vi.fn() } as unknown as Task;
}

/** The connector's own start/stop stubbed out — what they really do is pinned in connector-mount.test.ts. */
function makeOps(over: Partial<MeetingOps> = {}): MeetingOps {
  return {
    start: vi.fn().mockResolvedValue({ ok: true, botId: 'bot-1' }),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
}

function getHandler(
  name: string,
  task: Task,
  ops: MeetingOps,
): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const server = createRecallPmToolsServer(makeAgent(), task, ops);
  const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
  const entry = raw[name];
  const fn = entry.callback ?? entry.handler ?? entry.cb;
  return (args) => fn(args, {});
}

async function textOf(result: { content: { text: string }[] }): Promise<string> {
  return result.content[0].text;
}

// Deliberately never mounts the connector — that is the whole assertion. The other half, "a mount sets it", is in connector-mount.test.ts.
describe('recallPmTools', () => {
  it('is null until the connector mounts, so an unconfigured deployment hands the PM nothing', () => {
    expect(getRecallPmTools()).toBeNull();
  });
});

describe('join_recall_meeting', () => {
  it('registers exactly these two tools', () => {
    const server = createRecallPmToolsServer(makeAgent(), makeTask('task-list'), makeOps());
    const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
    expect(Object.keys(raw)).toEqual(['join_recall_meeting', 'leave_recall_meeting']);
  });

  it('relays a start failure verbatim, rather than a silent no-op', async () => {
    const ops = makeOps({ start: vi.fn().mockResolvedValue({ ok: false, reason: 'failed to start meeting' }) });
    const task = makeTask('task-nojoin');
    const join = getHandler('join_recall_meeting', task, ops);

    const out = await textOf(await join({ meeting_url: 'https://zoom.us/j/123' }));

    expect(out).toMatch(/failed to start meeting/i);
    expect(out).not.toMatch(/^joining/i);
  });

  it('refuses a second meeting on a task that already has one live', async () => {
    const ops = makeOps({
      start: vi.fn().mockResolvedValue({ ok: false, reason: 'A meeting is already live on this task.' }),
    });
    const task = makeTask('task-joinlive');
    const join = getHandler('join_recall_meeting', task, ops);

    const out = await textOf(await join({ meeting_url: 'https://zoom.us/j/456' }));

    expect(out).toMatch(/already live/i);
  });

  it('reports success as "joining", never a silent no-op, and touches the task', async () => {
    const ops = makeOps();
    const task = makeTask('task-joinok');
    const join = getHandler('join_recall_meeting', task, ops);

    const out = await textOf(await join({ meeting_url: 'https://zoom.us/j/789' }));

    expect(out).toMatch(/^joining/i);
    expect(vi.mocked(task.touch)).toHaveBeenCalled();
    expect(ops.start).toHaveBeenCalledWith('task-joinok', 'https://zoom.us/j/789');
  });
});

describe('leave_recall_meeting', () => {
  it('reports plainly when there is no live meeting on this task, never a silent success', async () => {
    const ops = makeOps({
      stop: vi.fn().mockResolvedValue({ ok: false, reason: 'No meeting is live on this task.' }),
    });
    const task = makeTask('task-noleave');
    const leave = getHandler('leave_recall_meeting', task, ops);

    const out = await textOf(await leave({}));

    expect(out).toMatch(/no meeting is live/i);
    expect(out).not.toMatch(/^left/i);
  });

  it('relays any other stop failure verbatim, rather than rewriting it', async () => {
    const ops = makeOps({
      stop: vi.fn().mockResolvedValue({ ok: false, reason: 'Recall refused the leave call.' }),
    });
    const task = makeTask('task-otherleave');
    const leave = getHandler('leave_recall_meeting', task, ops);

    const out = await textOf(await leave({}));

    expect(out).toMatch(/Recall refused the leave call\./);
  });

  it('reports success as "left", and touches the task', async () => {
    const ops = makeOps();
    const task = makeTask('task-leaveok');
    const leave = getHandler('leave_recall_meeting', task, ops);

    const out = await textOf(await leave({}));

    expect(out).toMatch(/^left/i);
    expect(vi.mocked(task.touch)).toHaveBeenCalled();
    expect(ops.stop).toHaveBeenCalledWith('task-leaveok');
  });
});
