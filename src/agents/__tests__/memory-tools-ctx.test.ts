import { describe, it, expect } from 'vitest';
import { deriveMemoryToolsCtx } from '../spawn.js';

describe('deriveMemoryToolsCtx', () => {
  it('carries taskId, agent, and author user ids', () => {
    const ctx = deriveMemoryToolsCtx('task-1', 'pm-agent', [
      { userId: 'U07AAA111' },
      { userId: 'U07BBB222' },
    ]);

    expect(ctx.taskId).toBe('task-1');
    expect(ctx.agent).toBe('pm-agent');
    expect(ctx.authorUserIds).toEqual(['U07AAA111', 'U07BBB222']);
  });

  it('supports tasks with no author users', () => {
    const ctx = deriveMemoryToolsCtx('t', 'a', []);
    expect(ctx.authorUserIds).toEqual([]);
  });
});
