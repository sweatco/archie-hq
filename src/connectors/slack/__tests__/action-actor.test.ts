import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserInfo, postEphemeral } = vi.hoisted(() => ({
  getUserInfo: vi.fn(),
  postEphemeral: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../client.js', () => ({
  initSlackClient: vi.fn(),
  updateMessage: vi.fn(),
  getBotUserId: vi.fn(),
  fetchSlackThread: vi.fn(),
  getBotId: vi.fn(),
  addReaction: vi.fn(),
  setSlackDryRun: vi.fn(),
  getUserInfo,
  isExternalUser: () => false,
  isChannelShared: vi.fn(),
  postEphemeral,
  getSlackClient: vi.fn(),
  cleanSlackText: vi.fn(),
}));
vi.mock('../../../tasks/task.js', () => ({ Task: {} }));
vi.mock('../../../agents/prompts.js', () => ({ AGENT_PROMPTS: {} }));
vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), server: vi.fn(), plain: vi.fn() },
}));
vi.mock('../channel-canvas.js', () => ({ ensureChannelCanvas: vi.fn() }));
vi.mock('../task-routing.js', () => ({ shouldCreateNewTask: vi.fn() }));
vi.mock('../../../tasks/persistence.js', () => ({ findTaskByThread: vi.fn() }));
vi.mock('../../../system/trigger-scheduler.js', () => ({
  getChannelMessageTriggers: vi.fn(),
  fireTrigger: vi.fn(),
  triggerWhat: vi.fn(),
}));
vi.mock('../../../tasks/title-generator.js', () => ({ generateTaskTitle: vi.fn() }));
vi.mock('../title.js', () => ({ setAssistantThreadTitle: vi.fn() }));

import { resolveInternalActionActor } from '../events.js';

describe('resolveInternalActionActor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed and tells the clicker when Slack classification fails', async () => {
    getUserInfo.mockRejectedValue(new Error('rate limited'));

    await expect(resolveInternalActionActor({
      user: { id: 'U07ABC123' },
      channel: { id: 'C123' },
      message: { ts: '100.1', thread_ts: '100.0' },
    }, 'edit-mode approval')).resolves.toBeNull();

    expect(postEphemeral).toHaveBeenCalledWith(
      'C123',
      'U07ABC123',
      expect.stringContaining("couldn't verify"),
      '100.0',
    );
  });
});
