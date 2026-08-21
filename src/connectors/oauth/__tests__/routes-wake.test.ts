import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import type { OAuthPendingMeta, OAuthPendingRecord } from '../../../system/oauth/types.js';
import type { Task as TaskType } from '../../../tasks/task.js';

process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');

describe('durable DM OAuth wakes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archie-oauth-wake-'));
    process.env.ARCHIE_SECRETS_DIR = dir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { activeTasks } = await import('../../../tasks/task.js');
    activeTasks.clear();
    await rm(dir, { recursive: true, force: true });
  });

  async function seedCompletedWake(state = 'state-1'): Promise<OAuthPendingRecord> {
    const storage = await import('../../../system/oauth/storage.js');
    const meta: OAuthPendingMeta = {
      state,
      server_name: 'notion',
      issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token',
      authorization_endpoint: 'https://auth.example.com/authorize',
      scopes: ['read'],
      resource: 'https://mcp.example.com/mcp',
      redirect_uri: 'https://archie.example.com/oauth/callback',
      created_at: Math.floor(Date.now() / 1000),
      slack_user_id: 'U1',
      task_id: 'task-1',
    };
    await storage.writePendingRecord(meta, { code_verifier: 'verifier', client_id: 'client' });
    await storage.markPendingCompleted(state, {
      access_token: 'AT-user', token_type: 'Bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: ['read'],
    });
    return (await storage.readPendingRecord(state))!;
  }

  it.each(['task:stopped', 'task:completed'] as const)(
    'delivers after %s and removes the outbox record',
    async (eventType) => {
      const pending = await seedCompletedWake();
      const { activeTasks, Task } = await import('../../../tasks/task.js');
      const { emitEvent } = await import('../../../system/event-bus.js');
      const { wakeDmTask } = await import('../routes.js');
      const storage = await import('../../../system/oauth/storage.js');
      const sendMessage = vi.fn(async () => {});
      const save = vi.fn(async () => {});

      activeTasks.set('task-1', { isActive: true } as unknown as TaskType);
      vi.spyOn(Task, 'get').mockResolvedValue({ sendMessage, save } as unknown as TaskType);

      await expect(wakeDmTask(pending)).resolves.toBe(true);
      expect(sendMessage).not.toHaveBeenCalled();

      activeTasks.delete('task-1');
      emitEvent(eventType, 'task-1');

      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
      expect(save).toHaveBeenCalledWith(true);
      await vi.waitFor(async () => expect(await storage.readPendingRecord('state-1')).toBeNull());
      const userRecord = await storage.readUserOAuthRecord('U1', 'notion');
      expect(userRecord).toMatchObject({ resource: 'https://mcp.example.com/mcp', scopes: ['read'] });
      expect(await storage.readUserOAuthSealed(userRecord!)).toMatchObject({ access_token: 'AT-user' });
    },
    15_000,
  );

  it('delivers immediately when the originating task is already inactive', async () => {
    const pending = await seedCompletedWake();
    const { Task } = await import('../../../tasks/task.js');
    const { wakeDmTask } = await import('../routes.js');
    const storage = await import('../../../system/oauth/storage.js');
    const sendMessage = vi.fn(async () => {});
    const save = vi.fn(async () => {});
    vi.spyOn(Task, 'get').mockResolvedValue({ sendMessage, save } as unknown as TaskType);

    await expect(wakeDmTask(pending)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(await storage.readPendingRecord('state-1')).toBeNull();
  });

  it('retains a failed wake and lets startup replay retry it', async () => {
    const pending = await seedCompletedWake();
    const { Task } = await import('../../../tasks/task.js');
    const { replayCompletedDmWakes, wakeDmTask } = await import('../routes.js');
    const storage = await import('../../../system/oauth/storage.js');
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce(undefined);
    const save = vi.fn(async () => {});
    vi.spyOn(Task, 'get').mockResolvedValue({ sendMessage, save } as unknown as TaskType);

    await expect(wakeDmTask(pending)).resolves.toBe(false);
    expect(await storage.readPendingRecord('state-1')).not.toBeNull();

    await replayCompletedDmWakes();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(await storage.readPendingRecord('state-1')).toBeNull();
  });

  it('startup replay delivers into a task recovered as active', async () => {
    await seedCompletedWake();
    const { activeTasks, Task } = await import('../../../tasks/task.js');
    const { replayCompletedDmWakes } = await import('../routes.js');
    const storage = await import('../../../system/oauth/storage.js');
    const sendMessage = vi.fn(async () => {});
    const save = vi.fn(async () => {});
    activeTasks.set('task-1', { sendMessage, save } as unknown as TaskType);

    await replayCompletedDmWakes();

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(await storage.readPendingRecord('state-1')).toBeNull();
  });

  it('serializes concurrent delivery attempts for the same state', async () => {
    const pending = await seedCompletedWake();
    const { Task } = await import('../../../tasks/task.js');
    const { replayCompletedDmWakes, wakeDmTask } = await import('../routes.js');
    const sendMessage = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    vi.spyOn(Task, 'get').mockResolvedValue({ sendMessage, save: vi.fn() } as unknown as TaskType);

    await Promise.all([wakeDmTask(pending), replayCompletedDmWakes()]);

    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
