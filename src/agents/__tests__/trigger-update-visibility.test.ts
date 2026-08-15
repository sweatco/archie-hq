import { describe, expect, it } from 'vitest';
import { triggerContentEditAllowed } from '../tools.js';

describe('triggerContentEditAllowed', () => {
  it('allows status-only updates from private tasks', () => {
    expect(triggerContentEditAllowed('private', {})).toBe(true);
  });

  it.each([
    { action_prompt: 'Publish the private roadmap' },
    { summary: 'Private roadmap report' },
    { conditions: [{ type: 'schedule' }] },
  ])('rejects content edits from private tasks: %j', (update) => {
    expect(triggerContentEditAllowed('private', update)).toBe(false);
  });

  it('allows content edits from public tasks', () => {
    expect(triggerContentEditAllowed('public', { action_prompt: 'Summarize public releases' })).toBe(true);
  });
});
