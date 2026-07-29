/**
 * Handler-level tests for set_reminder's two modes: one-shot (`datetime`) and
 * recurring (`cron` + `tz`). The re-arm rule itself is covered in
 * system/__tests__/reminder-rearm.test.ts; this covers argument handling, the
 * once-per-hour floor, and what reaches scheduleReminder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Heavy deps tools.ts pulls in — mock to import-safe stubs (same as explore-tools.test.ts).
vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../connectors/github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  setupSharedClone: vi.fn().mockResolvedValue({ clone_path: '/wt', branch: 'feat/x', base_branch: 'main' }),
  cloneExists: vi.fn().mockResolvedValue(false),
  isWorktree: vi.fn().mockResolvedValue(false),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  getReposPath: vi.fn().mockReturnValue('/sessions/task-1/repos'),
}));
vi.mock('../../system/logger.js', () => ({
  logger: { agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(), system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
}));

// The scheduler is the collaborator under observation — stub it, keep the real
// cron helpers it delegates to (validateRecurringInterval / computeNextRun).
const { scheduleReminder, cancelReminder } = vi.hoisted(() => ({
  scheduleReminder: vi.fn(),
  cancelReminder: vi.fn(),
}));
vi.mock('../../system/reminder-scheduler.js', () => ({ scheduleReminder, cancelReminder }));

import { createSchedulingMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';

function makeAgent(): Agent {
  return {
    def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true },
    queue: {} as never,
    session: { active: false },
  } as unknown as Agent;
}
function makeTask(): Task {
  return { taskId: 'task-1', metadata: { channels: {} }, touch: vi.fn(), debouncedSave: vi.fn() } as unknown as Task;
}

function getHandler(name: string): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const server = createSchedulingMcpServer(makeAgent(), makeTask());
  const inst = server.instance as unknown as { _registeredTools?: Record<string, unknown>; _tools?: Iterable<[string, unknown]> };
  const raw = inst._registeredTools ?? Object.fromEntries(inst._tools ?? []);
  const entry = raw[name] as { callback?: unknown; handler?: unknown; cb?: unknown };
  const fn = (entry.callback ?? entry.handler ?? entry.cb) as (a: unknown, b: unknown) => Promise<{ content: { text: string }[] }>;
  return (args) => fn(args, {});
}

const text = (r: { content: { text: string }[] }) => r.content[0].text;

beforeEach(() => vi.clearAllMocks());

describe('set_reminder — recurring mode', () => {
  it('schedules a recurring reminder and passes the cron through to the scheduler', async () => {
    const out = text(await getHandler('set_reminder')({
      cron: '0 5,17 * * *',
      tz: 'Europe/London',
      reason: 'offer-code check',
    }));

    expect(scheduleReminder).toHaveBeenCalledOnce();
    const [, first, reason, recurrence] = scheduleReminder.mock.calls[0];
    expect(first).toBeInstanceOf(Date);
    expect(first.getTime()).toBeGreaterThan(Date.now());
    expect(reason).toBe('offer-code check');
    expect(recurrence).toEqual({ cron: '0 5,17 * * *', tz: 'Europe/London' });
    expect(out).toMatch(/re-arms automatically/i);
    expect(out).toMatch(/cancel_reminder/);
  });

  it('rejects a cron with no timezone — "9am" is ambiguous', async () => {
    const out = text(await getHandler('set_reminder')({ cron: '0 9 * * *', reason: 'x' }));

    expect(out).toMatch(/needs tz/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('enforces the same once-per-hour floor as triggers', async () => {
    const out = text(await getHandler('set_reminder')({ cron: '*/5 * * * *', tz: 'UTC', reason: 'x' }));

    expect(out).toMatch(/once per hour/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('rejects an invalid cron expression', async () => {
    const out = text(await getHandler('set_reminder')({ cron: 'not-a-cron', tz: 'UTC', reason: 'x' }));

    expect(out).toMatch(/invalid cron|could not compute/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('is not bound by the 30-day one-shot cap — a recurring schedule is open-ended', async () => {
    // Annual cadence: the first run may be far beyond 30 days, which must not be
    // rejected the way a one-shot datetime would be.
    const out = text(await getHandler('set_reminder')({ cron: '0 9 1 1 *', tz: 'UTC', reason: 'yearly' }));

    expect(out).not.toMatch(/within 30 days/i);
    expect(scheduleReminder).toHaveBeenCalledOnce();
  });
});

describe('set_reminder — one-shot mode still works', () => {
  it('schedules a future datetime with no recurrence', async () => {
    const when = new Date(Date.now() + 3_600_000).toISOString();

    const out = text(await getHandler('set_reminder')({ datetime: when, reason: 'check CI' }));

    expect(scheduleReminder).toHaveBeenCalledOnce();
    expect(scheduleReminder.mock.calls[0][3]).toBeUndefined(); // no recurrence
    expect(out).toContain(when);
  });

  it('still rejects a past datetime', async () => {
    const out = text(await getHandler('set_reminder')({
      datetime: new Date(Date.now() - 1000).toISOString(),
      reason: 'x',
    }));

    expect(out).toMatch(/must be in the future/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('still rejects a datetime beyond 30 days, and points at cron instead', async () => {
    const out = text(await getHandler('set_reminder')({
      datetime: new Date(Date.now() + 40 * 24 * 3_600_000).toISOString(),
      reason: 'x',
    }));

    expect(out).toMatch(/within 30 days/i);
    expect(out).toMatch(/cron/);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('still rejects an unparseable datetime', async () => {
    const out = text(await getHandler('set_reminder')({ datetime: 'tomorrow-ish', reason: 'x' }));

    expect(out).toMatch(/invalid datetime/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });
});

describe('set_reminder — mode selection', () => {
  it('refuses both modes at once rather than silently preferring one', async () => {
    const out = text(await getHandler('set_reminder')({
      datetime: new Date(Date.now() + 3_600_000).toISOString(),
      cron: '0 9 * * *',
      tz: 'UTC',
      reason: 'x',
    }));

    expect(out).toMatch(/not both/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('refuses neither mode', async () => {
    const out = text(await getHandler('set_reminder')({ reason: 'x' }));

    expect(out).toMatch(/datetime.*or cron|cron \+ tz/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });
});
