import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitEvent } from '../../../system/event-bus.js';
import { Task } from '../../../tasks/task.js';
import { wakeDmTask } from '../routes.js';
import type { OAuthPendingRecord } from '../../../system/oauth/types.js';

const pending = {
  task_id: 'task-1',
  server_name: 'notion',
} as OAuthPendingRecord;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wakeDmTask', () => {
  it.each([
    { isActive: true, status: 'in_progress' },
    { isActive: false, status: 'in_progress' },
  ])('waits for task:stopped when teardown is pending: %o', async (state) => {
    const sendMessage = vi.fn(async () => {});
    vi.spyOn(Task, 'get')
      .mockResolvedValueOnce({ ...state, metadata: { status: state.status } } as unknown as Task)
      .mockResolvedValueOnce({ sendMessage } as unknown as Task);

    await expect(wakeDmTask(pending)).resolves.toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();

    emitEvent('task:stopped', pending.task_id!);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  });

  it('resumes immediately when teardown already completed', async () => {
    const sendMessage = vi.fn(async () => {});
    vi.spyOn(Task, 'get')
      .mockResolvedValueOnce({
        isActive: false,
        metadata: { status: 'stopped' },
      } as unknown as Task)
      .mockResolvedValueOnce({ sendMessage } as unknown as Task);

    await expect(wakeDmTask(pending)).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
