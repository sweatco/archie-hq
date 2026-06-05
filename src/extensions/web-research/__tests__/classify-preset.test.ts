/**
 * Unit tests for classifyPreset.
 *
 * Mocks the Claude Agent SDK's query() with an async generator and asserts:
 * - the selected preset is returned on success
 * - falls back to pro-search on bad/empty structured output, error subtypes,
 *   and thrown errors
 * - uses the proven lean one-shot shape (haiku, tools: [], json_schema) and a
 *   schema with the $schema dialect URL stripped (the bug that made it always
 *   fall back to pro-search)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  queryEvents: [] as any[],
  queryShouldThrow: false,
  lastQueryArgs: null as any,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: any) => {
    state.lastQueryArgs = args;
    if (state.queryShouldThrow) {
      throw new Error('boom');
    }
    return (async function* () {
      for (const e of state.queryEvents) yield e;
    })();
  }),
  // createSdkMcpServer / tool are used at module load; stub them harmlessly.
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((name: string) => ({ name })),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), agent: vi.fn(), error: vi.fn(), system: vi.fn() },
}));

vi.mock('../../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn(),
}));

import { classifyPreset } from '../research-tools.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

function successEvent(preset: string): any {
  return {
    type: 'result',
    subtype: 'success',
    structured_output: { preset, reasoning: 'because' },
  };
}

beforeEach(() => {
  state.queryEvents = [];
  state.queryShouldThrow = false;
  state.lastQueryArgs = null;
  (query as any).mockClear();
});

describe('classifyPreset', () => {
  it('returns the classified preset on success', async () => {
    state.queryEvents = [successEvent('deep-research')];
    expect(await classifyPreset('market sizing for EV chargers')).toBe('deep-research');
  });

  it('returns fast-search when the model says so', async () => {
    state.queryEvents = [successEvent('fast-search')];
    expect(await classifyPreset('capital of France')).toBe('fast-search');
  });

  it('falls back to pro-search on invalid preset value', async () => {
    state.queryEvents = [successEvent('mega-search')];
    expect(await classifyPreset('something')).toBe('pro-search');
  });

  it('falls back to pro-search on error subtype', async () => {
    state.queryEvents = [{ type: 'result', subtype: 'error_during_execution' }];
    expect(await classifyPreset('something')).toBe('pro-search');
  });

  it('falls back to pro-search on max-retries subtype', async () => {
    state.queryEvents = [{ type: 'result', subtype: 'error_max_structured_output_retries' }];
    expect(await classifyPreset('something')).toBe('pro-search');
  });

  it('falls back to pro-search when query() throws', async () => {
    state.queryShouldThrow = true;
    expect(await classifyPreset('something')).toBe('pro-search');
  });

  it('uses the lean haiku + json_schema shape with $schema stripped', async () => {
    state.queryEvents = [successEvent('pro-search')];
    await classifyPreset('topic', 'some context');
    const opts = state.lastQueryArgs.options;
    expect(opts.model).toBe('haiku');
    expect(opts.tools).toEqual([]);
    expect(opts.outputFormat?.type).toBe('json_schema');
    // The dialect URL must be absent — its presence is what broke classification.
    expect(opts.outputFormat?.schema?.$schema).toBeUndefined();
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.cwd).toBeUndefined();
  });

  it('includes the context in the prompt when provided', async () => {
    state.queryEvents = [successEvent('pro-search')];
    await classifyPreset('topic', 'focus on pricing');
    expect(state.lastQueryArgs.prompt).toContain('focus on pricing');
  });
});
