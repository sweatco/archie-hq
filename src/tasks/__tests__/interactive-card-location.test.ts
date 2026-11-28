// SPDX-License-Identifier: AGPL-3.0-or-later
/** Where an approval card lands in Slack, as the task reports it to a caller that will edit the card later. */
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../system/event-bus.js', () => ({ emitEvent: vi.fn() }));
vi.mock('../../system/logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), slack: vi.fn() },
}));

const { postInteractiveToThread } = vi.hoisted(() => ({ postInteractiveToThread: vi.fn() }));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, postInteractiveToThread };
});

import { emitEvent } from '../../system/event-bus.js';
import { Task } from '../task.js';

const THREAD = { type: 'slack', channel_id: 'C0NOTES', thread_id: '1795530309.733459' };

function post(task: object, onPosted: (card: { channel_id: string; ts: string }) => void) {
  return Task.prototype.postInteractiveToUser.call(
    task as unknown as Task,
    'Set up this automation?',
    [],
    'trigger',
    undefined,
    undefined,
    'trg-20261124-0900-notes1',
    onPosted,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

it('reports the conversation and the timestamp of the card it posted', async () => {
  postInteractiveToThread.mockResolvedValue('1795530311.467989');
  const task = {
    taskId: 'task-1',
    resolveSlackChannel: () => THREAD,
    prepareMemoryDelivery: vi.fn().mockResolvedValue(undefined),
  };
  const landed = vi.fn();

  await expect(post(task, landed)).resolves.toBe(true);

  expect(postInteractiveToThread).toHaveBeenCalledWith(
    'C0NOTES',
    '1795530309.733459',
    'Set up this automation?',
    [],
  );
  expect(landed).toHaveBeenCalledWith({ channel_id: 'C0NOTES', ts: '1795530311.467989' });
});

it('reports nothing when the task has no Slack thread', async () => {
  const task = { taskId: 'task-1', resolveSlackChannel: () => null };
  const landed = vi.fn();

  await expect(post(task, landed)).resolves.toBe(false);

  expect(landed).not.toHaveBeenCalled();
});

it('posts a panel in its thread without asking for an approval', async () => {
  postInteractiveToThread.mockResolvedValue('1795530311.467989');
  const task = {
    taskId: 'task-1',
    resolveSlackChannel: () => THREAD,
    prepareMemoryDelivery: vi.fn().mockResolvedValue(undefined),
  };
  const blocks = [{ type: 'divider' }];

  await expect(
    Task.prototype.postPanelToUser.call(task as unknown as Task, 'Inputs visible here (1)', blocks),
  ).resolves.toBe(true);

  expect(task.prepareMemoryDelivery).toHaveBeenCalledWith('C0NOTES');
  expect(postInteractiveToThread).toHaveBeenCalledWith(
    'C0NOTES',
    '1795530309.733459',
    'Inputs visible here (1)',
    blocks,
  );
  expect(emitEvent).not.toHaveBeenCalled();
});

it('posts no panel when the task has no Slack thread', async () => {
  const task = { taskId: 'task-1', resolveSlackChannel: () => null };

  await expect(
    Task.prototype.postPanelToUser.call(task as unknown as Task, 'Inputs visible here (1)', []),
  ).resolves.toBe(false);

  expect(postInteractiveToThread).not.toHaveBeenCalled();
});
