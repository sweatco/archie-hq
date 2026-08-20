/**
 * Tests for the operator trigger surface's handling of `pending` proposals.
 *
 * Two gaps this pins down. (1) `PATCH /api/triggers/:id` did a single load and
 * then wrote, so a user Approve landing mid-flight was undone — the write stamped
 * the file back to `pending` with the operator's prompt, leaving a trigger the
 * scheduler was firing while every listing called it "awaiting approval". The
 * agent path guards this; the operator path did not. (2) A trigger resolution that
 * changed nothing (approving something already enabled, denying a proposal since
 * approved) answered `{ok:true}`, telling the operator the opposite of what
 * happened, while docs/architecture/triggers.md promises the two surfaces resolve
 * equivalently.
 *
 * Drives the real Express handlers captured from the mounted router.
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
vi.mock('../../system/event-bus.js', () => ({ onEvent: vi.fn(), offEvent: vi.fn(), emitEvent: vi.fn() }));
vi.mock('../../system/workdir.js', () => ({ SESSIONS_DIR: '/tmp/sessions' }));
vi.mock('../../tasks/task.js', () => ({ Task: { get: vi.fn() }, activeTasks: new Map() }));
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
vi.mock('../../system/reminder-scheduler.js', () => ({ cancelReminder: vi.fn() }));

const { loadTrigger, saveTrigger, listTriggers, deleteTrigger, countActiveTriggers } = vi.hoisted(() => ({
  loadTrigger: vi.fn(),
  saveTrigger: vi.fn().mockResolvedValue(undefined),
  listTriggers: vi.fn().mockResolvedValue([]),
  deleteTrigger: vi.fn().mockResolvedValue(undefined),
  countActiveTriggers: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../system/trigger-store.js', () => ({
  loadTrigger, saveTrigger, listTriggers, deleteTrigger, countActiveTriggers,
}));

const { announceTriggerChange, indexTrigger, deindexTrigger } = vi.hoisted(() => ({
  announceTriggerChange: vi.fn().mockResolvedValue(undefined),
  indexTrigger: vi.fn(),
  deindexTrigger: vi.fn(),
}));
vi.mock('../../system/trigger-scheduler.js', async (importActual) => {
  const actual = await importActual<typeof import('../../system/trigger-scheduler.js')>();
  return { ...actual, announceTriggerChange, indexTrigger, deindexTrigger };
});

import type { Application, Request, Response } from 'express';
import { mountApiRoutes } from '../api/routes.js';
import { Task } from '../../tasks/task.js';
import type { Trigger } from '../../types/trigger.js';

type RouteHandler = (req: Request, res: Response) => Promise<void>;

function captureRoute(path: string, method: 'get' | 'post' | 'patch' | 'delete'): RouteHandler {
  const fakeApp = { use: vi.fn() };
  mountApiRoutes(fakeApp as unknown as Application);
  const router = fakeApp.use.mock.calls[0]![1] as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RouteHandler }> } }>;
  };
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer!.route!.stack[0]!.handle;
}

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

const TRIGGER_ID = 'trg-20260729-1056-pending';

function pending(over: Partial<Trigger> = {}): Trigger {
  return {
    id: TRIGGER_ID,
    status: 'pending',
    created_by: 'U1',
    created_at: '2026-07-29T10:56:00.000Z',
    proposed_in_task: 'task-1',
    binding: { type: 'channel', channel_id: 'C1', channel_name: 'growth-operations' },
    conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2026-07-30T08:00:00.000Z', cron: '0 9 * * *' }],
    action: { prompt: 'ORIGINAL' },
    ...over,
  } as Trigger;
}

beforeEach(() => {
  vi.clearAllMocks();
  saveTrigger.mockResolvedValue(undefined);
  announceTriggerChange.mockResolvedValue(undefined);
  countActiveTriggers.mockResolvedValue(0);
});

describe('PATCH /triggers/:id — pending proposals', () => {
  it('refuses a status change on a proposal — approval is the user\'s act', async () => {
    loadTrigger.mockResolvedValue(pending());
    const route = captureRoute('/triggers/:id', 'patch');
    const res = makeRes();

    await route({ params: { id: TRIGGER_ID }, body: { status: 'enabled' } } as unknown as Request, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(saveTrigger).not.toHaveBeenCalled();
  });

  it('abandons the edit when the user approves mid-flight, instead of reverting to pending', async () => {
    loadTrigger
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(pending({ status: 'enabled' }));
    const route = captureRoute('/triggers/:id', 'patch');
    const res = makeRes();

    await route({ params: { id: TRIGGER_ID }, body: { action_prompt: 'OPERATOR EDIT' } } as unknown as Request, res);

    expect(saveTrigger).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).toMatchObject({ ok: false, stale: true });
  });

  it('applies the edit to the re-read object and renews the GC clock', async () => {
    loadTrigger.mockResolvedValue(pending());
    const route = captureRoute('/triggers/:id', 'patch');
    const res = makeRes();

    await route({ params: { id: TRIGGER_ID }, body: { action_prompt: 'OPERATOR EDIT' } } as unknown as Request, res);

    const saved = saveTrigger.mock.calls[0][0] as Trigger;
    expect(saved.status).toBe('pending');
    expect(saved.action.prompt).toBe('OPERATOR EDIT');
    expect(saved.updated_at).toBeDefined();
    // Not running, so nothing is announced to the bound channel.
    expect(announceTriggerChange).not.toHaveBeenCalled();
  });

  it('still announces an edit to a live trigger', async () => {
    loadTrigger.mockResolvedValue(pending({ status: 'enabled' }));
    const route = captureRoute('/triggers/:id', 'patch');
    const res = makeRes();

    await route({ params: { id: TRIGGER_ID }, body: { action_prompt: 'edit' } } as unknown as Request, res);

    expect(saveTrigger).toHaveBeenCalledOnce();
    expect(announceTriggerChange).toHaveBeenCalledOnce();
  });
});

describe('POST /tasks/:id/approve — trigger resolutions report the truth', () => {
  it('answers 409 when a denial was refused because the trigger is already live', async () => {
    const task = { handleTriggerDenial: vi.fn().mockResolvedValue({ outcome: 'already_live', status: 'enabled' }) };
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    const route = captureRoute('/tasks/:id/approve', 'post');
    const res = makeRes();

    await route({ params: { id: 'task-1' }, body: { type: 'trigger', approve: false, ref: TRIGGER_ID } } as unknown as Request, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).toMatchObject({ ok: false, stale: true, outcome: 'already_live' });
  });

  it('answers 409 when an approval enabled nothing', async () => {
    const task = { handleTriggerApproval: vi.fn().mockResolvedValue(null) };
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    const route = captureRoute('/tasks/:id/approve', 'post');
    const res = makeRes();

    await route({ params: { id: 'task-1' }, body: { type: 'trigger', approve: true, ref: TRIGGER_ID } } as unknown as Request, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).toMatchObject({ ok: false, stale: true });
  });

  it('answers ok when a denial really withdrew the proposal', async () => {
    const task = { handleTriggerDenial: vi.fn().mockResolvedValue({ outcome: 'withdrawn' }) };
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    const route = captureRoute('/tasks/:id/approve', 'post');
    const res = makeRes();

    await route({ params: { id: 'task-1' }, body: { type: 'trigger', approve: false, ref: TRIGGER_ID } } as unknown as Request, res);

    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

describe('GET /triggers — operator visibility', () => {
  it('includes pending proposals, so an unapproved one is inspectable from here', async () => {
    listTriggers.mockResolvedValue([pending(), pending({ id: 'trg-live', status: 'enabled' })]);
    const route = captureRoute('/triggers', 'get');
    const res = makeRes();

    await route({ query: {} } as unknown as Request, res);

    const body = res.json.mock.calls[0][0] as { triggers: Array<{ id: string; status: string }>; total: number };
    expect(body.triggers.map((t) => t.status)).toContain('pending');
    expect(body.total).toBe(2);
  });
});
