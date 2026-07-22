/**
 * Memory Store Tests
 *
 * Uses temp directories and mocked paths module to test all store operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
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
  applyUserUpdatesWithIdentity,
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
      await applyUserUpdates('dana', [{ action: 'add', section: 'Deliverables', content: 'Wants test evidence in handoffs' }]);
      const saved = await readFile(join(usersDir, 'dana.md'), 'utf-8');
      expect(saved.indexOf('## Communication')).toBeLessThan(saved.indexOf('## Deliverables'));
      expect(saved).toContain('- Wants test evidence in handoffs');
    });

    it('creates users/ directory if missing', async () => {
      await applyUserUpdates('charlie', [{ action: 'add', section: 'Workflow', content: 'Wants a checkpoint before implementation' }]);
      const saved = await readFile(join(usersDir, 'charlie.md'), 'utf-8');
      expect(saved).toContain('## Workflow');
      expect(saved).toContain('- Wants a checkpoint before implementation');
    });

    it('replaces line on update action with old text', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'erin.md'), '## Workflow\n- Wants daily checkpoints\n- Reviews after tests pass\n', 'utf-8');
      await applyUserUpdates('erin', [{ action: 'update', section: 'Workflow', content: 'Wants weekly checkpoints', old: 'Wants daily checkpoints' }]);
      const saved = await readFile(join(usersDir, 'erin.md'), 'utf-8');
      expect(saved).toContain('- Wants weekly checkpoints');
      expect(saved).not.toContain('- Wants daily checkpoints\n');
      expect(saved).toContain('- Reviews after tests pass');
    });

    it('skips update when `old` text is not found (no silent append)', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'finn.md'), '## Workflow\n- Wants weekly checkpoints\n', 'utf-8');
      const before = await readFile(join(usersDir, 'finn.md'), 'utf-8');
      await applyUserUpdates('finn', [{ action: 'update', section: 'Workflow', content: 'Wants daily checkpoints', old: 'Wants monthly checkpoints' }]);
      const after = await readFile(join(usersDir, 'finn.md'), 'utf-8');
      expect(after).toBe(before);
    });

    it('skips update when `old` is missing entirely', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'gwen.md'), '## Workflow\n- Wants weekly checkpoints\n', 'utf-8');
      const before = await readFile(join(usersDir, 'gwen.md'), 'utf-8');
      await applyUserUpdates('gwen', [{ action: 'update', section: 'Workflow', content: 'orphan content' } as any]);
      const after = await readFile(join(usersDir, 'gwen.md'), 'utf-8');
      expect(after).toBe(before);
    });

    it('never replaces a matching bullet outside the declared section', async () => {
      await mkdir(usersDir, { recursive: true });
      const original = [
        '## Communication',
        '- Prefers concise updates',
        '',
        '## Workflow',
        '- Wants weekly checkpoints',
        '',
      ].join('\n');
      await writeFile(join(usersDir, 'hana.md'), original, 'utf-8');

      await applyUserUpdates('hana', [{
        action: 'update',
        section: 'Workflow',
        old: 'Prefers concise updates',
        content: 'Prefers detailed updates',
      }]);

      expect(await readFile(join(usersDir, 'hana.md'), 'utf-8')).toBe(original);
    });
  });

  describe('applyUserUpdatesWithIdentity(userId, displayName, updates)', () => {
    it('returns only sanitized updates that changed the profile', async () => {
      const result = await applyUserUpdatesWithIdentity('U07DANA001', 'Dana Lee', [
        { action: 'add', section: 'Communication', content: '  Prefers concise updates  ', evidence: ['msg:1.1'] },
        { action: 'add', section: 'Skills', content: 'Knows TypeScript', evidence: ['msg:1.1'] },
        { action: 'update', section: 'Workflow', old: 'Missing line', content: 'Wants weekly checkpoints', evidence: ['msg:1.1'] },
      ]);

      expect(result).toEqual({
        appliedUpdates: [{ action: 'add', section: 'Communication', content: 'Prefers concise updates' }],
        capExceeded: false,
      });
      const saved = await readFile(join(usersDir, 'U07DANA001.md'), 'utf-8');
      expect(saved).toContain('display_name: "Dana Lee"');
      expect(saved).toContain('Prefers concise updates');
      expect(saved).not.toContain('Knows TypeScript');
      expect(saved).not.toContain('Wants weekly checkpoints');
    });

    it('does not create a profile file when no update applies', async () => {
      const result = await applyUserUpdatesWithIdentity('U07DANA001', 'Dana Lee', [
        { action: 'add', section: 'Skills', content: 'Knows TypeScript' },
      ]);

      expect(result).toEqual({ appliedUpdates: [], capExceeded: false });
      expect(existsSync(join(usersDir, 'U07DANA001.md'))).toBe(false);
    });
  });
});
