import { describe, it, expect } from 'vitest';
import {
  extractExchanges,
  extractDelegations,
  extractRoundTrips,
  extractToolMix,
  summarizeUsage,
  extractSample,
  extractWaterfall,
  ROUND_TRIP_CAP_MS,
  type SpeedEvent,
  type AgentTranscript,
  type UsageRecord,
  type TranscriptEntry,
} from './metrics.js';

/** Seconds after a fixed epoch, so a fixture reads as a timeline. */
const T0 = Date.parse('2026-08-25T09:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();

const prompt = (s: number, message = 'hello'): SpeedEvent => ({
  type: 'message', taskId: 't', timestamp: at(s),
  data: { from: 'Egor Khmelev', to: 'pm-agent', message },
});
const reply = (s: number): SpeedEvent => ({
  type: 'message', taskId: 't', timestamp: at(s),
  data: { from: 'pm-agent', to: 'user', message: 'answer' },
});

describe('extractExchanges', () => {
  it('measures prompt to first word', () => {
    const [e] = extractExchanges([prompt(0), reply(25)]);
    expect(e.timeToFirstWordMs).toBe(25_000);
    expect(e.from).toBe('Egor Khmelev');
  });

  it('pairs each prompt with its own reply across a multi-turn task', () => {
    const out = extractExchanges([prompt(0, 'first'), reply(10), prompt(60, 'second'), reply(75)]);
    expect(out.map((e) => e.timeToFirstWordMs)).toEqual([10_000, 15_000]);
    expect(out[1].promptPreview).toBe('second');
  });

  it('charges one wait when the user asks twice before any answer', () => {
    // Two prompts, one reply: the person felt a single 30s wait measured from
    // their latest message, not two exchanges.
    const out = extractExchanges([prompt(0, 'a'), prompt(5, 'a again'), reply(35)]);
    expect(out).toHaveLength(1);
    expect(out[0].timeToFirstWordMs).toBe(30_000);
    expect(out[0].promptPreview).toBe('a again');
  });

  it('keeps an unanswered prompt as a null-latency exchange', () => {
    const [e] = extractExchanges([prompt(0)]);
    expect(e.firstWordAt).toBeNull();
    expect(e.timeToFirstWordMs).toBeNull();
  });

  it('collapses whitespace in the preview so a report stays one line per row', () => {
    const [e] = extractExchanges([prompt(0, 'line one\n\nline two'), reply(1)]);
    expect(e.promptPreview).toBe('line one line two');
  });

  it('closes the last exchange on task:completed', () => {
    const out = extractExchanges([
      prompt(0), reply(25),
      { type: 'task:completed', taskId: 't', timestamp: at(40), data: {} },
    ]);
    expect(out[0].timeToCompletionMs).toBe(40_000);
  });

  it('gives each completion to the exchange it belongs to in a reopened task', () => {
    // Completed at 40s, reopened by a second prompt at 60s, completed again at
    // 100s. Pinning both completions to the final exchange would make the first
    // one negative.
    const out = extractExchanges([
      prompt(0, 'first'), reply(25),
      { type: 'task:completed', taskId: 't', timestamp: at(40), data: {} },
      prompt(60, 'second'), reply(75),
      { type: 'task:completed', taskId: 't', timestamp: at(100), data: {} },
    ]);
    expect(out.map((e) => e.timeToCompletionMs)).toEqual([40_000, 40_000]);
  });

  it('leaves completion null when the task closed before this exchange opened', () => {
    const out = extractExchanges([
      { type: 'task:completed', taskId: 't', timestamp: at(5), data: {} },
      prompt(10), reply(20),
    ]);
    expect(out[0].timeToCompletionMs).toBeNull();
  });

  it('ignores a reply that arrives with no prompt outstanding', () => {
    expect(extractExchanges([reply(5)])).toEqual([]);
  });
});

describe('extractDelegations', () => {
  const events: SpeedEvent[] = [
    { type: 'message', taskId: 't', timestamp: at(90), data: { from: 'pm-agent', to: 'archie-agent', message: 'go' } },
    { type: 'agent:active', taskId: 't', timestamp: at(91), agentName: 'archie-agent', data: {} },
    { type: 'agent:active', taskId: 't', timestamp: at(96), agentName: 'archie-agent', data: {} },
    { type: 'agent:log', taskId: 't', timestamp: at(120), agentName: 'archie-agent', data: { finding: 'x' } },
  ];

  it('splits the hop into spawn and first-turn cost', () => {
    const [d] = extractDelegations(events);
    expect(d.agent).toBe('archie-agent');
    expect(d.dispatchToActiveMs).toBe(1_000);
    // Measured from the FIRST activation (91s), not the re-activation at 96s.
    expect(d.activeToFirstOutputMs).toBe(29_000);
  });

  it('does not treat a message to the user as a delegation', () => {
    expect(extractDelegations([reply(5)])).toEqual([]);
  });

  it('leaves an agent that never reported as an open null-cost hop', () => {
    const [d] = extractDelegations(events.slice(0, 2));
    expect(d.dispatchToActiveMs).toBe(1_000);
    expect(d.activeToFirstOutputMs).toBeNull();
  });
});

const assistant = (s: number, ...tools: string[]) => ({
  timestamp: at(s),
  message: { role: 'assistant', content: tools.map((name) => ({ type: 'tool_use', name, input: {} })) },
});
const result = (s: number) => ({
  timestamp: at(s),
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
});

describe('extractRoundTrips', () => {
  it('measures the gap from tool result to next tool call', () => {
    const t: AgentTranscript = { agentKey: 'pm', entries: [result(0), assistant(7, 'Read'), result(8), assistant(20, 'Bash')] };
    const { trips } = extractRoundTrips(t);
    expect(trips.map((r) => r.roundTripMs)).toEqual([7_000, 12_000]);
    expect(trips.map((r) => r.ordinal)).toEqual([0, 1]);
  });

  it('counts parallel tool calls as one round trip but every tool in the mix', () => {
    const t: AgentTranscript = { agentKey: 'pm', entries: [result(0), assistant(5, 'Read', 'Grep')] };
    const { trips } = extractRoundTrips(t);
    expect(trips).toHaveLength(1);
    expect(trips[0].tools).toEqual(['Read', 'Grep']);
  });

  it('marks only the silent setup trips, not the one that speaks', () => {
    const t: AgentTranscript = {
      agentKey: 'pm',
      entries: [
        result(0), assistant(7, 'Read'),
        result(8), assistant(15, 'Skill'),
        result(16), assistant(30, 'mcp__comms-tools__post_to_user'),
        result(31), assistant(35, 'mcp__orchestration-tools__report_completion'),
      ],
    };
    const { trips } = extractRoundTrips(t);
    // Read and Skill are setup; post_to_user is the trip the wait was for.
    expect(trips.map((r) => r.silentSetup)).toEqual([true, true, false, false]);
  });

  it('excludes and counts a gap too long to be one inference', () => {
    const parked = ROUND_TRIP_CAP_MS / 1000 + 60;
    const t: AgentTranscript = { agentKey: 'pm', entries: [result(0), assistant(parked, 'Read')] };
    const { trips, overCap } = extractRoundTrips(t);
    expect(trips).toEqual([]);
    expect(overCap).toBe(1);
  });

  it('skips rows with no timestamp rather than guessing one', () => {
    const t: AgentTranscript = {
      agentKey: 'pm',
      entries: [{ message: { role: 'user', content: [] } }, assistant(9, 'Read')],
    };
    expect(extractRoundTrips(t).trips).toEqual([]);
  });

  it('ignores assistant rows that carry no tool call', () => {
    const t: AgentTranscript = {
      agentKey: 'pm',
      entries: [result(0), { timestamp: at(3), message: { role: 'assistant', content: [{ type: 'text', text: 'hm' }] } }, assistant(9, 'Read')],
    };
    // The text row does not consume the anchor, so the gap spans 0 -> 9.
    expect(extractRoundTrips(t).trips.map((r) => r.roundTripMs)).toEqual([9_000]);
  });
});

describe('extractToolMix', () => {
  it('counts tool calls across agents', () => {
    const mix = extractToolMix([
      { agentKey: 'pm', entries: [assistant(1, 'Read'), assistant(2, 'Read', 'Skill')] },
      { agentKey: 'archie', entries: [assistant(3, 'Bash')] },
    ]);
    expect(mix).toEqual({ Read: 2, Skill: 1, Bash: 1 });
  });
});

describe('summarizeUsage', () => {
  const rec = (nonce: string, out: number, cost: number, model = 'claude-opus-5'): UsageRecord => ({
    query_nonce: nonce,
    modelUsage: { [model]: { outputTokens: out, costUSD: cost, cacheCreationInputTokens: 100, cacheReadInputTokens: 500 } },
    usage: { speed: 'standard' },
  });

  it('reduces cumulative rows per nonce with max instead of summing them', () => {
    // Same nonce restated: 5158 is the running total, not an increment.
    const s = summarizeUsage([rec('n1', 1200, 0.4), rec('n1', 5158, 0.79)])!;
    expect(s.outputTokens).toBe(5158);
    expect(s.costUSD).toBe(0.79);
  });

  it('adds across distinct nonces', () => {
    const s = summarizeUsage([rec('n1', 1000, 0.5), rec('n2', 300, 0.2)])!;
    expect(s.outputTokens).toBe(1300);
    expect(s.costUSD).toBe(0.7);
  });

  it('records the serving tier so an unmatched comparison is visible', () => {
    const fast: UsageRecord = { query_nonce: 'n2', modelUsage: {}, usage: { speed: 'fast' } };
    expect(summarizeUsage([rec('n1', 10, 0.1), fast])!.speedTiers).toEqual(['fast', 'standard']);
  });

  it('excludes gateway-model cost rather than reporting a fiction', () => {
    const s = summarizeUsage([rec('n1', 100, 9.99, 'openai/gpt-5.6-sol')])!;
    expect(s.costUSD).toBe(0);
    expect(s.costUnpricedRecords).toBe(1);
    expect(s.models).toEqual(['openai/gpt-5.6-sol']);
  });

  it('still prices an anthropic/-prefixed id', () => {
    expect(summarizeUsage([rec('n1', 100, 1.5, 'anthropic/claude-opus-5')])!.costUSD).toBe(1.5);
  });

  it('returns null with nothing to summarize', () => {
    expect(summarizeUsage([])).toBeNull();
  });
});

describe('extractSample', () => {
  it('reports silent-setup round trips from the PM transcript only', () => {
    const sample = extractSample({
      taskId: 't',
      events: [prompt(0), reply(30)],
      transcripts: [
        { agentKey: 'pm', entries: [result(0), assistant(7, 'Read'), result(8), assistant(15, 'Skill'), result(16), assistant(29, 'mcp__comms-tools__post_to_user')] },
        { agentKey: 'archie', entries: [result(0), assistant(4, 'Bash')] },
      ],
    });
    expect(sample.silentSetupRoundTrips).toBe(2);
    expect(sample.roundTrips).toHaveLength(4); // 3 PM + 1 archie
    expect(sample.toolMix.Bash).toBe(1);
  });

  it('degrades to event-only metrics with no transcripts or usage', () => {
    const sample = extractSample({ taskId: 't', events: [prompt(0), reply(25)] });
    expect(sample.exchanges[0].timeToFirstWordMs).toBe(25_000);
    expect(sample.silentSetupRoundTrips).toBeNull();
    expect(sample.usage).toBeNull();
  });

  it('sorts events before pairing so out-of-order rows still measure correctly', () => {
    const sample = extractSample({ taskId: 't', events: [reply(25), prompt(0)] });
    expect(sample.exchanges[0].timeToFirstWordMs).toBe(25_000);
  });
});

describe('extractWaterfall', () => {
  // Rows of one inference share a usage object; a new response advances it.
  const inf = (out: number) => ({ output_tokens: out, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 });
  const row = (s: number, role: string, usage?: Record<string, unknown>, tools: string[] = []): TranscriptEntry => ({
    timestamp: at(s),
    message: {
      role,
      content: tools.length ? tools.map((name) => ({ type: 'tool_use', name, input: {} })) : [{ type: 'text', text: 'x' }],
      ...(usage ? { usage } : {}),
    },
  });

  const transcript: AgentTranscript = {
    agentKey: 'pm',
    entries: [
      row(1.5, 'user'),                              // message delivered
      row(3.4, 'assistant', inf(128)),               // first block  -> ttft 1.9
      row(4.2, 'assistant', inf(128), ['Bash']),     // same inference -> generate 0.8
      row(4.6, 'user'),                              // tool_result  -> tool 0.4
      row(8.9, 'assistant', inf(253)),               // ttft 4.3
      row(9.2, 'assistant', inf(253), ['mcp__comms-tools__post_to_user']), // generate 0.3
    ],
  };

  it('splits a turn into dispatch, ttft, generate and tool', () => {
    const w = extractWaterfall(transcript, at(0), at(10))!;
    expect(w.dispatchMs).toBe(1_500);
    expect(w.ttftMs).toBe(1_900 + 4_300);
    expect(w.generateMs).toBe(800 + 300);
    expect(w.toolMs).toBe(400);
    expect(w.inferences).toBe(2);
  });

  it('accounts for the whole window, leaving only a small residual', () => {
    const w = extractWaterfall(transcript, at(0), at(10))!;
    const summed = w.dispatchMs + w.ttftMs + w.generateMs + w.toolMs + w.unaccountedMs;
    expect(summed).toBe(10_000);
    expect(w.unaccountedMs).toBe(800); // 9.2s last row -> 10s event
  });

  it('groups blocks of one response by their shared usage, not by row count', () => {
    // Three blocks, one inference: generate spans all of them, ttft counts once.
    const t: AgentTranscript = {
      agentKey: 'pm',
      entries: [row(0, 'user'), row(2, 'assistant', inf(9)), row(3, 'assistant', inf(9)), row(5, 'assistant', inf(9), ['X'])],
    };
    const w = extractWaterfall(t, at(0), at(6))!;
    expect(w.inferences).toBe(1);
    expect(w.ttftMs).toBe(2_000);
    expect(w.generateMs).toBe(3_000);
  });

  it('skips structural rows that carry no usage rather than merging them', () => {
    const t: AgentTranscript = {
      agentKey: 'pm',
      entries: [row(0, 'user'), { timestamp: at(1), message: { role: 'assistant', content: [] } }, row(2, 'assistant', inf(5), ['X'])],
    };
    expect(extractWaterfall(t, at(0), at(3))!.inferences).toBe(1);
  });

  it('returns null on unparseable bounds rather than inventing a span', () => {
    expect(extractWaterfall(transcript, 'not-a-date', at(10))).toBeNull();
  });
});
