/**
 * AC8 integration test: the Slack merge buttons and the API approve route
 * resolve through the identical Task methods with the same parsed PR identity.
 *
 * Captures the registered `approve_merge`/`deny_merge` handlers via a fake
 * Bolt app recording `.action` registrations, captures the Express route
 * handler from the mounted router, and drives both with fake payloads against
 * the same fake task. The identity check itself lives in the Task method, not
 * the adapters — here the Task methods are mocked and only the convergence
 * (same method, same `expected`) plus the adapters' disposition handling is
 * asserted.
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
import { registerMergeActionHandlers } from '../slack/events.js';
import { mountApiRoutes } from '../api/routes.js';
import { Task } from '../../tasks/task.js';
import { getUserInfo, isExternalUser, updateMessage } from '../slack/client.js';

const EXPECTED = { github: 'org/backend', pr_number: 42 };
const BUTTON_VALUE = 'task-123|org/backend#42';

type FakeTask = {
  handleMergeApproval: ReturnType<typeof vi.fn>;
  handleMergeDenial: ReturnType<typeof vi.fn>;
};

function makeFakeTask(): FakeTask {
  return {
    handleMergeApproval: vi.fn().mockResolvedValue('resolved'),
    handleMergeDenial: vi.fn().mockResolvedValue('resolved'),
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
  registerMergeActionHandlers(fakeApp as unknown as Pick<AppType, 'action'>);
  return { approve: registrations.get('approve_merge')!, deny: registrations.get('deny_merge')! };
}

function slackPayload(value: string = BUTTON_VALUE) {
  return {
    action: { value },
    ack: vi.fn().mockResolvedValue(undefined),
    body: { user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: '111.222' } },
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

describe('merge approval — Slack button and API route resolve identically (AC8)', () => {
  it('approve: both surfaces call the same handleMergeApproval with the same parsed identity', async () => {
    const task = makeFakeTask();
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    const { approve } = captureSlackHandlers();
    await approve(slackPayload() as never);

    expect(task.handleMergeApproval).toHaveBeenCalledTimes(1);
    const [slackApprover, slackExpected] = task.handleMergeApproval.mock.calls[0]!;
    expect(slackApprover).toEqual({ id: 'U1', name: 'Dana', email: 'dana@example.com' });
    expect(slackExpected).toEqual(EXPECTED);
    expect(vi.mocked(updateMessage)).toHaveBeenCalledWith(
      'C1', '111.222', expect.stringContaining('Merge approved'), [],
    );

    const route = captureApproveRoute();
    const res = makeRes();
    await route(makeReq({ type: 'merge', approve: true, github: 'org/backend', pr_number: 42 }), res);

    expect(task.handleMergeApproval).toHaveBeenCalledTimes(2);
    const [, apiExpected] = task.handleMergeApproval.mock.calls[1]!;
    expect(apiExpected).toEqual(slackExpected);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(task.handleMergeDenial).not.toHaveBeenCalled();
  });

  it('deny: both surfaces call the same handleMergeDenial with the same parsed identity', async () => {
    const task = makeFakeTask();
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    const { deny } = captureSlackHandlers();
    await deny(slackPayload() as never);

    expect(task.handleMergeDenial).toHaveBeenCalledTimes(1);
    expect(task.handleMergeDenial.mock.calls[0]![0]).toEqual(EXPECTED);
    expect(vi.mocked(updateMessage)).toHaveBeenCalledWith(
      'C1', '111.222', expect.stringContaining('Merge denied'), [],
    );

    const route = captureApproveRoute();
    const res = makeRes();
    await route(makeReq({ type: 'merge', approve: false, github: 'org/backend', pr_number: 42 }), res);

    expect(task.handleMergeDenial).toHaveBeenCalledTimes(2);
    expect(task.handleMergeDenial.mock.calls[1]![0]).toEqual(task.handleMergeDenial.mock.calls[0]![0]);
    expect(task.handleMergeApproval).not.toHaveBeenCalled();
  });

  it('mismatched button value: stale disposition, no merge, message updated with the stale notice', async () => {
    const task = makeFakeTask();
    // The Task method rejects the mismatched identity (its atomic gate) — the
    // adapter must relay that as the stale notice, not a confirmation.
    task.handleMergeApproval.mockResolvedValue('stale');
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    const { approve } = captureSlackHandlers();
    await approve(slackPayload('task-123|org/backend#7') as never);

    expect(task.handleMergeApproval).toHaveBeenCalledWith(
      expect.anything(), { github: 'org/backend', pr_number: 7 },
    );
    expect(vi.mocked(updateMessage)).toHaveBeenCalledWith(
      'C1', '111.222', expect.stringContaining('stale'), [],
    );
    expect(vi.mocked(updateMessage)).not.toHaveBeenCalledWith(
      'C1', '111.222', expect.stringContaining('Merge approved'), [],
    );
  });

  it('external approver still resolves the approval with identity omitted', async () => {
    const task = makeFakeTask();
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    vi.mocked(isExternalUser).mockReturnValue(true);

    const { approve } = captureSlackHandlers();
    await approve(slackPayload() as never);

    expect(task.handleMergeApproval).toHaveBeenCalledWith(undefined, EXPECTED);
  });

  it('API merge request without github/pr_number is a 400 with no resolution call', async () => {
    const task = makeFakeTask();
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    const route = captureApproveRoute();
    const res = makeRes();
    await route(makeReq({ type: 'merge', approve: false }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(task.handleMergeApproval).not.toHaveBeenCalled();
    expect(task.handleMergeDenial).not.toHaveBeenCalled();
  });
});
