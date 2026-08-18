import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/prompt-loader.js', () => ({
  loadPrompt: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

import { buildExtractionPrompt } from '../extractor.js';

describe('buildExtractionPrompt prompt loading', () => {
  it('fails clearly when the required prompt is unavailable', async () => {
    await expect(buildExtractionPrompt({
      collaborationProfiles: '',
      entityIndex: '',
      taskId: 'task-1',
      participants: '',
      taskOwner: '',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00Z',
      transcript: 'done',
    })).rejects.toThrow('Required prompt prompts/memory-extractor.md could not be loaded: ENOENT');
  });
});
