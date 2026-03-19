/**
 * Tests for memory extraction.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { MemoryConfig, ExtractionInput, ExtractionResult } from '../types.js';
import { extractFromTranscript, applyExtraction } from '../extraction.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'extraction-test-'));
  await mkdir(join(testDir, 'tasks'), { recursive: true });
  await mkdir(join(testDir, 'users'), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeConfig(llmResponse: string): MemoryConfig {
  return {
    memoryDir: testDir,
    llmCall: async () => llmResponse,
  };
}

const validExtractionJson: ExtractionResult = {
  task_summary: {
    title: 'Fix JWT expiration bug',
    overview: 'User reported JWT tokens expiring prematurely.',
    outcome: 'Fixed by adjusting token TTL from 1h to 24h.',
    key_decisions: ['Increased TTL to 24h', 'Added refresh token flow'],
    tags: ['backend', 'auth', 'bugfix'],
  },
  org_updates: [
    { action: 'add', section: 'Tech Stack', fact: 'Backend uses JWT with RS256 signing', replaces: null },
    { action: 'update', section: 'Conventions', fact: 'JWT TTL is 24 hours', replaces: 'JWT TTL is 1 hour' },
  ],
  user_updates: [
    { user_id: 'U123', user_name: 'Jane Doe', action: 'add', section: 'Work Preferences', fact: 'Prefers small PRs', replaces: null },
  ],
};

describe('extractFromTranscript', () => {
  it('parses valid LLM output', async () => {
    const config = makeConfig(JSON.stringify(validExtractionJson));
    const input: ExtractionInput = {
      taskId: 'task-001',
      transcript: 'some transcript',
      participants: ['pm-agent', 'backend-agent'],
      currentOrgKnowledge: '',
    };

    const result = await extractFromTranscript(config, input);
    expect(result.task_summary.title).toBe('Fix JWT expiration bug');
    expect(result.org_updates).toHaveLength(2);
    expect(result.user_updates).toHaveLength(1);
  });

  it('handles markdown-fenced JSON', async () => {
    const fenced = '```json\n' + JSON.stringify(validExtractionJson) + '\n```';
    const config = makeConfig(fenced);
    const input: ExtractionInput = {
      taskId: 'task-001',
      transcript: 'some transcript',
      participants: ['pm-agent'],
      currentOrgKnowledge: '',
    };

    const result = await extractFromTranscript(config, input);
    expect(result.task_summary.title).toBe('Fix JWT expiration bug');
  });

  it('returns empty result on invalid JSON', async () => {
    const config = makeConfig('not valid json at all');
    const input: ExtractionInput = {
      taskId: 'task-001',
      transcript: 'some transcript',
      participants: [],
      currentOrgKnowledge: '',
    };

    const result = await extractFromTranscript(config, input);
    expect(result.task_summary.title).toBe('');
    expect(result.org_updates).toHaveLength(0);
  });

  it('returns empty result on LLM error', async () => {
    const config: MemoryConfig = {
      memoryDir: testDir,
      llmCall: async () => { throw new Error('API failed'); },
    };
    const input: ExtractionInput = {
      taskId: 'task-001',
      transcript: 'some transcript',
      participants: [],
      currentOrgKnowledge: '',
    };

    const result = await extractFromTranscript(config, input);
    expect(result.task_summary.title).toBe('');
  });
});

describe('applyExtraction', () => {
  it('writes task summary file', async () => {
    const config = makeConfig('');
    await applyExtraction(config, validExtractionJson, 'task-001');

    const { readdirSync } = await import('fs');
    const files = readdirSync(join(testDir, 'tasks'));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/fix-jwt-expiration-bug\.md$/);

    const content = await readFile(join(testDir, 'tasks', files[0]), 'utf-8');
    expect(content).toContain('Fix JWT expiration bug');
    expect(content).toContain('task-001');
  });

  it('creates/updates activity index', async () => {
    const config = makeConfig('');
    await applyExtraction(config, validExtractionJson, 'task-001');

    const content = await readFile(join(testDir, 'activity.md'), 'utf-8');
    expect(content).toContain('Fix JWT expiration bug');
    expect(content).toContain('backend, auth, bugfix');
  });

  it('applies org updates', async () => {
    const orgPath = join(testDir, 'org.md');
    await writeFile(orgPath, '# Org\n\n## Tech Stack\n\n## Conventions\n\n- JWT TTL is 1 hour\n');

    const config = makeConfig('');
    await applyExtraction(config, validExtractionJson, 'task-001');

    const content = await readFile(orgPath, 'utf-8');
    expect(content).toContain('Backend uses JWT with RS256 signing');
    expect(content).toContain('JWT TTL is 24 hours');
    expect(content).not.toContain('JWT TTL is 1 hour');
  });

  it('creates user file with updates', async () => {
    const config = makeConfig('');
    await applyExtraction(config, validExtractionJson, 'task-001');

    const { readdirSync } = await import('fs');
    const files = readdirSync(join(testDir, 'users'));
    expect(files.length).toBe(1);
    expect(files[0]).toBe('U123-jane-doe.md');

    const content = await readFile(join(testDir, 'users', files[0]), 'utf-8');
    expect(content).toContain('Jane Doe');
    expect(content).toContain('Prefers small PRs');
  });
});
