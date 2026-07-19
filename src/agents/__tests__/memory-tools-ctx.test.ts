import { describe, it, expect } from 'vitest';
import { deriveMemoryToolsCtx } from '../spawn.js';
import type { TaskMetadata } from '../../types/task.js';

const slack = (channelId: string, threadId: string, extra: Record<string, unknown> = {}) => ({
  type: 'slack' as const,
  thread_id: threadId,
  channel_id: channelId,
  channel_name: `#${channelId}`,
  last_processed_ts: threadId,
  ...extra,
});

describe('deriveMemoryToolsCtx', () => {
  it('carries taskId, agent, and author user ids; ignores github/cli channels', () => {
    const channels = {
      'slack:C1:100': slack('C1', '100', { visibility: 'public' }),
      'slack:D9:300': slack('D9', '300', { visibility: 'dm' }),
      'github:o/r:5': { type: 'github', repo: 'o/r', pr_number: 5 },
      'cli:local': { type: 'cli', id: 'cli:local' },
    } as unknown as TaskMetadata['channels'];

    const ctx = deriveMemoryToolsCtx('task-1', 'pm-agent', channels, [
      { userId: 'U07AAA111' },
      { userId: 'U07BBB222' },
    ]);

    expect(ctx.taskId).toBe('task-1');
    expect(ctx.agent).toBe('pm-agent');
    expect(ctx.authorUserIds).toEqual(['U07AAA111', 'U07BBB222']);
    expect(ctx.extShared).toBe(false);
  });

  it('flags extShared from stamped visibility OR the legacy isShared snapshot', () => {
    const viaVisibility = deriveMemoryToolsCtx('t', 'a', {
      'slack:C1:1': slack('C1', '1', { visibility: 'ext-shared' }),
    } as unknown as TaskMetadata['channels'], []);
    expect(viaVisibility.extShared).toBe(true);

    const viaSnapshot = deriveMemoryToolsCtx('t', 'a', {
      'slack:C1:1': slack('C1', '1', { isShared: true }),
    } as unknown as TaskMetadata['channels'], []);
    expect(viaSnapshot.extShared).toBe(true);
  });

  it('flags extShared for an unknown (classification-failed) stamp — fail-closed lockdown', () => {
    const ctx = deriveMemoryToolsCtx('t', 'a', {
      'slack:C1:1': slack('C1', '1', { visibility: 'unknown' }),
      'slack:C2:2': slack('C2', '2', { visibility: 'public' }),
    } as unknown as TaskMetadata['channels'], []);
    expect(ctx.extShared).toBe(true);
  });

  it('does NOT lock down for dm/private/public/unstamped channels', () => {
    const ctx = deriveMemoryToolsCtx('t', 'a', {
      'slack:C1:1': slack('C1', '1', { visibility: 'public' }),
      'slack:G1:2': slack('G1', '2', { visibility: 'private' }),
      'slack:D1:3': slack('D1', '3', { visibility: 'dm' }),
      'slack:C9:4': slack('C9', '4'),
    } as unknown as TaskMetadata['channels'], []);
    expect(ctx.extShared).toBe(false);
  });

  it('CLI-only or empty channel maps yield empty scope and no lockdown', () => {
    const ctx = deriveMemoryToolsCtx('t', 'a', {
      'cli:local': { type: 'cli', id: 'cli:local' },
    } as unknown as TaskMetadata['channels'], []);
    expect(ctx.authorUserIds).toEqual([]);
    expect(ctx.extShared).toBe(false);
  });
});
