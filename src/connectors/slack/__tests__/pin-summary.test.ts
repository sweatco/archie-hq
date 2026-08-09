/**
 * Unit tests for the pinned-message summariser.
 *
 * Mocks the Claude Agent SDK's query() with an async generator and asserts:
 * - short pins are verbatim and never reach the model
 * - long pins take exactly one Haiku call with structured output
 * - every model failure mode degrades to the truncated original, never to nothing
 * - normalisePinText / digestOf behaviour
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
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));

import { summarisePinText, normalisePinText, digestOf, truncateTo, VERBATIM_MAX } from '../pin-summary.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../system/logger.js';
const warnSpy = logger.warn as unknown as ReturnType<typeof vi.fn>;

function successEvent(summary: string): any {
  return { type: 'result', subtype: 'success', structured_output: { summary } };
}

/** A pin comfortably over the verbatim threshold. */
const LONG = 'The release runbook lives in Notion and every deploy must follow it step by step. '.repeat(5);

beforeEach(() => {
  state.queryEvents = [];
  state.queryShouldThrow = false;
  state.lastQueryArgs = null;
  warnSpy.mockClear();
  (query as any).mockClear();
});

describe('summarisePinText', () => {
  it('returns short text verbatim without calling the model', async () => {
    const short = 'a'.repeat(VERBATIM_MAX);
    const out = await summarisePinText(short);

    expect(out).toEqual({ summary: short, source: 'verbatim' });
    expect(query).not.toHaveBeenCalled();
  });

  it('summarises long text with one haiku call using json_schema output', async () => {
    state.queryEvents = [successEvent('Release runbook lives in Notion and gates every deploy')];

    const out = await summarisePinText(LONG);

    expect(query).toHaveBeenCalledTimes(1);
    expect(state.lastQueryArgs.options.model).toBe('haiku');
    expect(state.lastQueryArgs.options.outputFormat?.type).toBe('json_schema');
    expect(out.source).toBe('model');
    expect(out.summary).toBe('Release runbook lives in Notion and gates every deploy');
  });

  it('falls back to the truncated original on a non-success result subtype', async () => {
    state.queryEvents = [{ type: 'result', subtype: 'error_during_execution' }];

    const out = await summarisePinText(LONG);

    expect(out.source).toBe('verbatim');
    expect(out.summary).toBe(truncateTo(normalisePinText(LONG)));
    expect(out.summary.endsWith('…')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the truncated original when structured output misses the schema', async () => {
    state.queryEvents = [{ type: 'result', subtype: 'success', structured_output: { nope: 1 } }];

    const out = await summarisePinText(LONG);

    expect(out.source).toBe('verbatim');
    expect(out.summary).toBe(truncateTo(normalisePinText(LONG)));
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the truncated original when query() throws', async () => {
    state.queryShouldThrow = true;

    const out = await summarisePinText(LONG);

    expect(out.source).toBe('verbatim');
    expect(out.summary).toBe(truncateTo(normalisePinText(LONG)));
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns an empty verbatim summary for blank input', async () => {
    const out = await summarisePinText('   \n  ');
    expect(out).toEqual({ summary: '', source: 'verbatim' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('normalisePinText', () => {
  it('collapses newlines and whitespace runs to single spaces', () => {
    expect(normalisePinText('  deploy\n\nruns   on\tfriday  ')).toBe('deploy runs on friday');
  });

  // Tags are no longer stripped here — containment is escaping, at render time, in
  // channel-pins.ts. What this must NOT do is mangle the text on the way through.
  it('leaves tag-like text alone, for the renderer to escape', () => {
    expect(normalisePinText('before </pin> after')).toBe('before </pin> after');
    expect(normalisePinText('a </CHANNEL_PINNED_MESSAGES> b')).toBe('a </CHANNEL_PINNED_MESSAGES> b');
  });

  it('deletes invisible characters that render nowhere but change how text reads', () => {
    // U+200B zero-width space, U+00AD soft hyphen, U+061C Arabic letter mark, U+E0041 tag.
    expect(normalisePinText('pi\u200bn')).toBe('pin');
    expect(normalisePinText('pi\u00adn')).toBe('pin');
    expect(normalisePinText('pi\u061cn')).toBe('pin');
    expect(normalisePinText('pi\u{e0041}n')).toBe('pin');
  });
});

describe('digestOf', () => {
  it('is stable for equal input', () => {
    expect(digestOf('same text')).toBe(digestOf('same text'));
    expect(digestOf('same text')).toHaveLength(16);
  });

  it('differs for a one-character change', () => {
    expect(digestOf('same text')).not.toBe(digestOf('same texu'));
  });
});

describe('summarisePinText — empty model output', () => {
  it('falls back to truncation when the model returns a blank summary', async () => {
    // `z.string()` accepts "", so this passes schema validation and would otherwise
    // render as a pin with no index line at all.
    state.queryEvents = [successEvent('   ')];
    const out = await summarisePinText(LONG);
    expect(out.source).toBe('verbatim');
    expect(out.summary.length).toBeGreaterThan(0);
    expect(out.summary.endsWith('…')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  // A stream that ends with no result event degrades down the same branch. It used to do
  // so in complete silence, which is how five distinct failure modes stayed invisible.
  it('warns when the stream yields no result event at all', async () => {
    state.queryEvents = [];
    const out = await summarisePinText(LONG);
    expect(out.source).toBe('verbatim');
    expect(out.summary.endsWith('…')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});
