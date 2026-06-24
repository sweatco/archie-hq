/**
 * Recent Activity Tests
 *
 * Uses temp directories and mocked paths module to test all activity operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Set up the mock before importing the module
let tempDir: string;
let activityPath: string;

vi.mock('../paths.js', () => ({
  getRecentActivityPath: () => activityPath,
}));

import { readActivity, appendActivity, trimActivity } from '../activity.js';
import type { ActivityEntry } from '../types.js';

describe('recent activity', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-activity-test-'));
    activityPath = join(tempDir, 'recent-activity.md');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---- readActivity ----

  describe('readActivity()', () => {
    it('returns [] when file does not exist', async () => {
      const result = await readActivity();
      expect(result).toEqual([]);
    });

    it('parses existing markdown table entries', async () => {
      const content = [
        '# Recent Activity',
        '',
        '| Date | Task ID | Summary | Domain | User |',
        '|------|---------|---------|--------|------|',
        '| 2026-04-10 | task-001 | Fixed bug | engineering | dana |',
        '| 2026-04-09 | task-002 | Added feature | product | alice |',
      ].join('\n');
      await writeFile(activityPath, content, 'utf-8');

      const result = await readActivity();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        date: '2026-04-10',
        taskId: 'task-001',
        summary: 'Fixed bug',
        domain: 'engineering',
        user: 'dana',
      });
      expect(result[1]).toEqual({
        date: '2026-04-09',
        taskId: 'task-002',
        summary: 'Added feature',
        domain: 'product',
        user: 'alice',
      });
    });

    it('skips header and separator rows', async () => {
      const content = [
        '# Recent Activity',
        '',
        '| Date | Task ID | Summary | Domain | User |',
        '|------|---------|---------|--------|------|',
        '| 2026-04-10 | task-001 | Fixed bug | engineering | dana |',
      ].join('\n');
      await writeFile(activityPath, content, 'utf-8');

      const result = await readActivity();
      expect(result).toHaveLength(1);
    });
  });

  // ---- appendActivity ----

  describe('appendActivity(entry)', () => {
    it('creates file with header + entry when file does not exist', async () => {
      const entry: ActivityEntry = {
        date: '2026-04-10',
        taskId: 'task-001',
        summary: 'Fixed bug',
        domain: 'engineering',
        user: 'dana',
      };

      await appendActivity(entry);

      const content = await readFile(activityPath, 'utf-8');
      expect(content).toContain('# Recent Activity');
      expect(content).toContain('| Date | Task ID | Summary | Domain | User |');
      expect(content).toContain('|------|---------|---------|--------|------|');
      expect(content).toContain('| 2026-04-10 | task-001 | Fixed bug | engineering | dana |');
    });

    it('appends new entry at TOP of table (newest first) in existing file', async () => {
      const existingContent = [
        '# Recent Activity',
        '',
        '| Date | Task ID | Summary | Domain | User |',
        '|------|---------|---------|--------|------|',
        '| 2026-04-09 | task-001 | Old task | engineering | dana |',
      ].join('\n');
      await writeFile(activityPath, existingContent, 'utf-8');

      const entry: ActivityEntry = {
        date: '2026-04-10',
        taskId: 'task-002',
        summary: 'New task',
        domain: 'product',
        user: 'alice',
      };

      await appendActivity(entry);

      const content = await readFile(activityPath, 'utf-8');
      const newEntryPos = content.indexOf('task-002');
      const oldEntryPos = content.indexOf('task-001');
      expect(newEntryPos).toBeLessThan(oldEntryPos);
    });

    it('dedupes by taskId — re-appending the same task replaces the prior row (last-write-wins)', async () => {
      const first: ActivityEntry = {
        date: '2026-04-10',
        taskId: 'task-dup-001',
        summary: 'First summary',
        domain: 'engineering',
        user: 'U07ABC123',
      };
      const second: ActivityEntry = {
        date: '2026-04-10',
        taskId: 'task-dup-001',
        summary: 'Revised summary',
        domain: 'engineering',
        user: 'U07ABC123',
      };
      await appendActivity(first);
      await appendActivity(second);

      const entries = await readActivity();
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toBe('Revised summary');
    });

    it('verifies the inserted row format', async () => {
      const existingContent = [
        '# Recent Activity',
        '',
        '| Date | Task ID | Summary | Domain | User |',
        '|------|---------|---------|--------|------|',
        '| 2026-04-09 | task-001 | Old task | engineering | dana |',
      ].join('\n');
      await writeFile(activityPath, existingContent, 'utf-8');

      const entry: ActivityEntry = {
        date: '2026-04-10',
        taskId: 'task-002',
        summary: 'New task',
        domain: 'product',
        user: 'alice',
      };

      await appendActivity(entry);

      const result = await readActivity();
      expect(result[0]).toEqual(entry);
      expect(result[1]).toEqual({
        date: '2026-04-09',
        taskId: 'task-001',
        summary: 'Old task',
        domain: 'engineering',
        user: 'dana',
      });
    });
  });

  // ---- trimActivity ----

  describe('trimActivity(maxEntries)', () => {
    it('does nothing when entries are within the limit', async () => {
      const content = [
        '# Recent Activity',
        '',
        '| Date | Task ID | Summary | Domain | User |',
        '|------|---------|---------|--------|------|',
        '| 2026-04-10 | task-001 | Task one | engineering | dana |',
        '| 2026-04-09 | task-002 | Task two | product | alice |',
      ].join('\n');
      await writeFile(activityPath, content, 'utf-8');

      await trimActivity(5);

      const result = await readActivity();
      expect(result).toHaveLength(2);
    });

    it('removes entries beyond the limit, keeping newest', async () => {
      const content = [
        '# Recent Activity',
        '',
        '| Date | Task ID | Summary | Domain | User |',
        '|------|---------|---------|--------|------|',
        '| 2026-04-10 | task-001 | Newest | engineering | dana |',
        '| 2026-04-09 | task-002 | Middle | product | alice |',
        '| 2026-04-08 | task-003 | Oldest | operations | bob |',
      ].join('\n');
      await writeFile(activityPath, content, 'utf-8');

      await trimActivity(2);

      const result = await readActivity();
      expect(result).toHaveLength(2);
      expect(result[0].taskId).toBe('task-001');
      expect(result[1].taskId).toBe('task-002');
      // task-003 should be removed
      const fileContent = await readFile(activityPath, 'utf-8');
      expect(fileContent).not.toContain('task-003');
    });

    it('handles file not existing gracefully', async () => {
      await expect(trimActivity(50)).resolves.not.toThrow();
    });
  });
});
