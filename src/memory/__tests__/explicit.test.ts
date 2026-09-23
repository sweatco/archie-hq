import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../tasks/task.js';
import type { TaskMetadata } from '../../types/task.js';

const state = vi.hoisted(() => ({
  enabled: true,
  scope: 'public' as 'public' | 'user' | 'none',
  profile: '',
  observations: [] as string[],
  beforeWrite: undefined as undefined | (() => void),
  writeUser: vi.fn(),
  writeEntity: vi.fn(),
  rebuildIndex: vi.fn(),
}));

vi.mock('../paths.js', () => ({
  isMemoryReady: () => state.enabled,
  isMemoryToolsEnabled: () => state.enabled,
  isMemoryHumanUserId: (id: string) => /^U[A-Z0-9]{6,}$/.test(id),
  isValidEntitySlug: (slug: string) => /^[a-z0-9][a-z0-9-]*$/.test(slug),
}));
vi.mock('../../connectors/slack/client.js', () => ({
  classifySlackMemoryScope: async (channelId: string) => state.scope === 'user'
    ? { kind: 'user', user_id: 'U07AUTHOR1' }
    : { kind: state.scope, channel_id: channelId },
  getUserInfo: async (id: string) => ({ teamId: id === 'U07AUTHOR1' ? 'T1' : 'T2' }),
  isInternalMemoryUser: (user: { teamId: string }) => user.teamId === 'T1',
}));
vi.mock('../lifecycle.js', () => ({
  enqueueMemoryWrite: async (write: () => Promise<unknown>) => {
    state.beforeWrite?.();
    state.beforeWrite = undefined;
    return write();
  },
}));
vi.mock('../store.js', () => ({
  readUser: async () => state.profile,
  applyUserUpdatesWithIdentity: async (_id: string, _name: string, updates: Array<{ content: string }>) => {
    state.writeUser(updates[0]!.content);
    state.profile += `- ${updates[0]!.content}\n`;
    return { appliedUpdates: updates, capExceeded: false };
  },
}));
vi.mock('../entities.js', () => ({
  listEntities: async () => state.observations.length ? [{ entity: 'payments', aliases: [], observations: state.observations.map((text) => ({ category: 'fact', text })) }] : [],
  resolveEntity: (key: string, records: Array<{ entity: string }>) => records.find((record) => record.entity === key) ?? null,
  applyEntityUpdate: async (update: { slug: string; observations: Array<{ text: string }> }) => {
    state.writeEntity(update);
    state.observations.push(update.observations[0]!.text);
    return { slug: update.slug, created: state.observations.length === 1, capExceeded: false };
  },
}));
vi.mock('../entity-index.js', () => ({ rebuildIndex: () => state.rebuildIndex() }));
vi.mock('../../system/logger.js', () => ({ logger: { warn: vi.fn() } }));

import { rememberFact, rememberPreference, resolvePreferenceApproval } from '../explicit.js';

function task(channelId = 'C07PUBLIC1'): Task {
  const metadata = {
    task_id: 'task-explicit',
    memory_destination: { channel_id: channelId },
    memory_authors: { U07AUTHOR1: 'Author' },
    memory_message_authors: { '123.456': 'U07AUTHOR1' },
    channels: { [`slack:${channelId}:100.0`]: { type: 'slack', channel_id: channelId, thread_id: '100.0' } },
  } as unknown as TaskMetadata;
  return {
    taskId: 'task-explicit', metadata,
    save: vi.fn().mockResolvedValue(undefined),
    postInteractiveToUser: vi.fn().mockResolvedValue(undefined),
  } as unknown as Task;
}

describe('explicit memory', () => {
  beforeEach(() => {
    state.enabled = true;
    state.scope = 'public';
    state.profile = '';
    state.observations = [];
    state.beforeWrite = undefined;
    state.writeUser.mockReset();
    state.writeEntity.mockReset();
    state.rebuildIndex.mockReset();
  });

  it('saves a public preference for its recorded author and treats a retry as unchanged', async () => {
    const current = task();
    const request = { content: 'Prefers short answers', source_message_ts: '123.456' };
    expect((await rememberPreference(current, request)).status).toBe('saved');
    expect((await rememberPreference(current, request)).status).toBe('unchanged');
    expect(state.writeUser).toHaveBeenCalledTimes(1);
    expect((await rememberPreference(current, { ...request, source_message_ts: 'unknown' })).status).toBe('rejected');
  });

  it('requires the DM author to approve the exact pending preference', async () => {
    state.scope = 'user';
    const current = task('D07PRIVATE1');
    const pending = await rememberPreference(current, { content: 'Prefers short answers', source_message_ts: '123.456' });
    expect(pending.status).toBe('pending');
    expect(state.writeUser).not.toHaveBeenCalled();
    expect(current.postInteractiveToUser).toHaveBeenCalledOnce();
    const id = current.metadata.pending_memory_preference!.id;
    expect((await resolvePreferenceApproval(current, id, 'U07OTHER22', 'D07PRIVATE1', true)).status).toBe('rejected');
    expect(state.writeUser).not.toHaveBeenCalled();
    expect((await resolvePreferenceApproval(current, id, 'U07AUTHOR1', 'D07PRIVATE1', true)).status).toBe('saved');
    expect(current.metadata.pending_memory_preference).toBeUndefined();
    expect(state.writeUser).toHaveBeenCalledOnce();
  });

  it('rejects approval when the DM audience changes', async () => {
    state.scope = 'user';
    const current = task('D07PRIVATE1');
    await rememberPreference(current, { content: 'Prefers short answers', source_message_ts: '123.456' });
    const id = current.metadata.pending_memory_preference!.id;
    state.scope = 'none';
    expect((await resolvePreferenceApproval(current, id, 'U07AUTHOR1', 'D07PRIVATE1', true)).status).toBe('rejected');
    expect(state.writeUser).not.toHaveBeenCalled();
  });

  it('writes a public fact once and declines private facts', async () => {
    const current = task();
    const request = { entity: 'payments', content: 'Uses idempotency keys', source_message_ts: '123.456', create: { type: 'service' as const, summary: 'Payment service' } };
    expect((await rememberFact(current, request)).status).toBe('saved');
    expect((await rememberFact(current, request)).status).toBe('unchanged');
    expect(state.writeEntity).toHaveBeenCalledOnce();
    expect(state.rebuildIndex).toHaveBeenCalledOnce();
    state.scope = 'user';
    expect((await rememberFact(task('D07PRIVATE1'), request)).status).toBe('rejected');
    expect(state.writeEntity).toHaveBeenCalledOnce();
  });

  it('checks authorization again when a queued write runs', async () => {
    state.beforeWrite = () => { state.scope = 'none'; };
    expect((await rememberPreference(task(), { content: 'Prefers short answers', source_message_ts: '123.456' })).status).toBe('rejected');
    expect(state.writeUser).not.toHaveBeenCalled();
  });

  it('does not write when memory is disabled', async () => {
    state.enabled = false;
    expect((await rememberPreference(task(), { content: 'Prefers short answers', source_message_ts: '123.456' })).status).toBe('rejected');
    expect(state.writeUser).not.toHaveBeenCalled();
  });

  it('expires an unapproved private preference without writing it', async () => {
    state.scope = 'user';
    const current = task('D07PRIVATE1');
    await rememberPreference(current, { content: 'Prefers short answers', source_message_ts: '123.456' });
    const pending = current.metadata.pending_memory_preference!;
    pending.requested_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const outcome = await resolvePreferenceApproval(current, pending.id, 'U07AUTHOR1', 'D07PRIVATE1', true);
    expect(outcome.status).toBe('expired');
    expect(current.metadata.pending_memory_preference).toBeUndefined();
    expect(state.writeUser).not.toHaveBeenCalled();
  });

  it('retains a pending preference when cancelling it fails to persist', async () => {
    state.scope = 'user';
    const current = task('D07PRIVATE1');
    await rememberPreference(current, { content: 'Prefers short answers', source_message_ts: '123.456' });
    const id = current.metadata.pending_memory_preference!.id;
    vi.mocked(current.save).mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(resolvePreferenceApproval(current, id, 'U07AUTHOR1', 'D07PRIVATE1', false)).rejects.toThrow('disk unavailable');
    expect(current.metadata.pending_memory_preference?.id).toBe(id);
    expect(state.writeUser).not.toHaveBeenCalled();
  });
});
