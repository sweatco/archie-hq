import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import type { Trigger } from '../../../types/trigger.js';

const require = createRequire(import.meta.url);
const express = require('express');

const triggerStore = vi.hoisted(() => ({
  loadTrigger: vi.fn(),
  saveTrigger: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../system/trigger-store.js', () => ({
  listTriggers: vi.fn().mockResolvedValue([]),
  loadTrigger: triggerStore.loadTrigger,
  saveTrigger: triggerStore.saveTrigger,
  deleteTrigger: vi.fn(),
  countActiveTriggers: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../../system/trigger-scheduler.js', () => ({
  indexTrigger: vi.fn(),
  deindexTrigger: vi.fn(),
  announceTriggerChange: vi.fn().mockResolvedValue(undefined),
  describeTrigger: (trigger: Trigger) => trigger.summary ?? trigger.action.prompt,
  MAX_TRIGGERS_PER_USER: 10,
  MAX_TRIGGERS_PER_CHANNEL: 10,
}));

vi.mock('../../../tasks/task.js', () => ({
  Task: { create: vi.fn(), get: vi.fn() },
  activeTasks: new Map(),
}));

vi.mock('../../../tasks/persistence.js', () => ({
  readKnowledgeLog: vi.fn(),
  loadMetadata: vi.fn(),
  appendCliMessage: vi.fn(),
  readEvents: vi.fn(),
}));

vi.mock('../../../system/event-bus.js', () => ({
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  emitEvent: vi.fn(),
}));

vi.mock('../../../system/workdir.js', () => ({ SESSIONS_DIR: '/tmp/unused' }));
vi.mock('../../../system/logger.js', () => ({
  logger: { error: vi.fn(), plain: vi.fn() },
}));

import { mountApiRoutes } from '../routes.js';

let server: Server | undefined;

afterEach(async () => {
  vi.clearAllMocks();
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe('PATCH /api/triggers/:id', () => {
  it('stamps an operator-edited prompt public in the same persisted record', async () => {
    const trigger: Trigger = {
      id: 'trg-20260817-1200-test',
      status: 'enabled',
      created_by: 'U1',
      created_at: '2026-08-17T12:00:00.000Z',
      binding: { type: 'channel', channel_id: 'C1', channel_name: 'general' },
      conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2026-08-18T12:00:00.000Z' }],
      action: { prompt: 'old prompt' },
      prompt_origin_visibility: 'private',
    };
    triggerStore.loadTrigger.mockResolvedValue(trigger);
    const app = express();
    mountApiRoutes(app);
    const runningServer = app.listen(0);
    server = runningServer;
    await new Promise<void>((resolve) => runningServer.once('listening', resolve));
    const address = runningServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/triggers/${trigger.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action_prompt: 'operator replacement' }),
    });

    expect(response.status).toBe(200);
    expect(triggerStore.saveTrigger).toHaveBeenCalledOnce();
    expect(triggerStore.saveTrigger).toHaveBeenCalledWith(expect.objectContaining({
      action: { prompt: 'operator replacement' },
      prompt_origin_visibility: 'public',
    }));
  });
});
