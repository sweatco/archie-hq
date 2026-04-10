/**
 * Memory Context Builder Tests
 *
 * Uses temp directories and mocked paths/store modules to test context assembly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Set up the mocks before importing the module under test
let tempDir: string;
let orgPath: string;
let usersDir: string;
let activityPath: string;
let memoryEnabled = true;

vi.mock('../paths.js', () => ({
  isMemoryEnabled: () => memoryEnabled,
  getOrgPath: () => orgPath,
  getUserPath: (username: string) => {
    const safe = username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    return join(usersDir, `${safe}.md`);
  },
  getUsersDir: () => usersDir,
  getMemoryDir: () => tempDir,
  getRecentActivityPath: () => activityPath,
}));

// store.ts reads from paths.js which we've mocked above
import { buildMemoryContext, enrichPromptWithMemory } from '../context.js';

describe('memory context builder', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-context-test-'));
    orgPath = join(tempDir, 'org.md');
    usersDir = join(tempDir, 'users');
    activityPath = join(tempDir, 'recent-activity.md');
    memoryEnabled = true;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---- buildMemoryContext ----

  describe('buildMemoryContext(usernames)', () => {
    it('includes <organizational_knowledge> block when org.md has content', async () => {
      const orgContent = '## Engineering\n- Uses TypeScript\n';
      await writeFile(orgPath, orgContent, 'utf-8');

      const result = await buildMemoryContext([]);

      expect(result).toContain('<organizational_knowledge>');
      expect(result).toContain('</organizational_knowledge>');
      expect(result).toContain('## Engineering');
      expect(result).toContain('- Uses TypeScript');
    });

    it('includes <user_preferences user="egor"> block when user file exists', async () => {
      await mkdir(usersDir, { recursive: true });
      const userContent = '## Communication\n- Prefers async\n';
      await writeFile(join(usersDir, 'egor.md'), userContent, 'utf-8');

      const result = await buildMemoryContext(['egor']);

      expect(result).toContain('<user_preferences user="egor">');
      expect(result).toContain('</user_preferences>');
      expect(result).toContain('## Communication');
      expect(result).toContain('- Prefers async');
    });

    it('includes <recent_activity> block when recent-activity.md has content', async () => {
      const activityContent = '# Recent Activity\n\n| Date | Task ID | Summary | Domain | User |\n|------|---------|---------|--------|------|\n| 2026-04-10 | task-001 | Fixed bug | engineering | egor |\n';
      await writeFile(activityPath, activityContent, 'utf-8');

      const result = await buildMemoryContext([]);

      expect(result).toContain('<recent_activity>');
      expect(result).toContain('</recent_activity>');
      expect(result).toContain('task-001');
    });

    it('skips users with no memory file (no user_preferences tag)', async () => {
      // Do not create any user file for 'unknown-user'
      const result = await buildMemoryContext(['unknown-user']);

      expect(result).not.toContain('<user_preferences');
    });

    it('returns empty string when all files are empty/missing', async () => {
      const result = await buildMemoryContext([]);

      expect(result).toBe('');
    });

    it('joins multiple non-empty blocks with double newlines', async () => {
      const orgContent = '## Engineering\n- Uses TypeScript\n';
      await writeFile(orgPath, orgContent, 'utf-8');

      await mkdir(usersDir, { recursive: true });
      const userContent = '## Communication\n- Prefers async\n';
      await writeFile(join(usersDir, 'egor.md'), userContent, 'utf-8');

      const result = await buildMemoryContext(['egor']);

      // Both blocks present
      expect(result).toContain('<organizational_knowledge>');
      expect(result).toContain('<user_preferences user="egor">');
      // Separated by double newline
      expect(result).toContain('</organizational_knowledge>\n\n<user_preferences');
    });
  });

  // ---- enrichPromptWithMemory ----

  describe('enrichPromptWithMemory(systemPrompt, usernames)', () => {
    it('appends memory context to prompt when memory exists', async () => {
      const orgContent = '## Engineering\n- Uses TypeScript\n';
      await writeFile(orgPath, orgContent, 'utf-8');

      const result = await enrichPromptWithMemory('base prompt', []);

      expect(result).toContain('base prompt');
      expect(result).toContain('## Organizational Memory');
      expect(result).toContain('The following is what you know from previous tasks');
      expect(result).toContain('<organizational_knowledge>');
    });

    it('returns systemPrompt unchanged when memory is disabled', async () => {
      memoryEnabled = false;
      const orgContent = '## Engineering\n- Uses TypeScript\n';
      await writeFile(orgPath, orgContent, 'utf-8');

      const result = await enrichPromptWithMemory('base prompt', []);

      expect(result).toBe('base prompt');
    });

    it('returns systemPrompt unchanged when all memory is empty', async () => {
      const result = await enrichPromptWithMemory('base prompt', []);

      expect(result).toBe('base prompt');
    });
  });
});
