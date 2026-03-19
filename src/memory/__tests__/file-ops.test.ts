/**
 * Tests for memory file operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readMarkdownFile,
  writeMarkdownFile,
  appendToSection,
  replaceInSection,
  removeFromSection,
  prependTableRow,
} from '../file-ops.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'memory-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('readMarkdownFile', () => {
  it('returns empty string for non-existent file', async () => {
    const result = await readMarkdownFile(join(testDir, 'missing.md'));
    expect(result).toBe('');
  });

  it('reads existing file', async () => {
    const path = join(testDir, 'test.md');
    await writeFile(path, '# Hello\nWorld');
    const result = await readMarkdownFile(path);
    expect(result).toBe('# Hello\nWorld');
  });
});

describe('writeMarkdownFile', () => {
  it('creates file and parent dirs', async () => {
    const path = join(testDir, 'sub', 'dir', 'file.md');
    await writeMarkdownFile(path, '# Test');
    const content = await readFile(path, 'utf-8');
    expect(content).toBe('# Test');
  });
});

describe('appendToSection', () => {
  it('creates file with section if it does not exist', async () => {
    const path = join(testDir, 'new.md');
    await appendToSection(path, 'Tech Stack', 'Node.js 20');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('## Tech Stack');
    expect(content).toContain('- Node.js 20');
  });

  it('appends to existing section', async () => {
    const path = join(testDir, 'org.md');
    await writeFile(path, '# Org\n\n## Tech Stack\n\n- Python 3.11\n\n## Conventions\n\n- PEP 8\n');
    await appendToSection(path, 'Tech Stack', 'Node.js 20');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('- Python 3.11');
    expect(content).toContain('- Node.js 20');
    // Node.js should appear before ## Conventions
    const nodeIdx = content.indexOf('- Node.js 20');
    const convIdx = content.indexOf('## Conventions');
    expect(nodeIdx).toBeLessThan(convIdx);
  });

  it('creates section at end if not found', async () => {
    const path = join(testDir, 'org.md');
    await writeFile(path, '# Org\n\n## Tech Stack\n\n- Python\n');
    await appendToSection(path, 'Processes', 'Code review required');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('## Processes');
    expect(content).toContain('- Code review required');
  });

  it('skips near-duplicate bullets', async () => {
    const path = join(testDir, 'org.md');
    await writeFile(path, '## Tech Stack\n\n- Node.js 20\n');
    await appendToSection(path, 'Tech Stack', 'Node.js 20');
    const content = await readFile(path, 'utf-8');
    const matches = content.match(/Node\.js 20/g);
    expect(matches).toHaveLength(1);
  });
});

describe('replaceInSection', () => {
  it('replaces matching line in section', async () => {
    const path = join(testDir, 'org.md');
    await writeFile(path, '## Tech Stack\n\n- Node.js 18\n- PostgreSQL 14\n');
    await replaceInSection(path, 'Tech Stack', 'Node.js 18', 'Node.js 20');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('- Node.js 20');
    expect(content).not.toContain('Node.js 18');
  });

  it('falls back to append if old text not found', async () => {
    const path = join(testDir, 'org.md');
    await writeFile(path, '## Tech Stack\n\n- Python 3.11\n');
    await replaceInSection(path, 'Tech Stack', 'Ruby 3.0', 'Node.js 20');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('- Node.js 20');
    expect(content).toContain('- Python 3.11');
  });

  it('creates file if it does not exist', async () => {
    const path = join(testDir, 'new.md');
    await replaceInSection(path, 'Tech Stack', 'old', 'Node.js 20');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('## Tech Stack');
    expect(content).toContain('- Node.js 20');
  });
});

describe('removeFromSection', () => {
  it('removes matching line', async () => {
    const path = join(testDir, 'org.md');
    await writeFile(path, '## Tech Stack\n\n- Node.js 20\n- PostgreSQL 14\n');
    await removeFromSection(path, 'Tech Stack', 'Node.js 20');
    const content = await readFile(path, 'utf-8');
    expect(content).not.toContain('Node.js 20');
    expect(content).toContain('PostgreSQL 14');
  });

  it('does nothing if file does not exist', async () => {
    await removeFromSection(join(testDir, 'missing.md'), 'Tech Stack', 'anything');
    // No error thrown
  });
});

describe('prependTableRow', () => {
  it('creates file with table header if it does not exist', async () => {
    const path = join(testDir, 'activity.md');
    await prependTableRow(path, '| 2026-03-19 | Fix bug | Fixed login | backend |');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('| Date | Task | Summary | Tags |');
    expect(content).toContain('| --- | --- | --- | --- |');
    expect(content).toContain('| 2026-03-19 | Fix bug | Fixed login | backend |');
  });

  it('prepends row after separator in existing table', async () => {
    const path = join(testDir, 'activity.md');
    await writeFile(path, '# Activity\n\n| Date | Task | Summary | Tags |\n| --- | --- | --- | --- |\n| 2026-03-18 | Old task | Old | misc |\n');
    await prependTableRow(path, '| 2026-03-19 | New task | New | backend |');
    const content = await readFile(path, 'utf-8');
    const newIdx = content.indexOf('New task');
    const oldIdx = content.indexOf('Old task');
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('caps at maxRows', async () => {
    const path = join(testDir, 'activity.md');
    let rows = '';
    for (let i = 0; i < 5; i++) {
      rows += `| 2026-03-0${i} | Task ${i} | Summary | tag |\n`;
    }
    await writeFile(path, `| Date | Task | Summary | Tags |\n| --- | --- | --- | --- |\n${rows}`);
    await prependTableRow(path, '| 2026-03-19 | New task | New | backend |', 3);
    const content = await readFile(path, 'utf-8');
    const dataRows = content.split('\n').filter(l => l.startsWith('|') && !l.includes('---') && !l.includes('Date'));
    expect(dataRows.length).toBeLessThanOrEqual(3);
  });
});
