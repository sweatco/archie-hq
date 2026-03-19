/**
 * Tests for memory retrieval / context assembly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { assembleContext } from '../retrieval.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'retrieval-test-'));
  await mkdir(join(testDir, 'users'), { recursive: true });
  await mkdir(join(testDir, 'tasks'), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('assembleContext', () => {
  it('returns empty string when no memory files exist (non-PM)', async () => {
    const result = await assembleContext(testDir, { role: 'repo' });
    expect(result).toBe('');
  });

  it('returns task summaries pointer even with no org.md for PM', async () => {
    const result = await assembleContext(testDir, { role: 'pm' });
    expect(result).toContain('task summaries available at');
  });

  it('includes org.md for all roles', async () => {
    await writeFile(join(testDir, 'org.md'), '# Org Knowledge\n\n## Tech Stack\n\n- Node.js 20\n');

    for (const role of ['pm', 'repo', 'plugin'] as const) {
      const result = await assembleContext(testDir, { role });
      expect(result).toContain('<organizational_memory>');
      expect(result).toContain('Node.js 20');
    }
  });

  it('includes user preferences for PM role', async () => {
    await writeFile(join(testDir, 'org.md'), '# Org\n\n## Tech Stack\n');
    await writeFile(join(testDir, 'users', 'U123-jane-doe.md'), '# Jane Doe\n\nPrefers small PRs');

    const result = await assembleContext(testDir, { role: 'pm', userId: 'U123' });
    expect(result).toContain('<user_preferences');
    expect(result).toContain('Prefers small PRs');
  });

  it('does not include user preferences for repo role', async () => {
    await writeFile(join(testDir, 'org.md'), '# Org\n\n## Tech Stack\n');
    await writeFile(join(testDir, 'users', 'U123-jane-doe.md'), '# Jane Doe\n\nPrefers small PRs');

    const result = await assembleContext(testDir, { role: 'repo', userId: 'U123' });
    expect(result).not.toContain('user_preferences');
  });

  it('includes activity index for PM role', async () => {
    await writeFile(join(testDir, 'org.md'), '# Org\n');
    await writeFile(join(testDir, 'activity.md'), '# Activity\n\n| Date | Task |\n| --- | --- |\n| 2026-03-19 | Fix bug |\n');

    const result = await assembleContext(testDir, { role: 'pm' });
    expect(result).toContain('<recent_activity>');
    expect(result).toContain('Fix bug');
  });

  it('includes pointer to task summaries for PM', async () => {
    await writeFile(join(testDir, 'org.md'), '# Org\n');

    const result = await assembleContext(testDir, { role: 'pm' });
    expect(result).toContain('task summaries available at');
  });
});
