/**
 * Tests for the MemoryManager standalone API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMemoryManager } from '../index.js';
import type { MemoryConfig } from '../types.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'memory-manager-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeManager(llmResponse: string = '{}'): ReturnType<typeof createMemoryManager> {
  const config: MemoryConfig = {
    memoryDir: testDir,
    llmCall: async () => llmResponse,
  };
  return createMemoryManager(config);
}

describe('MemoryManager', () => {
  it('init creates directory structure', async () => {
    const manager = makeManager();
    await manager.init();

    expect(existsSync(join(testDir, 'users'))).toBe(true);
    expect(existsSync(join(testDir, 'tasks'))).toBe(true);
  });

  it('getOrgKnowledge reads org.md', async () => {
    const manager = makeManager();
    await manager.init();
    await writeFile(join(testDir, 'org.md'), '# Org\n\n## Tech Stack\n\n- Node.js 20\n');

    const content = await manager.getOrgKnowledge();
    expect(content).toContain('Node.js 20');
  });

  it('getOrgKnowledge returns empty for missing file', async () => {
    const manager = makeManager();
    await manager.init();

    const content = await manager.getOrgKnowledge();
    expect(content).toBe('');
  });

  it('updateFact adds to org', async () => {
    const manager = makeManager();
    await manager.init();
    await writeFile(join(testDir, 'org.md'), '# Org\n\n## Tech Stack\n');

    await manager.updateFact({
      scope: 'org',
      section: 'Tech Stack',
      action: 'add',
      fact: 'Uses PostgreSQL 15',
    });

    const content = await readFile(join(testDir, 'org.md'), 'utf-8');
    expect(content).toContain('Uses PostgreSQL 15');
  });

  it('updateFact removes from org', async () => {
    const manager = makeManager();
    await manager.init();
    await writeFile(join(testDir, 'org.md'), '## Tech Stack\n\n- Uses Sidekiq\n- Uses PostgreSQL\n');

    await manager.updateFact({
      scope: 'org',
      section: 'Tech Stack',
      action: 'remove',
      fact: 'Sidekiq',
    });

    const content = await readFile(join(testDir, 'org.md'), 'utf-8');
    expect(content).not.toContain('Sidekiq');
    expect(content).toContain('PostgreSQL');
  });

  it('assembleContext returns formatted context', async () => {
    const manager = makeManager();
    await manager.init();
    await writeFile(join(testDir, 'org.md'), '# Org\n\n## Tech Stack\n\n- Node.js 20\n');

    const context = await manager.assembleContext({ role: 'pm' });
    expect(context).toContain('<organizational_memory>');
    expect(context).toContain('Node.js 20');
  });

  it('works standalone without ARCHIE dependencies', async () => {
    // This test verifies the module can be used with a mock llmCall
    const config: MemoryConfig = {
      memoryDir: testDir,
      llmCall: async (prompt: string) => {
        return JSON.stringify({
          task_summary: { title: 'Test', overview: 'Test', outcome: 'Done', key_decisions: [], tags: [] },
          org_updates: [],
          user_updates: [],
        });
      },
      logger: () => {},
    };
    const manager = createMemoryManager(config);
    await manager.init();

    const result = await manager.extractFromTranscript({
      taskId: 'test-1',
      transcript: 'some work happened',
      participants: [],
      currentOrgKnowledge: '',
    });

    expect(result.task_summary.title).toBe('Test');
  });
});
