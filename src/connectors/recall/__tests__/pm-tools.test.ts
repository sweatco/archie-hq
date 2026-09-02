import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../voice/task-binding.js', () => ({
  startMeetingForTask: vi.fn(),
  stopMeetingForTask: vi.fn(),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { agentAction: vi.fn(), warn: vi.fn(), error: vi.fn(), system: vi.fn(), debug: vi.fn() },
}));

import { startMeetingForTask, stopMeetingForTask } from '../../../voice/task-binding.js';
import { createRecallPmToolsServer } from '../pm-tools.js';
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

function getHandler(name: string, task: Task): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const server = createRecallPmToolsServer(makeAgent(), task);
  const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
  const entry = raw[name];
  const fn = entry.callback ?? entry.handler ?? entry.cb;
  return (args) => fn(args, {});
}

async function textOf(result: { content: { text: string }[] }): Promise<string> {
  return result.content[0].text;
}

describe('join_recall_meeting', () => {
  it('registers exactly these two tools', () => {
    const server = createRecallPmToolsServer(makeAgent(), makeTask('task-list'));
    const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
    expect(Object.keys(raw)).toEqual(['join_recall_meeting', 'leave_recall_meeting']);
  });

  it('returns a usable reason when no connector is mounted, rather than a silent no-op', async () => {
    vi.mocked(startMeetingForTask).mockResolvedValue({ ok: false, reason: 'The voice connector is not mounted in this deployment.' });
    const task = makeTask('task-nojoin');
    const join = getHandler('join_recall_meeting', task);

    const out = await textOf(await join({ meeting_url: 'https://zoom.us/j/123' }));

    expect(out).toMatch(/connector/i);
    expect(out).not.toMatch(/^joining/i);
  });

  it('refuses a second meeting on a task that already has one live', async () => {
    vi.mocked(startMeetingForTask).mockResolvedValue({ ok: false, reason: 'A meeting is already live on this task.' });
    const task = makeTask('task-joinlive');
    const join = getHandler('join_recall_meeting', task);

    const out = await textOf(await join({ meeting_url: 'https://zoom.us/j/456' }));

    expect(out).toMatch(/already live/i);
  });

  it('reports success as "joining", never a silent no-op, and touches the task', async () => {
    vi.mocked(startMeetingForTask).mockResolvedValue({ ok: true, botId: 'bot-1' });
    const task = makeTask('task-joinok');
    const join = getHandler('join_recall_meeting', task);

    const out = await textOf(await join({ meeting_url: 'https://zoom.us/j/789' }));

    expect(out).toMatch(/^joining/i);
    expect(vi.mocked(task.touch)).toHaveBeenCalled();
    expect(startMeetingForTask).toHaveBeenCalledWith('task-joinok', 'https://zoom.us/j/789');
  });
});

describe('leave_recall_meeting', () => {
  it('reports plainly when there is no live meeting on this task, never a silent success', async () => {
    vi.mocked(stopMeetingForTask).mockResolvedValue({ ok: false, reason: 'No meeting is live on this task.' });
    const task = makeTask('task-noleave');
    const leave = getHandler('leave_recall_meeting', task);

    const out = await textOf(await leave({}));

    expect(out).toMatch(/no meeting is live/i);
    expect(out).not.toMatch(/^left/i);
  });

  it('returns a usable reason when no connector is mounted, rather than a silent no-op', async () => {
    vi.mocked(stopMeetingForTask).mockResolvedValue({ ok: false, reason: 'The voice connector is not mounted in this deployment.' });
    const task = makeTask('task-noconnector-leave');
    const leave = getHandler('leave_recall_meeting', task);

    const out = await textOf(await leave({}));

    expect(out).toMatch(/connector/i);
  });

  it('reports success as "left", and touches the task', async () => {
    vi.mocked(stopMeetingForTask).mockResolvedValue({ ok: true });
    const task = makeTask('task-leaveok');
    const leave = getHandler('leave_recall_meeting', task);

    const out = await textOf(await leave({}));

    expect(out).toMatch(/^left/i);
    expect(vi.mocked(task.touch)).toHaveBeenCalled();
    expect(stopMeetingForTask).toHaveBeenCalledWith('task-leaveok');
  });
});
