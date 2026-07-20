/**
 * Unit tests for generateTaskTitle.
 *
 * Mocks the Claude Agent SDK's query() with an async generator and asserts:
 * - cleaned/truncated output on success
 * - null on error subtypes, throws, empty results, fully-redacted threads
 * - external authors redacted in transcript before being passed to query()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlackThread } from '../../types/index.js';

// ---- Mocks ----

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
}));

vi.mock('../../connectors/slack/client.js', () => ({
  isExternalUser: (user: { teamId?: string; isRestricted?: boolean; isUltraRestricted?: boolean }) => {
    if (user.isRestricted || user.isUltraRestricted) return true;
    if (user.teamId && user.teamId !== 'T_HOME') return true;
    return false;
  },
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));

vi.mock('../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('../../system/workdir.js', () => ({
  SESSIONS_DIR: '/tmp/sessions',
}));

vi.mock('../task.js', () => ({
  activeTasks: new Map(),
}));

import { generateTaskTitle } from '../title-generator.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../system/logger.js';
const warnSpy = logger.warn as unknown as ReturnType<typeof vi.fn>;

// ---- Helpers ----

function makeThread(overrides?: Partial<SlackThread>): SlackThread {
  return {
    threadId: '1.0',
    channel: { id: 'D1', name: 'DM' },
    shared: false,
    taskVisibility: 'private',
    currentMessageTs: '1.0',
    rootAuthorWasBot: false,
    messages: [
      {
        ts: '1.0',
        text: 'hello, can you help fix the broken auth flow on Android',
        user: { id: 'U1', username: 'me', realName: 'Dana', teamId: 'T_HOME' },
      },
    ],
    ...overrides,
  };
}

function successEvent(title: string): any {
  return { type: 'result', subtype: 'success', structured_output: { title } };
}

beforeEach(() => {
  state.queryEvents = [];
  state.queryShouldThrow = false;
  state.lastQueryArgs = null;
  warnSpy.mockClear();
  (query as any).mockClear();
});

// ---- Tests ----

describe('generateTaskTitle', () => {
  it('returns trimmed title on success', async () => {
    state.queryEvents = [successEvent('  Fix auth flow on Android  ')];
    const title = await generateTaskTitle(makeThread());
    expect(title).toBe('Fix auth flow on Android');
  });

  it('strips surrounding quotes and trailing punctuation', async () => {
    state.queryEvents = [successEvent('"Fix auth flow on Android."')];
    const title = await generateTaskTitle(makeThread());
    expect(title).toBe('Fix auth flow on Android');
  });

  it('truncates titles longer than 60 chars', async () => {
    state.queryEvents = [successEvent('A'.repeat(120))];
    const title = await generateTaskTitle(makeThread());
    expect(title).not.toBeNull();
    expect(title!.length).toBe(60);
  });

  it('returns null when model returns empty/whitespace', async () => {
    state.queryEvents = [successEvent('   ')];
    const title = await generateTaskTitle(makeThread());
    expect(title).toBeNull();
  });

  it('returns null on error_during_execution and logs a warning', async () => {
    state.queryEvents = [{ type: 'result', subtype: 'error_during_execution' }];
    const title = await generateTaskTitle(makeThread());
    expect(title).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null on error_max_structured_output_retries', async () => {
    state.queryEvents = [{ type: 'result', subtype: 'error_max_structured_output_retries' }];
    const title = await generateTaskTitle(makeThread());
    expect(title).toBeNull();
  });

  it('returns null when query() throws', async () => {
    state.queryShouldThrow = true;
    const title = await generateTaskTitle(makeThread());
    expect(title).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('skips LLM and returns null when thread is fully redacted', async () => {
    const thread = makeThread({
      shared: true,
      messages: [
        {
          ts: '1.0',
          text: 'external talk',
          user: { id: 'UEXT', username: 'ext', realName: 'External', teamId: 'T_OTHER' },
        },
      ],
    });
    const title = await generateTaskTitle(thread);
    expect(title).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('redacts external authors in transcript but keeps internal intact', async () => {
    state.queryEvents = [successEvent('Mixed thread title')];
    const thread = makeThread({
      shared: true,
      messages: [
        {
          ts: '1.0',
          text: 'should be redacted',
          user: { id: 'UEXT', username: 'ext', realName: 'External', teamId: 'T_OTHER' },
        },
        {
          ts: '2.0',
          text: 'internal subject',
          user: { id: 'UINT', username: 'me', realName: 'Dana', teamId: 'T_HOME' },
        },
      ],
    });
    await generateTaskTitle(thread);
    expect(query).toHaveBeenCalled();
    const transcript = state.lastQueryArgs.prompt as string;
    expect(transcript).toContain('[external]: [redacted: external participant in shared channel]');
    expect(transcript).toContain('[Dana]: internal subject');
    expect(transcript).not.toContain('should be redacted');
  });

  it('includes forwarded-from label for externally-authored attachment from internal author', async () => {
    state.queryEvents = [successEvent('Forwarded title')];
    const thread = makeThread({
      shared: false,
      messages: [
        {
          ts: '1.0',
          text: 'fyi',
          user: { id: 'UINT', username: 'me', realName: 'Dana', teamId: 'T_HOME' },
          attachments: [
            {
              text: 'forwarded body',
              author: { id: 'UEXT', username: 'ext', realName: 'External', teamId: 'T_OTHER' },
            },
          ],
        },
      ],
    });
    await generateTaskTitle(thread);
    const transcript = state.lastQueryArgs.prompt as string;
    expect(transcript).toContain('[forwarded from <@UEXT:External> — external, team T_OTHER]');
    expect(transcript).toContain('forwarded body');
  });

  it('uses haiku model and json_schema output format', async () => {
    state.queryEvents = [successEvent('A title')];
    await generateTaskTitle(makeThread());
    expect(state.lastQueryArgs.options.model).toBe('haiku');
    expect(state.lastQueryArgs.options.outputFormat?.type).toBe('json_schema');
    expect(state.lastQueryArgs.options.tools).toEqual([]);
  });
});
