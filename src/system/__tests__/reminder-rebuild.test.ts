import { afterAll, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const paths = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'archie-reminder-rebuild-'));
  const marker = join(root, 'shell-executed');
  return { root, marker, sessions: join(root, 'sessions $(touch ' + marker + ')') };
});

vi.mock('../workdir.js', () => ({ SESSIONS_DIR: paths.sessions, WORKDIR: paths.root }));
vi.mock('../logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../event-bus.js', () => ({ emitEvent: vi.fn(), onEvent: vi.fn() }));
vi.mock('../trigger-scheduler.js', () => ({
  computeNextRun: vi.fn(),
  describeSchedule: vi.fn(),
}));
vi.mock('../../tasks/task.js', () => ({ Task: { get: vi.fn() }, activeTasks: new Map() }));
vi.mock('../../agents/prompts.js', () => ({ AGENT_PROMPTS: {} }));
vi.mock('../../connectors/slack/client.js', () => ({
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

import { getReminder, initReminderScheduler } from '../reminder-scheduler.js';

afterAll(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await rm(paths.root, { recursive: true, force: true });
});

it('rebuilds reminders from a path containing shell syntax without executing it', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const shared = join(paths.sessions, 'task-20261110-0215-abc123', 'shared');
  await mkdir(shared, { recursive: true });
  await writeFile(
    join(shared, 'metadata.json'),
    JSON.stringify({
      task_id: 'task-20261110-0215-abc123',
      reminder: { trigger_at: '2100-01-01T00:00:00Z', reason: 'restart' },
    }),
  );
  await initReminderScheduler();
  expect(existsSync(paths.marker)).toBe(false);
  expect(getReminder('task-20261110-0215-abc123')?.reason).toBe('restart');
});
