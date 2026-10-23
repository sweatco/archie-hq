/**
 * The Slack tool-call buttons and the API approve route: only Slack hands the
 * Task method a clicker id, so a restricted call can never be approved over the
 * API, and a 'forbidden' disposition leaves the prompt untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../slack/client.js', () => ({
  initSlackClient: vi.fn(),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  getBotUserId: vi.fn(),
  fetchSlackThread: vi.fn(),
  getBotId: vi.fn(),
  addReaction: vi.fn(),
  setSlackDryRun: vi.fn(),
  getUserInfo: vi.fn(),
  isExternalUser: vi.fn().mockReturnValue(false),
  isChannelShared: vi.fn(),
  postEphemeral: vi.fn(),
  getSlackClient: vi.fn(),
  cleanSlackText: vi.fn((s: string) => s),
}));

vi.mock('../slack/channel-canvas.js', () => ({ ensureChannelCanvas: vi.fn() }));
vi.mock('../slack/channel-pins.js', () => ({ ensureChannelPins: vi.fn() }));
vi.mock('../slack/title.js', () => ({ setAssistantThreadTitle: vi.fn() }));
vi.mock('../../tasks/title-generator.js', () => ({ generateTaskTitle: vi.fn() }));
vi.mock('../../system/shutdown.js', () => ({ getIsShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('../../system/event-bus.js', () => ({
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  emitEvent: vi.fn(),
}));
vi.mock('../../system/workdir.js', () => ({ SESSIONS_DIR: '/tmp/sessions' }));

vi.mock('../../tasks/task.js', () => ({
  Task: { get: vi.fn() },
  activeTasks: new Map(),
}));

vi.mock('../../tasks/persistence.js', () => ({
  findTaskByThread: vi.fn(),
  readKnowledgeLog: vi.fn(),
  loadMetadata: vi.fn(),
  appendCliMessage: vi.fn(),
  readEvents: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), server: vi.fn(), slack: vi.fn(),
  },
}));

import type { App as AppType } from '@slack/bolt';
import type { Application, Request, Response } from 'express';
import { registerToolApprovalHandlers } from '../slack/events.js';
import { mountApiRoutes } from '../api/routes.js';
import { Task } from '../../tasks/task.js';
import { getUserInfo, isExternalUser, postEphemeral } from '../slack/client.js';
import { emitEvent } from '../../system/event-bus.js';

const DIGEST = 'd1'.padEnd(16, '0');
const BUTTON_VALUE = `task-123|${DIGEST}`;

type FakeTask = {
  handleToolCallApproval: ReturnType<typeof vi.fn>;
  handleToolCallDenial: ReturnType<typeof vi.fn>;
  updateSlackMessageSafely: ReturnType<typeof vi.fn>;
};

function makeFakeTask(): FakeTask {
  return {
    handleToolCallApproval: vi.fn().mockResolvedValue('resolved'),
    handleToolCallDenial: vi.fn().mockResolvedValue('resolved'),
    updateSlackMessageSafely: vi.fn().mockResolvedValue(undefined),
  };
}

// ---- Capture the Slack handlers from a fake Bolt app ----

type BoltHandler = (args: {
  action: { value: string };
  ack: () => Promise<void>;
  body: Record<string, unknown>;
}) => Promise<void>;

function captureSlackHandlers(): { approve: BoltHandler; deny: BoltHandler } {
  const registrations = new Map<string, BoltHandler>();
  const fakeApp = {
    action: vi.fn((actionId: string, handler: BoltHandler) => {
      registrations.set(actionId, handler);
    }),
  };
  registerToolApprovalHandlers(fakeApp as unknown as Pick<AppType, 'action'>);
  return { approve: registrations.get('approve_tool_call')!, deny: registrations.get('deny_tool_call')! };
}

function slackPayload(value: string = BUTTON_VALUE) {
  return {
    action: { value },
    ack: vi.fn().mockResolvedValue(undefined),
    body: { user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: '111.222', thread_ts: '100.000' } },
  };
}

// ---- Capture the approve route handler from the mounted router ----

type RouteHandler = (req: Request, res: Response) => Promise<void>;

function captureApproveRoute(): RouteHandler {
  const fakeApp = { use: vi.fn() };
  mountApiRoutes(fakeApp as unknown as Application);
  const router = fakeApp.use.mock.calls[0]![1] as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RouteHandler }> } }>;
  };
  const layer = router.stack.find((l) => l.route?.path === '/tasks/:id/approve' && l.route.methods['post']);
  return layer!.route!.stack[0]!.handle;
}

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function makeReq(body: Record<string, unknown>): Request {
  return { params: { id: 'task-123' }, body } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isExternalUser).mockReturnValue(false);
  vi.mocked(getUserInfo).mockResolvedValue({ realName: 'Dana', email: 'dana@example.com' } as never);
});

describe('tool-call approval — Slack button', () => {
  it('passes the clicker id to the Task method', async () => {
    const task = makeFakeTask();
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    const { approve } = captureSlackHandlers();
    await approve(slackPayload() as never);

    expect(task.handleToolCallApproval).toHaveBeenCalledWith(
      { id: 'U1', name: 'Dana' }, DIGEST, 'U1',
    );
  });

  it('forbidden: tells the clicker privately and leaves the prompt open', async () => {
    const task = makeFakeTask();
    task.handleToolCallApproval.mockResolvedValue('forbidden');
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    const { approve } = captureSlackHandlers();
    await approve(slackPayload() as never);

    expect(postEphemeral).toHaveBeenCalledWith('C1', 'U1', expect.stringContaining('still open'), '100.000');
    expect(task.updateSlackMessageSafely).not.toHaveBeenCalled();
  });

  it('resolved: updates the prompt with the approval', async () => {
    const task = makeFakeTask();
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    const { approve } = captureSlackHandlers();
    await approve(slackPayload() as never);

    expect(task.updateSlackMessageSafely).toHaveBeenCalledWith(
      'C1', '111.222', expect.stringContaining('✅ *Tool call approved*'), [],
    );
    expect(postEphemeral).not.toHaveBeenCalled();
  });
});

describe('tool-call approval — API route', () => {
  it('approve: calls handleToolCallApproval with no Slack user id', async () => {
    const task = makeFakeTask();
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    const route = captureApproveRoute();
    const res = makeRes();
    await route(makeReq({ type: 'tool_call', approve: true, ref: DIGEST }), res);

    expect(task.handleToolCallApproval).toHaveBeenCalledTimes(1);
    expect(task.handleToolCallApproval.mock.calls[0]).toHaveLength(2);
    expect(task.handleToolCallApproval.mock.calls[0]![1]).toBe(DIGEST);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('forbidden: 403 and no approval:resolved event', async () => {
    const task = makeFakeTask();
    task.handleToolCallApproval.mockResolvedValue('forbidden');
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    const route = captureApproveRoute();
    const res = makeRes();
    await route(makeReq({ type: 'tool_call', approve: true, ref: DIGEST }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(vi.mocked(emitEvent)).not.toHaveBeenCalledWith(
      'approval:resolved', expect.anything(), expect.anything(),
    );
  });

  it('deny: calls handleToolCallDenial and returns 200', async () => {
    const task = makeFakeTask();
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    const route = captureApproveRoute();
    const res = makeRes();
    await route(makeReq({ type: 'tool_call', approve: false, ref: DIGEST }), res);

    expect(task.handleToolCallDenial).toHaveBeenCalledWith(DIGEST);
    expect(task.handleToolCallApproval).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
