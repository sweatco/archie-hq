import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let tempRoot: string;

vi.mock('../paths.js', () => ({
  getPublicMemoryDir: () => join(tempRoot, 'public'),
  getTaskChannelDir: (visibility: string, channelId: string) => join(tempRoot, visibility, channelId),
  getTaskOverviewPath: (visibility: string, channelId: string) => join(tempRoot, visibility, channelId, 'rolling-summary.md'),
  getTaskSummaryPath: (visibility: string, channelId: string, taskId: string) => join(tempRoot, visibility, channelId, `${taskId}.md`),
  isAllowedTaskId: (id: string) => /^[A-Za-z0-9._-]+$/.test(id),
  isSlackConversationId: (id: string) => /^(C|D|G)[A-Z0-9]+$/.test(id),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

import {
  readPublicTaskSummaries,
  readTaskSummariesFromChannel,
  writeTaskSummary,
} from '../task-summaries.js';

function taskMarkdown(taskId: string, channelId: string, extractionAt: string, summary = `Summary for ${taskId}`): string {
  return [
    '---',
    `task_id: ${taskId}`,
    `channel_id: ${channelId}`,
    'status: completed',
    'created_at: "2026-09-15T10:00:00.000Z"',
    `extraction_at: "${extractionAt}"`,
    '---',
    '',
    '# Summary',
    '',
    summary,
    '',
  ].join('\n');
}

describe('canonical task summaries', () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'archie-task-summaries-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it.each([
    ['public', 'C07PUBLIC1'],
    ['private', 'G07PRIVATE1'],
    ['private', 'D07PERSON01'],
  ] as const)('writes common-format %s task files under the conversation ID', async (visibility, channelId) => {
    await writeTaskSummary(visibility, channelId, 'task-1', taskMarkdown('task-1', channelId, '2026-09-15T10:05:00.000Z'));

    const stored = await readFile(join(tempRoot, visibility, channelId, 'task-1.md'), 'utf-8');
    expect(stored).toContain(`channel_id: ${channelId}`);
    expect(stored).toContain('created_at: "2026-09-15T10:00:00.000Z"');
    expect(stored).toContain('extraction_at: "2026-09-15T10:05:00.000Z"');
    expect(await readFile(join(tempRoot, visibility, channelId, 'rolling-summary.md'), 'utf-8'))
      .toContain('[task-1](./task-1.md)');
  });

  it('keeps all 51 task files while the overview lists only the newest 50', async () => {
    const channelId = 'C07PUBLIC1';
    const channelDir = join(tempRoot, 'public', channelId);
    await mkdir(channelDir, { recursive: true });
    for (let index = 0; index < 50; index++) {
      const taskId = `task-${String(index).padStart(2, '0')}`;
      const extractionAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      await writeFile(join(channelDir, `${taskId}.md`), taskMarkdown(taskId, channelId, extractionAt));
    }
    await writeTaskSummary('public', channelId, 'task-50', taskMarkdown('task-50', channelId, new Date(Date.UTC(2026, 0, 1, 0, 50)).toISOString()));

    const overview = await readFile(join(tempRoot, 'public', channelId, 'rolling-summary.md'), 'utf-8');
    expect(overview.split('\n').filter((line) => line.startsWith('| 2026-'))).toHaveLength(50);
    expect(overview).not.toContain('[task-00]');
    expect((await readPublicTaskSummaries('task-00'))[0]?.taskId).toBe('task-00');
  });

  it('leaves the canonical file readable when overview replacement fails and replay repairs it once', async () => {
    const channelId = 'C07PUBLIC1';
    const channelDir = join(tempRoot, 'public', channelId);
    await mkdir(join(channelDir, 'rolling-summary.md'), { recursive: true });
    const markdown = taskMarkdown('task-replay', channelId, '2026-09-15T10:05:00.000Z');

    await expect(writeTaskSummary('public', channelId, 'task-replay', markdown)).rejects.toBeDefined();
    expect(await readFile(join(channelDir, 'task-replay.md'), 'utf-8')).toBe(markdown);

    await rm(join(channelDir, 'rolling-summary.md'), { recursive: true });
    await writeTaskSummary('public', channelId, 'task-replay', markdown);
    const overview = await readFile(join(channelDir, 'rolling-summary.md'), 'utf-8');
    expect(overview.match(/\[task-replay\]/g)).toHaveLength(1);
  });

  it('normalizes and bounds overview excerpts while escaping table delimiters', async () => {
    const summary = `First | line\n\n${'x'.repeat(250)}`;
    await writeTaskSummary('public', 'C07PUBLIC1', 'task-1', taskMarkdown('task-1', 'C07PUBLIC1', '2026-09-15T10:05:00.000Z', summary));

    const overview = await readFile(join(tempRoot, 'public', 'C07PUBLIC1', 'rolling-summary.md'), 'utf-8');
    const row = overview.split('\n').find((line) => line.includes('[task-1]'))!;
    expect(row).toContain('First \\| line');
    const excerpt = row.match(/\.md\) \| (.*) \|$/)![1]!;
    expect(excerpt.replace(/\\\|/g, '|')).toHaveLength(200);
  });

  it('skips invalid directories, symlinked files, temporary files, and malformed records', async () => {
    const channelDir = join(tempRoot, 'public', 'C07PUBLIC1');
    await mkdir(channelDir, { recursive: true });
    const valid = taskMarkdown('task-valid', 'C07PUBLIC1', '2026-09-15T10:05:00.000Z');
    await writeFile(join(channelDir, 'task-valid.md'), valid);
    await writeFile(join(channelDir, 'task-temp.md.1.tmp'), valid);
    await writeFile(join(channelDir, 'task-bad.md'), taskMarkdown('wrong-id', 'C07PUBLIC1', '2026-09-15T10:05:00.000Z'));
    await symlink(join(channelDir, 'task-valid.md'), join(channelDir, 'task-link.md'));
    await mkdir(join(tempRoot, 'public', 'users'), { recursive: true });
    await writeFile(join(tempRoot, 'public', 'users', 'task-profile.md'), valid);

    expect((await readPublicTaskSummaries()).map((record) => record.taskId)).toEqual(['task-valid']);
  });

  it('rejects language-tagged frontmatter without executing its engine', async () => {
    const channelDir = join(tempRoot, 'public', 'C07PUBLIC1');
    await mkdir(channelDir, { recursive: true });
    const sentinel = '__archieTaskSummaryMatterSentinel';
    delete (globalThis as Record<string, unknown>)[sentinel];
    await writeFile(join(channelDir, 'task-language.md'), [
      '---javascript',
      `globalThis.${sentinel} = true; ({ task_id: 'task-language', channel_id: 'C07PUBLIC1' })`,
      '---',
      '',
      '# Summary',
      '',
      'Must never parse.',
    ].join('\n'));

    await expect(readPublicTaskSummaries('task-language')).resolves.toEqual([]);
    expect((globalThis as Record<string, unknown>)[sentinel]).toBeUndefined();
  });

  it('does not follow an exact private channel directory symlink', async () => {
    const target = join(tempRoot, 'private-target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'task-secret.md'), taskMarkdown('task-secret', 'D07PERSON01', '2026-09-15T10:05:00.000Z'));
    await mkdir(join(tempRoot, 'private'), { recursive: true });
    await symlink(target, join(tempRoot, 'private', 'D07PERSON01'));

    await expect(readTaskSummariesFromChannel('private', 'D07PERSON01', 'task-secret')).resolves.toEqual([]);
  });

  it('does not write a private task through a channel symlink into public memory', async () => {
    const publicChannel = join(tempRoot, 'public', 'C07PUBLIC1');
    await mkdir(publicChannel, { recursive: true });
    await mkdir(join(tempRoot, 'private'), { recursive: true });
    await symlink(publicChannel, join(tempRoot, 'private', 'C07PUBLIC1'));
    const markdown = taskMarkdown('task-secret', 'C07PUBLIC1', '2026-09-15T10:05:00.000Z');

    await expect(writeTaskSummary('private', 'C07PUBLIC1', 'task-secret', markdown)).rejects.toThrow(/not a real directory/);
    await expect(readFile(join(publicChannel, 'task-secret.md'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not follow a public channel directory symlink through enumeration or direct lookup', async () => {
    const target = join(tempRoot, 'public-target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'task-secret.md'), taskMarkdown('task-secret', 'C07PUBLIC1', '2026-09-15T10:05:00.000Z'));
    await mkdir(join(tempRoot, 'public'), { recursive: true });
    await symlink(target, join(tempRoot, 'public', 'C07PUBLIC1'));

    await expect(readPublicTaskSummaries()).resolves.toEqual([]);
    await expect(readTaskSummariesFromChannel('public', 'C07PUBLIC1', 'task-secret')).resolves.toEqual([]);
  });
});
