import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { Application } from 'express';

const { getUserInfo, classifySlackIdentity, postEphemeral, updateMessage } = vi.hoisted(() => ({
  getUserInfo: vi.fn(),
  classifySlackIdentity: vi.fn(),
  postEphemeral: vi.fn().mockResolvedValue(undefined),
  updateMessage: vi.fn().mockResolvedValue(undefined),
}));
const ingress = vi.hoisted(() => ({
  stop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../client.js', () => ({
  initSlackClient: vi.fn(),
  updateMessage,
  getBotUserId: vi.fn(),
  fetchSlackThread: vi.fn(),
  getBotId: vi.fn(),
  addReaction: vi.fn(),
  setSlackDryRun: vi.fn(),
  getUserInfo,
  classifySlackIdentity,
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
vi.mock('../channel-pins.js', () => ({ ensureChannelPins: vi.fn() }));
vi.mock('../task-routing.js', () => ({ shouldCreateNewTask: vi.fn() }));
vi.mock('../ingress.js', () => ({
  enqueueSlackIngress: vi.fn().mockResolvedValue(undefined),
  startSlackIngress: vi.fn().mockResolvedValue(undefined),
  stopSlackIngress: ingress.stop,
}));
vi.mock('../../../tasks/persistence.js', () => ({ findTaskByThread: vi.fn() }));
vi.mock('../../../system/trigger-scheduler.js', () => ({
  getChannelMessageTriggers: vi.fn(),
  fireTrigger: vi.fn(),
  triggerWhat: vi.fn(),
}));
vi.mock('../../../tasks/title-generator.js', () => ({ generateTaskTitle: vi.fn() }));
vi.mock('../title.js', () => ({ setAssistantThreadTitle: vi.fn() }));

import { mountSlackApp, resolveInternalActionActor } from '../events.js';
import { logger } from '../../../system/logger.js';

const require = createRequire(import.meta.url);
const { App } = require('@slack/bolt') as typeof import('@slack/bolt');

describe('resolveInternalActionActor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    classifySlackIdentity.mockReturnValue('internal');
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

  it('fails closed when the actor has no verifiable team', async () => {
    getUserInfo.mockResolvedValue({ realName: 'Unknown Team' });
    classifySlackIdentity.mockReturnValue('unknown');

    await expect(resolveInternalActionActor({
      user: { id: 'U07UNKNOWN' },
      channel: { id: 'C123' },
      message: { ts: '100.1', thread_ts: '100.0' },
    }, 'merge approval')).resolves.toBeNull();

    expect(postEphemeral).toHaveBeenCalledWith(
      'C123',
      'U07UNKNOWN',
      expect.stringContaining("couldn't verify"),
      '100.0',
    );
  });

  it('tells an external clicker and leaves the card waiting for an internal actor', async () => {
    getUserInfo.mockResolvedValue({ realName: 'Partner User', teamId: 'TEXTERNAL' });
    classifySlackIdentity.mockReturnValue('external');
    const blocks = [{ type: 'actions', elements: [{ type: 'button', action_id: 'approve_edit_mode' }] }];

    await expect(resolveInternalActionActor({
      user: { id: 'U07EXT123' },
      channel: { id: 'C123' },
      message: { ts: '100.1', thread_ts: '100.0', blocks },
    }, 'edit-mode approval')).resolves.toBeNull();

    expect(postEphemeral).toHaveBeenCalledWith(
      'C123',
      'U07EXT123',
      expect.stringContaining('Only members of this workspace'),
      '100.0',
    );
    expect(updateMessage).toHaveBeenCalledWith(
      'C123',
      '100.1',
      expect.stringContaining('Waiting for a workspace member'),
      expect.arrayContaining([
        blocks[0],
        expect.objectContaining({ block_id: 'external-actor-waiting' }),
      ]),
    );
  });
});

describe('Slack lifecycle', () => {
  it('stops durable ingress even when the Socket Mode receiver fails to stop', async () => {
    const receiverError = new Error('receiver failed');
    const stopReceiver = vi.spyOn(App.prototype, 'stop').mockRejectedValueOnce(receiverError);
    const lifecycle = await mountSlackApp({} as Application, {
      slackBotToken: 'xoxb-test',
      slackAppToken: 'xapp-test',
    });

    await expect(lifecycle.stop()).rejects.toBe(receiverError);

    expect(ingress.stop).toHaveBeenCalledOnce();
    expect(logger.plain).not.toHaveBeenCalledWith('Slack: Socket Mode disconnected');
    stopReceiver.mockRestore();
  });
});
