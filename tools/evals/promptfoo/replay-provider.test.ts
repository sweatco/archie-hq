import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { expectDefined } from '../../../src/test-support/assertions.js';
import {
  approvalBeforeMutation,
  called,
  noReply,
  notCalled,
  order,
  terminalState,
  turnReply,
} from './assertions.js';
import ReplayProvider from './replay-provider.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'task-20260101-0900-evalfx',
);

async function replayFixture() {
  const provider = new ReplayProvider({ config: { source: 'eval' } });
  return provider.callApi(FIXTURE, { vars: { taskDir: FIXTURE } });
}

describe('ReplayProvider', () => {
  it('returns replies as output, the recorded cost, and the record in metadata', async () => {
    const response = await replayFixture();

    expect(response.error).toBeUndefined();
    expect(response.output).toBe(
      'Should the reminder go to this channel?\n\nI proposed the reminder. Approve it to start.',
    );
    expect(response.cost).toBeCloseTo(0.12, 10);
    const metadata = expectDefined(response.metadata);
    expect(metadata.record).toMatchObject({ source: 'eval', complete: true });
    expect(metadata.gaps).toEqual([]);
    expect(metadata.skillCalls).toEqual([
      { name: 'core:triggers', is_error: false, source: 'tool' },
    ]);
    expect(metadata.measures).toEqual({ replyCount: 2, wordCount: 15 });
    expect(metadata.toolSequence.slice(0, 3)).toEqual([
      'Skill(core:triggers)',
      'Agent(helper:assistant)',
      'Bash',
    ]);
  });

  it('reports an error when the test names no task folder', async () => {
    const response = await new ReplayProvider().callApi('', { vars: {} });
    expect(response.error).toBe('the test needs a taskDir var naming a task folder');
  });
});

describe('assertions', () => {
  it('grade the record promptfoo passes back from the provider', async () => {
    const providerResponse = await replayFixture();
    const context = (config: Record<string, unknown>) => ({ config, providerResponse });

    expect(terminalState('', context({ state: 'completed' }))).toEqual({
      pass: true,
      score: 1,
      reason: 'ended completed',
    });
    expect(called('', context({ tool: 'Agent(helper:assistant)' })).pass).toBe(true);
    expect(notCalled('', context({ tool: 'report_completion' }))).toEqual({
      pass: false,
      score: 0,
      reason: 'report_completion called 2 time(s)',
    });
    expect(order('', context({ tools: ['propose_trigger', 'report_completion'] })).pass).toBe(true);
    expect(
      approvalBeforeMutation(
        '',
        context({ approval: 'propose_trigger', mutation: 'report_completion' }),
      ),
    ).toEqual({
      pass: false,
      score: 0,
      reason: 'mcp__orchestration-tools__report_completion ran without approval',
    });
  });

  it('grade the replies to one turn of the record', async () => {
    const providerResponse = await replayFixture();
    const context = (config: Record<string, unknown>) => ({ config, providerResponse });

    expect(
      turnReply('', context({ turn: 2, contains: ['approve it'], omits: ['channel'] })),
    ).toEqual({ pass: true, score: 1, reason: 'the reply to turn 2 has the expected text' });
    expect(turnReply('', context({ turn: 1, omits: ['this channel'] })).reason).toBe(
      'the reply to turn 1 has "this channel"',
    );
    expect(noReply('', context({ turn: 2 }))).toEqual({
      pass: false,
      score: 0,
      reason: '1 reply(ies) to turn 2',
    });
  });

  it('reject a missing record or malformed config', async () => {
    const providerResponse = await replayFixture();

    expect(() => called('', { config: { tool: 'Bash' }, providerResponse: {} })).toThrow(
      'no session record in the response; use the replay or live provider',
    );
    expect(() => called('', { config: {}, providerResponse })).toThrow('config.tool is required');
    expect(() => terminalState('', { config: { state: 'done' }, providerResponse })).toThrow(
      'config.state must be one of',
    );
    expect(() => order('', { config: { tools: [] }, providerResponse })).toThrow(
      'config.tools must be a non-empty list of tool names',
    );
    expect(() => noReply('', { config: { turn: 0 }, providerResponse })).toThrow(
      'config.turn must be a turn number, counted from 1',
    );
    expect(() => turnReply('', { config: { turn: 1 }, providerResponse })).toThrow(
      'config needs a contains or an omits list',
    );
    // YAML reads a bare 36 as a number.
    expect(() => turnReply('', { config: { turn: 1, contains: [36] }, providerResponse })).toThrow(
      'config.contains must be a list of quoted texts',
    );
  });
});
