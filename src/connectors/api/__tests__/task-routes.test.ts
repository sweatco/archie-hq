/**
 * The task half of the operator API, over a real Express app: creating a task,
 * messaging it, and resolving approvals. The CLI and the E2E harness drive
 * Archie through exactly these routes, so each case pins the Task operation a
 * request reaches and the status a caller sees when it reaches none.
 */

import { createRequire } from 'module';
import type { Server } from 'http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const require = createRequire(import.meta.url);

vi.mock('../../../system/logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), plain: vi.fn() },
}));
vi.mock('../../../system/workdir.js', () => ({ SESSIONS_DIR: '/nonexistent-archie-sessions' }));
vi.mock('../../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));
vi.mock('../../../system/trigger-store.js', () => ({ loadTrigger: vi.fn() }));
vi.mock('../../../system/trigger-scheduler.js', () => ({}));
vi.mock('../../../system/reminder-scheduler.js', () => ({ cancelReminder: vi.fn() }));
vi.mock('../../../tasks/task.js', () => ({ Task: { get: vi.fn(), create: vi.fn() } }));
vi.mock('../../../tasks/persistence.js', () => ({
  loadMetadata: vi.fn(),
  appendCliMessage: vi.fn(),
  readEvents: vi.fn(),
  findTaskOnDisk: vi.fn(),
}));

import { mountApiRoutes } from '../routes.js';
import { Task } from '../../../tasks/task.js';
import {
  loadMetadata,
  appendCliMessage,
  readEvents,
  findTaskOnDisk,
} from '../../../tasks/persistence.js';
import { emitEvent, onEvent, offEvent, type SystemEvent } from '../../../system/event-bus.js';
import { cancelReminder } from '../../../system/reminder-scheduler.js';
import { expectDefined } from '../../../test-support/assertions.js';

const express = require('express') as typeof import('express');

const TASK_ID = 'task-20260101-1823-abc123';

function makeTask() {
  return {
    taskId: TASK_ID,
    metadata: { reminder: undefined as { fire_at: string } | undefined },
    linkCliChannel: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    handleEditModeApproval: vi.fn().mockResolvedValue(undefined),
    handleEditModeDenial: vi.fn().mockResolvedValue(undefined),
    handleResearchBudgetApproval: vi.fn().mockResolvedValue(undefined),
    handleResearchBudgetDenial: vi.fn().mockResolvedValue(undefined),
    handleMaxModeApproval: vi.fn().mockResolvedValue(undefined),
    handleMaxModeDenial: vi.fn().mockResolvedValue(undefined),
    handleToolCallApproval: vi.fn().mockResolvedValue('resolved'),
    handleToolCallDenial: vi.fn().mockResolvedValue('resolved'),
  };
}

let server: Server;
let baseUrl: string;
let task: ReturnType<typeof makeTask>;

async function request(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  vi.clearAllMocks();
  task = makeTask();
  vi.mocked(Task.get).mockResolvedValue(task as never);
  vi.mocked(Task.create).mockResolvedValue(task as never);
  vi.mocked(appendCliMessage).mockResolvedValue('recorded line');

  const app = express();
  mountApiRoutes(app);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('POST /api/tasks', () => {
  it('creates a CLI-linked task and wakes the PM with the recorded message', async () => {
    const res = await request('POST', '/tasks', { message: 'What agents are configured?' });

    expect(res).toEqual({ status: 201, body: { task_id: TASK_ID } });
    expect(task.linkCliChannel).toHaveBeenCalled();
    expect(appendCliMessage).toHaveBeenCalledWith(TASK_ID, 'What agents are configured?');
    expect(task.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('recorded line'),
    );
  });

  it.each([{}, { message: '' }, { message: 42 }])(
    'rejects %j without creating a task',
    async (body) => {
      const res = await request('POST', '/tasks', body);
      expect(res.status).toBe(400);
      expect(Task.create).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/tasks/:id/message', () => {
  it('records the message and delivers it to the existing task', async () => {
    const res = await request('POST', `/tasks/${TASK_ID}/message`, { message: 'Please merge it.' });

    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(Task.get).toHaveBeenCalledWith(TASK_ID);
    expect(appendCliMessage).toHaveBeenCalledWith(TASK_ID, 'Please merge it.');
    expect(task.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('recorded line'),
    );
  });

  it('reports a failure to reach the task instead of claiming delivery', async () => {
    vi.mocked(Task.get).mockRejectedValue(new Error('Task not found'));
    const res = await request('POST', `/tasks/${TASK_ID}/message`, { message: 'hello' });
    expect(res.status).toBe(500);
    expect(task.sendMessage).not.toHaveBeenCalled();
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns metadata for a known task and 404 for an unknown one', async () => {
    vi.mocked(loadMetadata).mockResolvedValueOnce({ task_id: TASK_ID } as never);
    expect(await request('GET', `/tasks/${TASK_ID}`)).toEqual({
      status: 200,
      body: { metadata: { task_id: TASK_ID } },
    });

    vi.mocked(loadMetadata).mockResolvedValueOnce(null);
    expect((await request('GET', '/tasks/task-missing')).status).toBe(404);
  });

  it('replays events after the cursor the caller passes', async () => {
    vi.mocked(readEvents).mockResolvedValue({ events: [], cursor: 7 } as never);
    const res = await request('GET', `/tasks/${TASK_ID}/events?after=5`);
    expect(readEvents).toHaveBeenCalledWith(TASK_ID, 5);
    expect(res.body).toEqual({ events: [], cursor: 7 });
  });
});

describe('POST /api/tasks/:id/approve', () => {
  const approve = (body: unknown) => request('POST', `/tasks/${TASK_ID}/approve`, body);

  it('approves edit mode on behalf of a named approver, trimming the identity', async () => {
    const res = await approve({
      type: 'edit_mode',
      approve: true,
      approver: { id: 'U1', name: '  Ada  ', email: ' ' },
    });

    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(task.handleEditModeApproval).toHaveBeenCalledWith({
      id: 'U1',
      name: 'Ada',
      email: undefined,
    });
    expect(emitEvent).toHaveBeenCalledWith('approval:resolved', TASK_ID, {
      type: 'edit_mode',
      approve: true,
    });
  });

  it('drops an approver with a blank name so commits stay bot-authored', async () => {
    await approve({ type: 'edit_mode', approve: true, approver: { id: 'U1', name: '  ' } });
    expect(task.handleEditModeApproval).toHaveBeenCalledWith(undefined);
  });

  it.each([
    ['edit_mode', 'handleEditModeDenial'],
    ['research_budget', 'handleResearchBudgetDenial'],
    ['max_mode', 'handleMaxModeDenial'],
  ] as const)('routes a %s denial to %s', async (type, handler) => {
    const res = await approve({ type, approve: false });
    expect(res.status).toBe(200);
    expect(task[handler]).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith('approval:resolved', TASK_ID, { type, approve: false });
  });

  it('resolves a tool call against the digest the caller echoes', async () => {
    const res = await approve({ type: 'tool_call', approve: true, ref: 'digest-1' });
    expect(res.status).toBe(200);
    expect(task.handleToolCallApproval).toHaveBeenCalledWith(undefined, 'digest-1');
  });

  it('answers 409 and emits nothing when the tool call is no longer pending', async () => {
    task.handleToolCallDenial.mockResolvedValue('stale');
    const res = await approve({ type: 'tool_call', approve: false, ref: 'digest-1' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, stale: true });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing approve flag', { type: 'edit_mode' }],
    ['a non-boolean approve flag', { type: 'edit_mode', approve: 'yes' }],
    ['a merge without PR identity', { type: 'merge', approve: true, github: 'org/backend' }],
    ['a tool call without its digest', { type: 'tool_call', approve: true }],
    ['an unknown approval type', { type: 'deploy', approve: true }],
  ])('rejects %s without resolving anything', async (_label, body) => {
    const res = await approve(body);
    expect(res.status).toBe(400);
    expect(emitEvent).not.toHaveBeenCalled();
    for (const handler of [task.handleEditModeApproval, task.handleToolCallApproval]) {
      expect(handler).not.toHaveBeenCalled();
    }
  });
});

describe('DELETE /api/tasks/:id/reminder', () => {
  it('cancels a scheduled reminder and persists the task', async () => {
    vi.mocked(findTaskOnDisk).mockReturnValue(TASK_ID);
    const reminder = { fire_at: '2026-12-01T09:00:00.000Z' };
    task.metadata.reminder = reminder;

    const res = await request('DELETE', `/tasks/${TASK_ID}/reminder`);

    expect(res).toEqual({ status: 200, body: { ok: true, cancelled: true, reminder } });
    expect(cancelReminder).toHaveBeenCalledWith(task);
    expect(task.save).toHaveBeenCalledWith(true);
  });

  it('reports nothing to cancel, and 404 for a task that is not on disk', async () => {
    vi.mocked(findTaskOnDisk).mockReturnValueOnce(TASK_ID);
    expect((await request('DELETE', `/tasks/${TASK_ID}/reminder`)).body).toEqual({
      ok: true,
      cancelled: false,
    });

    vi.mocked(findTaskOnDisk).mockReturnValueOnce(undefined);
    expect((await request('DELETE', '/tasks/task-missing/reminder')).status).toBe(404);
    expect(cancelReminder).not.toHaveBeenCalled();
  });
});

describe('GET /api/events/stream', () => {
  it('streams only the requested task and unsubscribes when the client disconnects', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events/stream?taskId=${TASK_ID}`, {
      signal: controller.signal,
    });
    const reader: ReadableStreamDefaultReader<Uint8Array> = expectDefined(res.body).getReader();
    const decoder = new TextDecoder();
    const read = async () => decoder.decode((await reader.read()).value);

    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await read()).toBe('data: {"type":"connected"}\n\n');

    const listener = expectDefined(vi.mocked(onEvent).mock.calls[0])[0];
    const event = (taskId: string): SystemEvent =>
      ({ type: 'task:completed', taskId, timestamp: 't', data: {} }) as SystemEvent;
    listener(event('task-other'));
    listener(event(TASK_ID));
    expect(await read()).toBe(`data: ${JSON.stringify(event(TASK_ID))}\n\n`);

    controller.abort();
    await vi.waitFor(() => expect(offEvent).toHaveBeenCalledWith(listener));
  });
});
