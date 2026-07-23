import { describe, expect, it } from 'vitest';
import { Task } from '../task.js';
import type { Channel } from '../../types/task.js';

function resolve(defaultChannel: string | null, channels: Record<string, Channel>): string | null {
  return Task.prototype.getMcpOAuthUser.call({
    metadata: { default_channel: defaultChannel, channels },
  } as Task);
}

describe('Task.getMcpOAuthUser', () => {
  const dm: Channel = {
    type: 'slack',
    channel_id: 'D1',
    channel_name: 'DM with Alice',
    thread_id: '1.0',
    last_processed_ts: '1.0',
    dm_user_id: 'U1',
  };

  it('returns the participant of the default 1:1 DM', () => {
    expect(resolve('dm', { dm })).toBe('U1');
  });

  it('does not enable per-user OAuth for channel tasks', () => {
    const channel: Channel = {
      type: 'slack',
      channel_id: 'C1',
      channel_name: 'general',
      thread_id: '1.0',
      last_processed_ts: '1.0',
    };
    expect(resolve('channel', { channel, dm })).toBeNull();
  });

  it('requires a resolved DM participant', () => {
    expect(resolve('dm', { dm: { ...dm, dm_user_id: undefined } })).toBeNull();
  });

  it('rejects authorization outside a DM', async () => {
    await expect(Task.prototype.requestMcpAuth.call({
      getMcpOAuthUser: () => null,
    } as unknown as Task, 'notion')).rejects.toThrow('only in a 1:1 Slack DM');
  });
});
