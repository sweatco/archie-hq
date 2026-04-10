/**
 * Extractor Tests
 *
 * Tests for pure functions only — no API mocking required.
 */

import { describe, it, expect } from 'vitest';
import { buildExtractionPrompt, parseExtractionResponse } from '../extractor.js';
import type { ExtractionInput } from '../extractor.js';

const baseInput: ExtractionInput = {
  orgMemory: '## Engineering\n- Uses TypeScript\n',
  userMemory: '## alice\n- Prefers async\n',
  taskId: 'task-abc-123',
  participants: 'alice, bob',
  taskOwner: 'alice',
  status: 'completed',
  createdAt: '2026-04-01T10:00:00Z',
  transcript: 'Some task transcript here.',
};

// ============================================================================
// buildExtractionPrompt
// ============================================================================

describe('buildExtractionPrompt(input)', () => {
  it('substitutes ORG_MEMORY placeholder', async () => {
    const prompt = await buildExtractionPrompt(baseInput);
    expect(prompt).toContain('## Engineering\n- Uses TypeScript');
    expect(prompt).not.toContain('{{ORG_MEMORY}}');
  });

  it('substitutes USER_MEMORY placeholder', async () => {
    const prompt = await buildExtractionPrompt(baseInput);
    expect(prompt).toContain('## alice\n- Prefers async');
    expect(prompt).not.toContain('{{USER_MEMORY}}');
  });

  it('substitutes TASK_ID placeholder', async () => {
    const prompt = await buildExtractionPrompt(baseInput);
    expect(prompt).toContain('task-abc-123');
    expect(prompt).not.toContain('{{TASK_ID}}');
  });

  it('substitutes PARTICIPANTS placeholder', async () => {
    const prompt = await buildExtractionPrompt(baseInput);
    expect(prompt).toContain('alice, bob');
    expect(prompt).not.toContain('{{PARTICIPANTS}}');
  });

  it('substitutes TASK_OWNER placeholder', async () => {
    const prompt = await buildExtractionPrompt(baseInput);
    expect(prompt).toContain('alice');
    expect(prompt).not.toContain('{{TASK_OWNER}}');
  });

  it('substitutes STATUS placeholder', async () => {
    const prompt = await buildExtractionPrompt(baseInput);
    expect(prompt).toContain('completed');
    expect(prompt).not.toContain('{{STATUS}}');
  });

  it('substitutes CREATED_AT placeholder', async () => {
    const prompt = await buildExtractionPrompt(baseInput);
    expect(prompt).toContain('2026-04-01T10:00:00Z');
    expect(prompt).not.toContain('{{CREATED_AT}}');
  });

  it('substitutes TRANSCRIPT placeholder', async () => {
    const prompt = await buildExtractionPrompt(baseInput);
    expect(prompt).toContain('Some task transcript here.');
    expect(prompt).not.toContain('{{TRANSCRIPT}}');
  });

  it('substitutes all placeholders simultaneously', async () => {
    const prompt = await buildExtractionPrompt(baseInput);
    // Ensure no {{...}} placeholders remain
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('truncates transcript longer than 100K chars and adds note', async () => {
    const longTranscript = 'x'.repeat(110_000);
    const prompt = await buildExtractionPrompt({ ...baseInput, transcript: longTranscript });
    expect(prompt).not.toContain(longTranscript);
    expect(prompt).toContain('[truncated]');
    // The transcript in the prompt should be at most 100K chars of the original content
    // plus the truncation note
    const transcriptInPrompt = 'x'.repeat(100_000);
    expect(prompt).toContain(transcriptInPrompt);
  });
});

// ============================================================================
// parseExtractionResponse
// ============================================================================

const validResponse = JSON.stringify({
  org_updates: [
    { action: 'add', section: 'Engineering', content: 'Uses NestJS' },
  ],
  user_updates: {
    alice: [{ action: 'add', section: 'Communication', content: 'Prefers concise updates' }],
  },
  task_summary: 'Task was completed successfully with major refactor.',
  activity_summary: 'Refactored auth module',
  domain: 'engineering',
});

describe('parseExtractionResponse(json)', () => {
  it('parses valid JSON and returns ExtractionResult', () => {
    const result = parseExtractionResponse(validResponse);
    expect(result).not.toBeNull();
    expect(result!.org_updates).toHaveLength(1);
    expect(result!.org_updates[0].action).toBe('add');
    expect(result!.org_updates[0].content).toBe('Uses NestJS');
    expect(result!.user_updates.alice).toHaveLength(1);
    expect(result!.task_summary).toBe('Task was completed successfully with major refactor.');
    expect(result!.activity_summary).toBe('Refactored auth module');
    expect(result!.domain).toBe('engineering');
  });

  it('returns null for invalid JSON', () => {
    const result = parseExtractionResponse('not valid json {{{');
    expect(result).toBeNull();
  });

  it('returns null when org_updates is missing', () => {
    const bad = JSON.stringify({
      user_updates: {},
      task_summary: 'x',
      activity_summary: 'y',
      domain: 'z',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });

  it('returns null when org_updates is not an array', () => {
    const bad = JSON.stringify({
      org_updates: 'not-an-array',
      user_updates: {},
      task_summary: 'x',
      activity_summary: 'y',
      domain: 'z',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });

  it('returns null when user_updates is missing', () => {
    const bad = JSON.stringify({
      org_updates: [],
      task_summary: 'x',
      activity_summary: 'y',
      domain: 'z',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });

  it('returns null when user_updates is not an object', () => {
    const bad = JSON.stringify({
      org_updates: [],
      user_updates: 'not-an-object',
      task_summary: 'x',
      activity_summary: 'y',
      domain: 'z',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });

  it('returns null when task_summary is missing', () => {
    const bad = JSON.stringify({
      org_updates: [],
      user_updates: {},
      activity_summary: 'y',
      domain: 'z',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });

  it('returns null when activity_summary is missing', () => {
    const bad = JSON.stringify({
      org_updates: [],
      user_updates: {},
      task_summary: 'x',
      domain: 'z',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });

  it('returns null when domain is missing', () => {
    const bad = JSON.stringify({
      org_updates: [],
      user_updates: {},
      task_summary: 'x',
      activity_summary: 'y',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });

  it('returns null when an org update has invalid action', () => {
    const bad = JSON.stringify({
      org_updates: [{ action: 'delete', content: 'something' }],
      user_updates: {},
      task_summary: 'x',
      activity_summary: 'y',
      domain: 'z',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });

  it('returns null when an org update is missing content', () => {
    const bad = JSON.stringify({
      org_updates: [{ action: 'add' }],
      user_updates: {},
      task_summary: 'x',
      activity_summary: 'y',
      domain: 'z',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });

  it('handles JSON wrapped in markdown code fences', () => {
    const wrapped = '```json\n' + validResponse + '\n```';
    const result = parseExtractionResponse(wrapped);
    expect(result).not.toBeNull();
    expect(result!.domain).toBe('engineering');
  });

  it('handles JSON wrapped in plain code fences (no language tag)', () => {
    const wrapped = '```\n' + validResponse + '\n```';
    const result = parseExtractionResponse(wrapped);
    expect(result).not.toBeNull();
    expect(result!.domain).toBe('engineering');
  });

  it('parses valid result with empty org_updates and user_updates', () => {
    const minimal = JSON.stringify({
      org_updates: [],
      user_updates: {},
      task_summary: 'Nothing notable.',
      activity_summary: 'Routine maintenance',
      domain: 'operations',
    });
    const result = parseExtractionResponse(minimal);
    expect(result).not.toBeNull();
    expect(result!.org_updates).toHaveLength(0);
  });

  it('validates user updates also have action and content', () => {
    const bad = JSON.stringify({
      org_updates: [],
      user_updates: {
        alice: [{ action: 'add' }], // missing content
      },
      task_summary: 'x',
      activity_summary: 'y',
      domain: 'z',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });

  it('validates user updates action is add or update', () => {
    const bad = JSON.stringify({
      org_updates: [],
      user_updates: {
        alice: [{ action: 'remove', content: 'something' }],
      },
      task_summary: 'x',
      activity_summary: 'y',
      domain: 'z',
    });
    expect(parseExtractionResponse(bad)).toBeNull();
  });
});
