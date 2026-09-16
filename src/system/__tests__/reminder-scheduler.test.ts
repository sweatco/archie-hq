// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskMetadata } from '../../types/task.js';

const { getTask, loadMetadata, emitEvent } = vi.hoisted(() => ({
  getTask: vi.fn(),
  loadMetadata: vi.fn(),
  emitEvent: vi.fn(),
}));

vi.mock('../../tasks/task.js', () => ({ Task: { get: getTask } }));
vi.mock('../../tasks/persistence.js', () => ({ loadMetadata }));
vi.mock('../event-bus.js', () => ({ emitEvent }));
vi.mock('../logger.js', () => ({
  logger: { system: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { checkDueReminders, scheduleReminder } from '../reminder-scheduler.js';

describe('reminder scheduler', () => {
  beforeEach(() => {
    getTask.mockReset();
    loadMetadata.mockReset();
    emitEvent.mockReset();
  });

  it('persists cleared canonical metadata before reactivation so a restart cannot replay it', async () => {
    const taskId = 'task-20260916-1200-remind';
    const metadata = {
      task_id: taskId,
      channels: {},
      default_channel: null,
      agent_sessions: {},
      repositories: [],
      status: 'stopped',
      created_at: '',
      updated_at: '',
    } as TaskMetadata;
    const order: string[] = [];
    const task = {
      taskId,
      metadata,
      debouncedSave: vi.fn(),
      save: vi.fn(async (flush?: boolean) => {
        expect(flush).toBe(true);
        expect(metadata.reminder).toBeUndefined();
        order.push('save');
      }),
      sendMessage: vi.fn(async () => { order.push('send'); }),
    } as unknown as import('../../tasks/task.js').Task;
    getTask.mockResolvedValue(task);

    scheduleReminder(task, new Date(Date.now() - 1_000), 'Follow up');
    expect(metadata.reminder).toBeDefined();

    await checkDueReminders();

    expect(getTask).toHaveBeenCalledWith(taskId);
    expect(loadMetadata).not.toHaveBeenCalled();
    expect(metadata.reminder).toBeUndefined();
    expect(task.save).toHaveBeenCalledWith(true);
    expect(task.sendMessage).toHaveBeenCalledOnce();
    expect(order).toEqual(['save', 'send']);
    expect(emitEvent).toHaveBeenCalledWith('reminder:fired', taskId, { reason: 'Follow up' });
  });
});
