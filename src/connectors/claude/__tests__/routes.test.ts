import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'fs/promises';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { createRequire } from 'module';
import type { Server } from 'http';

const require = createRequire(import.meta.url);

vi.mock('../../../system/workdir.js', async () => {
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = join(tmpdir(), `archie-claude-routes-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return { SESSIONS_DIR: dir, WORKDIR: tmpdir(), TRIGGERS_DIR: join(dir, 'triggers') };
});

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));

vi.mock('../../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

const CREATED_AT = '2026-10-16T12:00:00.000Z';

vi.mock('../connections.js', () => {
  const connection = { user_id: 'U1', channel_id: 'D1', channel_name: 'DM with Dana', created_at: '2026-10-16T12:00:00.000Z' };
  return {
    findConnection: vi.fn(async (credential: string) => (credential === 'good' ? connection : null)),
    redeemCode: vi.fn(async (code: string) => (code === 'ABCD-EFGH' ? { credential: 'good', connection } : null)),
  };
});

vi.mock('../../slack/client.js', () => ({
  getUserInfo: vi.fn().mockResolvedValue({ realName: 'Dana', name: 'dana', email: 'dana@example.com' }),
  isExternalUser: vi.fn(() => false),
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

vi.mock('../../api/routes.js', () => ({
  resolveApproval: vi.fn().mockResolvedValue({ status: 200, body: { ok: true } }),
}));

const { taskCreateMock, taskGetMock } = vi.hoisted(() => ({ taskCreateMock: vi.fn(), taskGetMock: vi.fn() }));
vi.mock('../../../tasks/task.js', () => ({
  Task: { create: taskCreateMock, get: taskGetMock },
  activeTasks: new Map(),
}));

vi.mock('../../../tasks/persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../tasks/persistence.js')>();
  return { ...actual, appendCliMessage: vi.fn().mockResolvedValue('LINE') };
});

import { mountClaudeRoutes } from '../routes.js';
import { SESSIONS_DIR } from '../../../system/workdir.js';
import { appendCliMessage } from '../../../tasks/persistence.js';
import { resolveApproval } from '../../api/routes.js';
import { getUserInfo, isExternalUser } from '../../slack/client.js';

const express = require('express');

const OWN = 'task-20261016-1200-own001';
const FOREIGN = 'task-20261016-1200-foreign1';
const UNKNOWN = 'task-20261016-1200-nothere';

function fakeTask(taskId: string) {
  return {
    taskId,
    metadata: { memory_authors: {} } as Record<string, unknown>,
    setMemoryDestination: vi.fn(),
    linkCliChannel: vi.fn(),
    save: vi.fn(),
    sendMessage: vi.fn(),
  };
}

async function writeTask(taskId: string, createdBy: string, status: string): Promise<string> {
  const dir = join(SESSIONS_DIR, taskId, 'shared');
  await mkdir(dir, { recursive: true });
  const metadata = {
    task_id: taskId,
    channels: {},
    default_channel: null,
    agent_sessions: {},
    status,
    created_by: createdBy,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
  return dir;
}

async function writeEvents(taskId: string, events: Array<{ type: string; data: Record<string, unknown> }>): Promise<void> {
  const lines = events.map((e) => JSON.stringify({ type: e.type, taskId, timestamp: CREATED_AT, data: e.data }));
  await writeFile(join(SESSIONS_DIR, taskId, 'shared', 'events.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

async function writeOwnFixture(status = 'in_progress'): Promise<void> {
  const dir = await writeTask(OWN, 'U1', status);
  const mdPath = join(dir, 'notes.md');
  const binPath = join(dir, 'blob.bin');
  const bigPath = join(dir, 'big.txt');
  const linkPath = join(dir, 'link.md');
  await writeFile(mdPath, '# Notes\nhello', 'utf-8');
  await writeFile(binPath, Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(bigPath, 'x'.repeat(100_001), 'utf-8');
  const outside = join(SESSIONS_DIR, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'SERVER SECRET', 'utf-8');
  await symlink(join(outside, 'secret.txt'), linkPath);
  await symlink(outside, join(dir, 'linkdir'));
  execFileSync('mkfifo', [join(dir, 'pipe')]);
  await writeEvents(OWN, [
    { type: 'message', data: { from: 'cli', to: 'pm-agent', message: 'hi' } },
    { type: 'message', data: { from: 'pm-agent', to: 'user', message: 'first' } },
    { type: 'approval:requested', data: { approvalType: 'trigger', text: 'Set up this automation?', ref: 'trg-1' } },
    { type: 'message', data: { from: 'pm-agent', to: 'user', message: 'second', files: [mdPath, binPath, join(dir, 'missing.md'), bigPath, linkPath, join(dir, 'linkdir', 'secret.txt'), join(dir, 'pipe')] } },
    { type: 'approval:requested', data: { approvalType: 'edit_mode', text: 'Turn on edit mode?' } },
    { type: 'approval:resolved', data: { type: 'edit_mode', approve: true, approval_id: 4, approver_name: 'Dana' } },
  ]);
}

interface CheckBody {
  status: string;
  replies: Array<{ text: string; files: unknown[] }>;
  approvals: unknown[];
  cursor: number;
}

let server: Server;
let baseUrl: string;

function call(path: string, init: { method?: string; body?: unknown; auth?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = init.auth === undefined ? 'Bearer good' : init.auth;
  if (auth !== null) {
    headers.Authorization = auth;
  }
  return fetch(`${baseUrl}/mcp${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

describe('/mcp routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    taskCreateMock.mockImplementation(async () => fakeTask('task-20261016-1200-new'));
    taskGetMock.mockImplementation(async (id: string) => fakeTask(id));
    await rm(SESSIONS_DIR, { recursive: true, force: true });
    await mkdir(SESSIONS_DIR, { recursive: true });
    await writeOwnFixture();
    await writeTask(FOREIGN, 'U2', 'in_progress');
    await writeEvents(FOREIGN, [
      { type: 'approval:requested', data: { approvalType: 'trigger', text: 'Not yours', ref: 'trg-2' } },
    ]);

    const app = express();
    mountClaudeRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('auth', () => {
    it('rejects a request with no Authorization header', async () => {
      const res = await call(`/sessions/${OWN}`, { auth: null });
      expect(res.status).toBe(401);
    });

    it('rejects an unknown credential', async () => {
      const res = await call(`/sessions/${OWN}`, { auth: 'Bearer bad' });
      expect(res.status).toBe(401);
    });

    it('rejects a credential whose Slack account was deactivated', async () => {
      vi.mocked(getUserInfo).mockResolvedValueOnce({ realName: 'Dana', name: 'dana', deleted: true });
      const res = await call(`/sessions/${OWN}`);
      expect(res.status).toBe(401);
    });

    it('rejects a credential whose Slack account became external', async () => {
      vi.mocked(isExternalUser).mockReturnValueOnce(true);
      const res = await call(`/sessions/${OWN}`);
      expect(res.status).toBe(401);
    });
  });

  describe('approval folding', () => {
    async function viewOf(events: Array<{ type: string; data: Record<string, unknown> }>, aid: number) {
      await writeEvents(OWN, events);
      return (await call(`/sessions/${OWN}/approvals/${aid}`)).json();
    }

    it('settles only the request a decision names, not another proposal of the same type', async () => {
      const events = [
        { type: 'approval:requested', data: { approvalType: 'trigger', text: 'One', ref: 'trg-1' } },
        { type: 'approval:requested', data: { approvalType: 'trigger', text: 'Two', ref: 'trg-2' } },
        { type: 'approval:resolved', data: { type: 'trigger', approve: true, approval_id: 0, approver_name: 'Dana' } },
      ];
      expect(await viewOf(events, 0)).toMatchObject({ state: 'approved', decided_by: 'Dana' });
      expect(await viewOf(events, 1)).toMatchObject({ state: 'pending' });
    });

    it('settles a re-asked request for the same item together with the one decided', async () => {
      const events = [
        { type: 'approval:requested', data: { approvalType: 'edit_mode', text: 'First ask' } },
        { type: 'approval:requested', data: { approvalType: 'edit_mode', text: 'Second ask' } },
        { type: 'approval:resolved', data: { type: 'edit_mode', approve: true, approval_id: 0, approver_name: 'Dana' } },
      ];
      expect(await viewOf(events, 1)).toMatchObject({ state: 'approved', decided_by: 'Dana' });
    });

    it('marks a refused decision as expired with no decider', async () => {
      const events = [
        { type: 'approval:requested', data: { approvalType: 'trigger', text: 'One', ref: 'trg-1' } },
        { type: 'approval:resolved', data: { type: 'trigger', approve: true, approval_id: 0, approver_name: 'Dana', stale: true } },
      ];
      const view = await viewOf(events, 0);
      expect(view).toMatchObject({ state: 'expired' });
      expect(view).not.toHaveProperty('decided_by');
    });

    it('leaves an operator resolution without an id unplaced when several requests of that type are pending', async () => {
      const events = [
        { type: 'approval:requested', data: { approvalType: 'trigger', text: 'One', ref: 'trg-1' } },
        { type: 'approval:requested', data: { approvalType: 'trigger', text: 'Two', ref: 'trg-2' } },
        { type: 'approval:resolved', data: { type: 'trigger', approve: true } },
      ];
      expect(await viewOf(events, 0)).toMatchObject({ state: 'pending' });
      expect(await viewOf(events, 1)).toMatchObject({ state: 'pending' });
    });

    it('applies an operator resolution without an id to the one pending request of that type', async () => {
      const events = [
        { type: 'approval:requested', data: { approvalType: 'edit_mode', text: 'Ask' } },
        { type: 'approval:resolved', data: { type: 'edit_mode', approve: false } },
      ];
      expect(await viewOf(events, 0)).toMatchObject({ state: 'denied' });
    });
  });

  describe('POST /connect', () => {
    it('redeems a valid code without an Authorization header', async () => {
      const res = await call('/connect', { method: 'POST', body: { code: 'ABCD-EFGH' }, auth: null });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ credential: 'good' });
    });

    it('rejects a wrong code', async () => {
      const res = await call('/connect', { method: 'POST', body: { code: 'ZZZZ-ZZZZ' }, auth: null });
      expect(res.status).toBe(401);
    });

    it('requires a code', async () => {
      const res = await call('/connect', { method: 'POST', body: {}, auth: null });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /sessions', () => {
    it('starts a new task owned by the connected person', async () => {
      const res = await call('/sessions', { method: 'POST', body: { message: 'hi' } });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ session_id: 'task-20261016-1200-new' });

      const task = await taskCreateMock.mock.results[0].value;
      expect(task.metadata.created_by).toBe('U1');
      expect(task.metadata.home_channel).toEqual({ channel_id: 'D1', channel_name: 'DM with Dana' });
      expect((task.metadata.memory_authors as Record<string, string>).U1).toBe('Dana');
      expect(task.setMemoryDestination).toHaveBeenCalledWith('D1');
      expect(task.linkCliChannel).toHaveBeenCalled();
      expect(task.save).toHaveBeenCalledWith(true);
      expect(appendCliMessage).toHaveBeenCalledWith('task-20261016-1200-new', 'hi', { id: 'U1', name: 'Dana' });
      expect(task.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('continues an own session', async () => {
      const res = await call('/sessions', { method: 'POST', body: { message: 'more', session_id: OWN } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ session_id: OWN });
      expect(taskGetMock).toHaveBeenCalledWith(OWN);
      const task = await taskGetMock.mock.results[0].value;
      expect(task.sendMessage).toHaveBeenCalledTimes(1);
      expect(task.save).toHaveBeenCalledWith(true);
      expect(appendCliMessage).toHaveBeenCalledWith(OWN, 'more', { id: 'U1', name: 'Dana' });
    });

    it.each([FOREIGN, UNKNOWN])('refuses session %s that is not the caller’s', async (id) => {
      const res = await call('/sessions', { method: 'POST', body: { message: 'more', session_id: id } });
      expect(res.status).toBe(404);
      expect(appendCliMessage).not.toHaveBeenCalled();
      expect(taskGetMock).not.toHaveBeenCalled();
    });
  });

  describe('GET /sessions/:id', () => {
    it('returns replies, pending approvals and a cursor', async () => {
      const res = await call(`/sessions/${OWN}?after=0`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as CheckBody;
      expect(body.status).toBe('working');
      expect(body.cursor).toBe(6);
      expect(body.replies).toEqual([
        { text: 'first', files: [] },
        {
          text: 'second',
          files: [
            { name: 'notes.md', text: '# Notes\nhello' },
            { name: 'blob.bin', note: 'blob.bin is not a text file, so it is not shown here.' },
            { name: 'missing.md', note: 'missing.md could not be read.' },
            { name: 'big.txt', note: 'big.txt (100001 bytes) is too large to show here.' },
            { name: 'link.md', note: 'link.md could not be read.' },
            { name: 'secret.txt', note: 'secret.txt is outside this session, so it is not shown here.' },
            { name: 'pipe', note: 'pipe is not a text file, so it is not shown here.' },
          ],
        },
      ]);
      expect(body.approvals).toEqual([
        { approval_id: 2, type: 'trigger', text: 'Set up this automation?', state: 'pending' },
      ]);
    });

    it('returns only replies after the cursor', async () => {
      const res = await call(`/sessions/${OWN}?after=3`);
      const body = (await res.json()) as CheckBody;
      expect(body.replies.map((r) => r.text)).toEqual(['second']);
    });

    it.each([
      ['completed', 'done'],
      ['stopped', 'paused'],
      ['in_progress', 'working'],
    ])('maps status %s to %s', async (status, expected) => {
      await writeTask(OWN, 'U1', status);
      const res = await call(`/sessions/${OWN}`);
      expect(((await res.json()) as CheckBody).status).toBe(expected);
    });

    it('refuses a foreign session', async () => {
      const res = await call(`/sessions/${FOREIGN}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /sessions/:id/approvals/:aid', () => {
    it('shows a pending approval', async () => {
      const res = await call(`/sessions/${OWN}/approvals/2`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ approval_id: 2, type: 'trigger', text: 'Set up this automation?', state: 'pending' });
    });

    it('shows a decided approval with who decided it', async () => {
      const res = await call(`/sessions/${OWN}/approvals/4`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ approval_id: 4, state: 'approved', decided_by: 'Dana', decided_at: CREATED_AT });
    });

    it.each(['1', 'x'])('returns 404 for approval %s', async (aid) => {
      const res = await call(`/sessions/${OWN}/approvals/${aid}`);
      expect(res.status).toBe(404);
    });

    it('refuses a foreign task', async () => {
      const res = await call(`/sessions/${FOREIGN}/approvals/0`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /sessions/:id/approvals/:aid', () => {
    it('decides a pending approval as the connected person', async () => {
      const res = await call(`/sessions/${OWN}/approvals/2`, { method: 'POST', body: { approve: true } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ approval_id: 2, state: 'approved', decided_by: 'Dana', already_decided: false });
      expect(resolveApproval).toHaveBeenCalledWith(
        OWN,
        { type: 'trigger', approve: true, github: undefined, pr_number: undefined, ref: 'trg-1' },
        { approval_id: 2, approver: { id: 'U1', name: 'Dana', email: 'dana@example.com' } },
      );
    });

    it('reports an approval that is already decided', async () => {
      const res = await call(`/sessions/${OWN}/approvals/4`, { method: 'POST', body: { approve: true } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ approval_id: 4, state: 'approved', already_decided: true });
      expect(resolveApproval).not.toHaveBeenCalled();
    });

    it('passes a refusal from resolveApproval through', async () => {
      vi.mocked(resolveApproval).mockResolvedValueOnce({ status: 409, body: { ok: false, stale: true, error: 'x' } });
      const res = await call(`/sessions/${OWN}/approvals/2`, { method: 'POST', body: { approve: true } });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, stale: true, error: 'x' });
    });

    it('requires approve to be a boolean', async () => {
      const res = await call(`/sessions/${OWN}/approvals/2`, { method: 'POST', body: { approve: 'yes' } });
      expect(res.status).toBe(400);
    });

    it('refuses a foreign task', async () => {
      const res = await call(`/sessions/${FOREIGN}/approvals/0`, { method: 'POST', body: { approve: true } });
      expect(res.status).toBe(404);
      expect(resolveApproval).not.toHaveBeenCalled();
    });
  });
});
