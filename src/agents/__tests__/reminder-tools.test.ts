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
const { scheduleReminder, cancelReminder, announceRecurrence } = vi.hoisted(() => ({
  scheduleReminder: vi.fn(),
  cancelReminder: vi.fn(),
  announceRecurrence: vi.fn(),
}));
vi.mock('../../system/reminder-scheduler.js', () => ({ scheduleReminder, cancelReminder, announceRecurrence }));

/** Every recurring reminder needs an end within 30 days. */
const UNTIL = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();

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
      until: UNTIL,
      reason: 'offer-code check',
    }));

    expect(scheduleReminder).toHaveBeenCalledOnce();
    const [, first, reason, recurrence] = scheduleReminder.mock.calls[0];
    expect(first).toBeInstanceOf(Date);
    expect(first.getTime()).toBeGreaterThan(Date.now());
    expect(reason).toBe('offer-code check');
    expect(recurrence).toEqual({ cron: '0 5,17 * * *', tz: 'Europe/London', until: UNTIL });
    expect(out).toMatch(/re-arms automatically/i);
    expect(out).toMatch(/cancel_reminder/);
  });

  it('rejects a cron with no timezone — "9am" is ambiguous', async () => {
    const out = text(await getHandler('set_reminder')({ cron: '0 9 * * *', reason: 'x' }));

    expect(out).toMatch(/needs tz/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('enforces the same once-per-hour floor as triggers', async () => {
    const out = text(await getHandler('set_reminder')({ cron: '*/5 * * * *', tz: 'UTC', until: UNTIL, reason: 'x' }));

    expect(out).toMatch(/once per hour/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('rejects an invalid cron expression', async () => {
    const out = text(await getHandler('set_reminder')({ cron: 'not-a-cron', tz: 'UTC', until: UNTIL, reason: 'x' }));

    expect(out).toMatch(/invalid cron|could not compute/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('refuses a recurring reminder with no until — every recurrence must end', async () => {
    const out = text(await getHandler('set_reminder')({ cron: '0 9 * * *', tz: 'UTC', reason: 'x' }));

    expect(out).toMatch(/needs until/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
    expect(announceRecurrence).not.toHaveBeenCalled();
  });

  it('refuses an until more than 30 days ahead', async () => {
    const out = text(await getHandler('set_reminder')({
      cron: '0 9 * * *', tz: 'UTC', until: new Date(Date.now() + 31 * 24 * 3_600_000).toISOString(), reason: 'x',
    }));

    expect(out).toMatch(/within 30 days/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('refuses a recurring reminder on a task with no thread yet, where its notices could not land', async () => {
    const t = makeTask();
    (t as unknown as { metadata: Record<string, unknown> }).metadata.home_channel = { channel_id: 'C1', channel_name: 'ops' };
    const server = createSchedulingMcpServer(makeAgent(), t);
    const inst = server.instance as unknown as { _registeredTools?: Record<string, unknown>; _tools?: Iterable<[string, unknown]> };
    const raw = inst._registeredTools ?? Object.fromEntries(inst._tools ?? []);
    const entry = raw['set_reminder'] as { callback?: unknown; handler?: unknown; cb?: unknown };
    const fn = (entry.callback ?? entry.handler ?? entry.cb) as (a: unknown, b: unknown) => Promise<{ content: { text: string }[] }>;

    const out = text(await fn({ cron: '0 9 * * *', tz: 'UTC', until: UNTIL, reason: 'x' }, {}));

    expect(out).toMatch(/post to the user first/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('posts one line in the thread when a recurring reminder is set', async () => {
    await getHandler('set_reminder')({ cron: '0 9 * * *', tz: 'UTC', until: UNTIL, reason: 'x' });

    expect(announceRecurrence).toHaveBeenCalledOnce();
    expect(announceRecurrence.mock.calls[0][1]).toBe('set');
    expect(announceRecurrence.mock.calls[0][2]).toMatchObject({ cron: '0 9 * * *', tz: 'UTC', until: UNTIL });
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

  it('still rejects a datetime beyond 30 days, and points at a trigger instead', async () => {
    const out = text(await getHandler('set_reminder')({
      datetime: new Date(Date.now() + 40 * 24 * 3_600_000).toISOString(),
      reason: 'x',
    }));

    expect(out).toMatch(/within 30 days/i);
    expect(out).toMatch(/trigger/);
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

describe('set_reminder — bounding a recurrence with until', () => {
  it('passes until through to the scheduler', async () => {
    const until = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();

    const out = text(await getHandler('set_reminder')({
      cron: '0 9 * * *', tz: 'UTC', until, reason: 'restock watch',
    }));

    expect(scheduleReminder.mock.calls[0][3]).toEqual({ cron: '0 9 * * *', tz: 'UTC', until });
    expect(out).toContain(until);
    expect(out).toMatch(/stops after/i);
  });

  it('rejects until on a one-shot — it already happens once', async () => {
    const out = text(await getHandler('set_reminder')({
      datetime: new Date(Date.now() + 3_600_000).toISOString(),
      until: new Date(Date.now() + 7_200_000).toISOString(),
      reason: 'x',
    }));

    expect(out).toMatch(/only applies to a recurring reminder/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('rejects an until in the past', async () => {
    const out = text(await getHandler('set_reminder')({
      cron: '0 9 * * *', tz: 'UTC', until: new Date(Date.now() - 1000).toISOString(), reason: 'x',
    }));

    expect(out).toMatch(/must be in the future/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('rejects an unparseable until', async () => {
    const out = text(await getHandler('set_reminder')({
      cron: '0 9 * * *', tz: 'UTC', until: 'next-ish week', reason: 'x',
    }));

    expect(out).toMatch(/could not read until/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('rejects a window that closes before the first wake', async () => {
    // Yearly cron with a one-hour window: it would never fire at all.
    const out = text(await getHandler('set_reminder')({
      cron: '0 9 1 1 *', tz: 'UTC', until: new Date(Date.now() + 3_600_000).toISOString(), reason: 'x',
    }));

    expect(out).toMatch(/never fires before until/i);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });
});

describe('set_reminder — error wording points at the real problem', () => {
  // Match the APPENDED NOTE's own wording ("once-per-hour", hyphenated), not the
  // validator's floor error ("at most once per hour", spaced). An earlier version
  // of this test asserted the spaced form, which the note never contains — so it
  // passed even with the note bolted onto every error, proving nothing.
  const FLOOR_NOTE = /same once-per-hour floor as triggers/i;

  it('does NOT append the floor note to a cron that simply will not parse', async () => {
    const out = text(await getHandler('set_reminder')({ cron: 'not-a-cron', tz: 'UTC', until: UNTIL, reason: 'x' }));

    expect(out).toMatch(/invalid cron/i);
    expect(out).not.toMatch(FLOOR_NOTE);
  });

  it('appends the floor note when the floor is what was violated', async () => {
    const out = text(await getHandler('set_reminder')({ cron: '*/5 * * * *', tz: 'UTC', until: UNTIL, reason: 'x' }));

    expect(out).toMatch(/at most once per hour/i); // the validator's own error
    expect(out).toMatch(FLOOR_NOTE);               // plus our note
  });
});

describe('set_reminder — replacing an armed recurrence is called out', () => {
  it('warns that a one-shot just cancelled the repeating schedule', async () => {
    // A fresh subprocess spawns per wake, so without this the agent silently
    // destroys a schedule it could not see.
    const t = makeTask();
    (t as unknown as { metadata: { reminder: unknown } }).metadata.reminder = {
      trigger_at: new Date(Date.now() + 3_600_000).toISOString(), reason: 'old', cron: '0 9 * * *', tz: 'UTC',
    };
    const server = createSchedulingMcpServer(makeAgent(), t);
    const inst = server.instance as unknown as { _registeredTools?: Record<string, unknown>; _tools?: Iterable<[string, unknown]> };
    const raw = inst._registeredTools ?? Object.fromEntries(inst._tools ?? []);
    const entry = raw['set_reminder'] as { callback?: unknown; handler?: unknown; cb?: unknown };
    const fn = (entry.callback ?? entry.handler ?? entry.cb) as (a: unknown, b: unknown) => Promise<{ content: { text: string }[] }>;

    const out = text(await fn({ datetime: new Date(Date.now() + 60_000).toISOString(), reason: 'one off' }, {}));

    expect(out).toMatch(/replaced the recurring schedule/i);
    expect(out).toContain('0 9 * * *');
    expect(announceRecurrence).toHaveBeenCalledWith(t, 'cancelled', expect.objectContaining({ cron: '0 9 * * *' }));
  });
});

describe('set_reminder — the replacement note never contradicts the new schedule', () => {
  function handlerForTaskWithCron() {
    const t = makeTask();
    (t as unknown as { metadata: { reminder: unknown } }).metadata.reminder = {
      trigger_at: new Date(Date.now() + 3_600_000).toISOString(), reason: 'old', cron: '0 9 * * *', tz: 'UTC',
    };
    const server = createSchedulingMcpServer(makeAgent(), t);
    const inst = server.instance as unknown as { _registeredTools?: Record<string, unknown>; _tools?: Iterable<[string, unknown]> };
    const raw = inst._registeredTools ?? Object.fromEntries(inst._tools ?? []);
    const entry = raw['set_reminder'] as { callback?: unknown; handler?: unknown; cb?: unknown };
    const fn = (entry.callback ?? entry.handler ?? entry.cb) as (a: unknown, b: unknown) => Promise<{ content: { text: string }[] }>;
    return (args: Record<string, unknown>) => fn(args, {});
  }

  it('a NEW cron replacing an armed cron does not claim the schedule stopped repeating', async () => {
    // One shared sentence used to be appended to both replies, so this path read
    // "It re-arms automatically …" immediately followed by "… it will no longer repeat."
    const out = text(await handlerForTaskWithCron()({ cron: '0 6 * * *', tz: 'UTC', until: UNTIL, reason: 'new cadence' }));

    expect(out).toMatch(/re-arms automatically/i);
    expect(out).not.toMatch(/no longer repeat/i);
    expect(out).toMatch(/replaced the previous recurring schedule/i);
    expect(out).toContain('0 9 * * *'); // names what it superseded
    // One line, not a stop racing a start: the new set line already describes what is in effect.
    expect(announceRecurrence).toHaveBeenCalledTimes(1);
    expect(announceRecurrence.mock.calls[0][1]).toBe('set');
  });

  it('a one-shot replacing an armed cron still says the repeat has ended', async () => {
    const out = text(await handlerForTaskWithCron()({
      datetime: new Date(Date.now() + 60_000).toISOString(), reason: 'one off',
    }));

    expect(out).toMatch(/no longer repeat/i);
    expect(out).not.toMatch(/re-arms automatically/i);
  });
});
