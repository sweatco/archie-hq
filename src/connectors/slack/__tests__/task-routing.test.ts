import { describe, it, expect } from 'vitest';
import { shouldCreateNewTask } from '../task-routing.js';

describe('shouldCreateNewTask', () => {
  it('creates a task on @mention (anywhere)', () => {
    expect(shouldCreateNewTask('app_mention', 'C123', false)).toBe(true);
  });

  it('creates a task for a DM message', () => {
    expect(shouldCreateNewTask('message', 'D123', false)).toBe(true);
  });

  it('creates a task when a human replies to a thread the bot started', () => {
    expect(shouldCreateNewTask('message', 'C123', true)).toBe(true);
  });

  it('does NOT create a task for a plain reply in a human-started channel thread', () => {
    expect(shouldCreateNewTask('message', 'C123', false)).toBe(false);
  });

  it('@mention still wins even if the root is not the bot', () => {
    expect(shouldCreateNewTask('app_mention', 'C123', false)).toBe(true);
  });
});
