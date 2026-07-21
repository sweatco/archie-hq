/**
 * Memory Store Tests
 *
 * Uses temp directories and mocked paths module to test all store operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// We need to set up the mock before importing the module
let tempDir: string;
let usersDir: string;

vi.mock('../paths.js', () => ({
  getUserPath: (id: string) => {
    const safe = id.includes(':') ? id.replace(':', '__') : id;
    return join(usersDir, `${safe}.md`);
  },
  getUsersDir: () => usersDir,
  getMemoryDir: () => tempDir,
  getUserCap: () => 100,
  getSectionCap: () => 30,
  isHousekeepingEnabled: () => false,
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  readUser,
  writeUser,
  parseUserDisplayName,
  readUserFiles,
  applyUserUpdates,
} from '../store.js';
import { logger } from '../../system/logger.js';

describe('memory store', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), 'archie-memory-test-'));
    usersDir = join(tempDir, 'users');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('readUserFiles', () => {
    it('reads only requested users and deduplicates ids', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'U07ABC123.md'), 'display_name: "Dana"\n- Prefers concise updates\n');
      await writeFile(join(usersDir, 'U07BOB999.md'), 'display_name: "Bob"\n- Prefers detailed updates\n');

      const files = await readUserFiles(['U07ABC123', 'U07ABC123']);

      expect(files).toEqual([{ id: 'U07ABC123', displayName: 'Dana', text: 'display_name: "Dana"\n- Prefers concise updates\n' }]);
    });

    it('parses escaped quotes in generated display_name frontmatter', () => {
      expect(parseUserDisplayName('display_name: "Sam \\"S\\""\n')).toBe('Sam "S"');
    });

    it('skips and warns about malformed requested files', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'U07ABC123.md'), '## Communication\n- Prefers concise updates\n');

      await expect(readUserFiles(['U07ABC123'])).resolves.toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'memory',
        expect.stringContaining('missing or malformed display_name'),
      );
    });
  });

  // ---- readUser ----

  describe('readUser(username)', () => {
    it('returns empty string when user file does not exist', async () => {
      const result = await readUser('alice');
      expect(result).toBe('');
    });

    it('returns content when user file exists', async () => {
      await mkdir(usersDir, { recursive: true });
      const content = '## Communication\n- Prefers async\n';
      await writeFile(join(usersDir, 'alice.md'), content, 'utf-8');
      const result = await readUser('alice');
      expect(result).toBe(content);
    });

    // Note: identifier-guard rejection of invalid IDs (e.g. 'John Doe') is
    // covered in paths.test.ts. This test file mocks paths.js to a permissive
    // implementation so it can focus on store semantics.

    it('reads a file keyed by raw Slack ID', async () => {
      await mkdir(usersDir, { recursive: true });
      const content = '## Notes\n- Developer\n';
      await writeFile(join(usersDir, 'U07ABC123.md'), content, 'utf-8');
      const result = await readUser('U07ABC123');
      expect(result).toBe(content);
    });
  });

  // ---- writeUser ----

  describe('writeUser(username, content)', () => {
    it('creates file and users/ directory if missing', async () => {
      const content = '## Communication\n- Prefers async\n';
      await writeUser('alice', content);
      const saved = await readFile(join(usersDir, 'alice.md'), 'utf-8');
      expect(saved).toBe(content);
    });

    it('works even if users/ dir already exists', async () => {
      await mkdir(usersDir, { recursive: true });
      const content = '## Notes\n- Backend developer\n';
      await writeUser('bob', content);
      const saved = await readFile(join(usersDir, 'bob.md'), 'utf-8');
      expect(saved).toBe(content);
    });

    it('overwrites existing user file', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'alice.md'), 'old content', 'utf-8');
      await writeUser('alice', 'new content');
      const saved = await readFile(join(usersDir, 'alice.md'), 'utf-8');
      expect(saved).toBe('new content');
    });
  });

  // ---- applyUserUpdates (also covers applyUpdate add/update/skip semantics) ----

  describe('applyUserUpdates(username, updates)', () => {
    it('creates new user file with section when file does not exist', async () => {
      await applyUserUpdates('alice', [{ action: 'add', section: 'Communication', content: 'Prefers async' }]);
      const saved = await readFile(join(usersDir, 'alice.md'), 'utf-8');
      expect(saved).toContain('## Communication');
      expect(saved).toContain('- Prefers async');
    });

    it('adds under existing section in user file', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'bob.md'), '## Communication\n- Prefers async\n', 'utf-8');
      await applyUserUpdates('bob', [{ action: 'add', section: 'Communication', content: 'Uses Slack' }]);
      const saved = await readFile(join(usersDir, 'bob.md'), 'utf-8');
      expect(saved).toContain('- Prefers async');
      expect(saved).toContain('- Uses Slack');
    });

    it('creates new section at end of file when section missing', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'dana.md'), '## Communication\n- Prefers async\n', 'utf-8');
      await applyUserUpdates('dana', [{ action: 'add', section: 'Notes', content: 'Backend dev' }]);
      const saved = await readFile(join(usersDir, 'dana.md'), 'utf-8');
      expect(saved.indexOf('## Communication')).toBeLessThan(saved.indexOf('## Notes'));
      expect(saved).toContain('- Backend dev');
    });

    it('creates users/ directory if missing', async () => {
      await applyUserUpdates('charlie', [{ action: 'add', section: 'Notes', content: 'Backend dev' }]);
      const saved = await readFile(join(usersDir, 'charlie.md'), 'utf-8');
      expect(saved).toContain('## Notes');
      expect(saved).toContain('- Backend dev');
    });

    it('replaces line on update action with old text', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'erin.md'), '## Notes\n- Uses Node.js\n- Uses TypeScript\n', 'utf-8');
      await applyUserUpdates('erin', [{ action: 'update', content: 'Uses Node.js v20', old: 'Uses Node.js' }]);
      const saved = await readFile(join(usersDir, 'erin.md'), 'utf-8');
      expect(saved).toContain('- Uses Node.js v20');
      expect(saved).not.toContain('- Uses Node.js\n');
      expect(saved).toContain('- Uses TypeScript');
    });

    it('skips update when `old` text is not found (no silent append)', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'finn.md'), '## Notes\n- Uses TypeScript\n', 'utf-8');
      const before = await readFile(join(usersDir, 'finn.md'), 'utf-8');
      await applyUserUpdates('finn', [{ action: 'update', content: 'Uses TypeScript v5', old: 'Uses JavaScript' }]);
      const after = await readFile(join(usersDir, 'finn.md'), 'utf-8');
      expect(after).toBe(before);
    });

    it('skips update when `old` is missing entirely', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'gwen.md'), '## Notes\n- Uses TypeScript\n', 'utf-8');
      const before = await readFile(join(usersDir, 'gwen.md'), 'utf-8');
      await applyUserUpdates('gwen', [{ action: 'update', content: 'orphan content' } as any]);
      const after = await readFile(join(usersDir, 'gwen.md'), 'utf-8');
      expect(after).toBe(before);
    });
  });
});
