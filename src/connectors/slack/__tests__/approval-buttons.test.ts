/**
 * The Slack approval buttons for edit mode, max mode, research budget and MCP
 * tool calls. A click is the human gate on a consequential action, so these
 * cases pin which Task resolution each button reaches, whose identity is
 * carried into it, and that a stale tool-call card says nothing ran.
 *
 * The handlers are registered inline in `mountSlackApp`, so the app is mounted
 * on a fake Bolt that keeps `app.action` registrations, as
 * `trigger-card-resolution.test.ts` does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Application } from 'express';

type Click = {
  ack: () => Promise<void>;
  action: { value?: string };
  body: { user?: { id: string }; channel?: { id: string }; message?: { ts: string } };
};

// events.ts loads Bolt through `createRequire`, which bypasses vitest's module
// registry, so `module` is mocked and its `createRequire` hands back a fake Bolt.
const bolt = vi.hoisted(() => {
  const actions = new Map<string, (click: Click) => Promise<unknown>>();
  class FakeApp {
    constructor(_options: unknown) {}
    event(_name: string, _handler: unknown) {}
    action(name: string | RegExp, handler: (click: Click) => Promise<unknown>) {
      actions.set(String(name), handler);
    }
  }
  class FakeReceiver {
    constructor(_options: unknown) {}
  }
  return {
    actions,
    exports: { App: FakeApp, ExpressReceiver: FakeReceiver, SocketModeReceiver: FakeReceiver },
  };
});

vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const real = actual.createRequire(url);
      const patched = (id: string): unknown => (id === '@slack/bolt' ? bolt.exports : real(id));
      return Object.assign(patched, real);
    },
  };
});

vi.mock('../client.js', () => ({
  initSlackClient: vi.fn(),
  getBotUserId: vi.fn().mockReturnValue('U_BOT'),
  getBotId: vi.fn().mockReturnValue('B_OURS'),
  setSlackDryRun: vi.fn(),
  getUserInfo: vi.fn(),
  isExternalUser: vi.fn(),
  getSlackClient: vi.fn(),
}));
vi.mock('../../../system/trigger-scheduler.js', () => ({
  getChannelMessageTriggers: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../tasks/persistence.js', () => ({ findTaskByThread: vi.fn() }));
vi.mock('../../../tasks/task.js', () => ({ Task: { get: vi.fn() } }));
vi.mock('../channel-canvas.js', () => ({ ensureChannelCanvas: vi.fn() }));
vi.mock('../channel-pins.js', () => ({ ensureChannelPins: vi.fn() }));
vi.mock('../title.js', () => ({ setAssistantThreadTitle: vi.fn() }));
vi.mock('../../../tasks/title-generator.js', () => ({ generateTaskTitle: vi.fn() }));
vi.mock('../../../system/shutdown.js', () => ({
  getIsShuttingDown: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../system/workdir.js', () => ({
  SESSIONS_DIR: '/tmp/sessions',
  WORKDIR: '/tmp/workdir',
}));
vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    plain: vi.fn(),
    server: vi.fn(),
  },
}));

import { mountSlackApp } from '../events.js';
import { getUserInfo, isExternalUser } from '../client.js';
import { Task } from '../../../tasks/task.js';
import { logger } from '../../../system/logger.js';
import { expectDefined } from '../../../test-support/assertions.js';

const TASK_ID = 'task-20260101-1823-abc123';
const CARD = { channel: { id: 'C_THREAD' }, message: { ts: '1722250000.000100' } };

function makeTask() {
  return {
    updateSlackMessageSafely: vi
      .fn<(channel: string, ts: string, text: string, blocks: unknown[]) => Promise<void>>()
      .mockResolvedValue(undefined),
    handleEditModeApproval: vi.fn().mockResolvedValue(undefined),
    handleEditModeDenial: vi.fn().mockResolvedValue(undefined),
    handleMaxModeApproval: vi.fn().mockResolvedValue(undefined),
    handleMaxModeDenial: vi.fn().mockResolvedValue(undefined),
    handleResearchBudgetApproval: vi.fn().mockResolvedValue(undefined),
    handleResearchBudgetDenial: vi.fn().mockResolvedValue(undefined),
    handleToolCallApproval: vi.fn().mockResolvedValue('resolved'),
    handleToolCallDenial: vi.fn().mockResolvedValue('resolved'),
  };
}

let task: ReturnType<typeof makeTask>;

async function click(actionId: string, value: string | undefined = TASK_ID): Promise<void> {
  const handler = expectDefined(bolt.actions.get(actionId));
  const ack = vi.fn().mockResolvedValue(undefined);
  await handler({ ack, action: { value }, body: { user: { id: 'U_CLICKER' }, ...CARD } });
  expect(ack).toHaveBeenCalledTimes(1);
}

function cardText(): string {
  expect(task.updateSlackMessageSafely).toHaveBeenCalledTimes(1);
  const [channel, ts, text, blocks] = expectDefined(task.updateSlackMessageSafely.mock.calls[0]);
  expect([channel, ts, blocks]).toEqual(['C_THREAD', '1722250000.000100', []]);
  return text;
}

beforeEach(async () => {
  vi.clearAllMocks();
  bolt.actions.clear();
  task = makeTask();
  vi.mocked(Task.get).mockResolvedValue(task as never);
  vi.mocked(getUserInfo).mockResolvedValue({
    realName: 'Ada Lovelace',
    email: 'ada@example.test',
  } as never);
  vi.mocked(isExternalUser).mockReturnValue(false);
  await mountSlackApp({} as Application, {
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
  });
});

describe('edit mode buttons', () => {
  it('approves with the clicker as commit author and retires the buttons', async () => {
    await click('approve_edit_mode');

    expect(Task.get).toHaveBeenCalledWith(TASK_ID);
    expect(task.handleEditModeApproval).toHaveBeenCalledExactlyOnceWith({
      id: 'U_CLICKER',
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    });
    expect(cardText()).toBe('✅ *Edit mode approved* by <@U_CLICKER>');
  });

  it('approves for an external clicker but keeps their identity out of git history', async () => {
    vi.mocked(isExternalUser).mockReturnValue(true);
    await click('approve_edit_mode');
    expect(task.handleEditModeApproval).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('still approves when the approver lookup fails', async () => {
    vi.mocked(getUserInfo).mockRejectedValue(new Error('users.info failed'));
    await click('approve_edit_mode');
    expect(task.handleEditModeApproval).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('denies without approving', async () => {
    await click('deny_edit_mode');
    expect(task.handleEditModeDenial).toHaveBeenCalledTimes(1);
    expect(task.handleEditModeApproval).not.toHaveBeenCalled();
    expect(cardText()).toBe('❌ *Edit mode denied* by <@U_CLICKER>');
  });

  it('ignores a click that carries no task id', async () => {
    await click('approve_edit_mode', '');
    expect(Task.get).not.toHaveBeenCalled();
  });

  it('logs a failed resolution instead of rejecting the Bolt handler', async () => {
    const failure = new Error('task is gone');
    vi.mocked(Task.get).mockRejectedValue(failure);
    await click('approve_edit_mode');
    expect(logger.error).toHaveBeenCalledWith(
      'Server',
      'Error handling edit mode approval',
      failure,
    );
  });
});

describe('max mode and research budget buttons', () => {
  it('approves max mode with the clicker name for the audit finding', async () => {
    await click('approve_max_mode');
    expect(task.handleMaxModeApproval).toHaveBeenCalledExactlyOnceWith('Ada Lovelace');
    expect(cardText()).toBe('✅ *Max mode approved* by <@U_CLICKER>');
  });

  it.each([
    ['deny_max_mode', 'handleMaxModeDenial', '❌ *Max mode denied* by <@U_CLICKER>'],
    [
      'approve_research_budget',
      'handleResearchBudgetApproval',
      '✅ *Research budget extended* by <@U_CLICKER> (+5 requests)',
    ],
    [
      'deny_research_budget',
      'handleResearchBudgetDenial',
      '❌ *Additional research denied* by <@U_CLICKER>',
    ],
  ] as const)('%s resolves through %s', async (actionId, handler, text) => {
    await click(actionId);
    expect(task[handler]).toHaveBeenCalledTimes(1);
    expect(cardText()).toBe(text);
  });
});

describe('tool call buttons', () => {
  const VALUE = `${TASK_ID}|digest-1`;

  it('approves the exact call named by the button digest', async () => {
    await click('approve_tool_call', VALUE);
    expect(Task.get).toHaveBeenCalledWith(TASK_ID);
    expect(task.handleToolCallApproval).toHaveBeenCalledExactlyOnceWith(
      { id: 'U_CLICKER', name: 'Ada Lovelace' },
      'digest-1',
    );
    expect(cardText()).toBe('✅ *Tool call approved* by <@U_CLICKER>');
  });

  it('omits an external clicker from the audit finding but still resolves', async () => {
    vi.mocked(isExternalUser).mockReturnValue(true);
    await click('approve_tool_call', VALUE);
    expect(task.handleToolCallApproval).toHaveBeenCalledExactlyOnceWith(undefined, 'digest-1');
  });

  it('denies the call named by the digest', async () => {
    await click('deny_tool_call', VALUE);
    expect(task.handleToolCallDenial).toHaveBeenCalledExactlyOnceWith('digest-1');
    expect(cardText()).toBe('❌ *Tool call denied* by <@U_CLICKER>');
  });

  it.each(['approve_tool_call', 'deny_tool_call'])(
    '%s on a stale card says nothing ran',
    async (actionId) => {
      task.handleToolCallApproval.mockResolvedValue('stale');
      task.handleToolCallDenial.mockResolvedValue('stale');
      await click(actionId, VALUE);
      expect(cardText()).toContain('This approval prompt is stale');
    },
  );
});

describe('mountSlackApp configuration', () => {
  it('refuses an app token that is not an app-level token', async () => {
    await expect(
      mountSlackApp({} as Application, { slackBotToken: 'xoxb-test', slackAppToken: 'xoxb-wrong' }),
    ).rejects.toThrow('SLACK_APP_TOKEN must start with "xapp-"');
  });

  it('requires a signing secret in HTTP mode', async () => {
    await expect(mountSlackApp({} as Application, { slackBotToken: 'xoxb-test' })).rejects.toThrow(
      'SLACK_SIGNING_SECRET is required',
    );
  });
});
