import { afterEach, describe, expect, it, vi } from 'vitest';

let promptUnreadable = false;

vi.mock('../../utils/prompt-loader.js', () => ({
  loadPrompt: async () => {
    if (promptUnreadable) {
      throw new Error('ENOENT: no such file or directory');
    }
    return 'CAPABILITIES PROMPT';
  },
}));

import { logger } from '../../system/logger.js';
import { summariseCapabilities } from '../comprehension.js';
import type { VoiceConfig } from '../types.js';

const cfg: VoiceConfig = {
  deepgramApiKey: 'd',
  sonioxApiKey: 'soniox-key',
  cerebrasApiKey: 'cerebras-key',
};

const SKILLS = [
  'Weekly app stability / crash WBR report. Use when someone asks for the app stability report. The data-analyst-agent owns the analysis end to end.',
  'How to coordinate engineering agents. Use when the task involves code investigation, bug fixes, or deployments.',
];
const TEAM = ['- backend-agent: APIs, databases', '- mobile-agent: Mobile UI/UX'].join('\n');
const INTEGRATIONS = 'You can also query these external systems yourself directly: notion (docs); rollbar (errors).';

interface SeenCall {
  url: string;
  body: Record<string, unknown>;
}
const seen: SeenCall[] = [];

function stubReply(text: string): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: text } }] };
      },
      async text() {
        return text;
      },
    };
  });
}

function stubStatus(status: number): void {
  vi.stubGlobal('fetch', async () => ({
    ok: false,
    status,
    async json() {
      return {};
    },
    async text() {
      return '{"message":"rate limit exceeded","code":"rate_limit_exceeded"}';
    },
  }));
}

function stubThrow(name: string, message: string): void {
  vi.stubGlobal('fetch', async () => {
    const error = new Error(message);
    error.name = name;
    throw error;
  });
}

function summarise(overrides: Partial<Parameters<typeof summariseCapabilities>[1]> = {}) {
  return summariseCapabilities(cfg, {
    skills: SKILLS,
    teamExpertise: TEAM,
    pmIntegrations: INTEGRATIONS,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  seen.length = 0;
});

describe('summariseCapabilities — what it sends', () => {
  it('frames the three sources so the summariser can tell them apart', async () => {
    stubReply('- read the code');
    await summarise();

    expect(seen).toHaveLength(1);
    const messages = seen[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'CAPABILITIES PROMPT' });
    const user = String(messages[1].content);
    expect(user).toBe(
      [
        '<skills>',
        `- ${SKILLS[0]}`,
        `- ${SKILLS[1]}`,
        '</skills>',
        '',
        '<team>',
        TEAM,
        '</team>',
        '',
        '<integrations>',
        INTEGRATIONS,
        '</integrations>',
      ].join('\n'),
    );
  });

  it('asks for the whole reply rather than streaming it — nothing can act on a partial list', async () => {
    stubReply('- read the code');
    await summarise();
    expect(seen[0].body.stream).toBe(false);
    expect(seen[0].body.temperature).toBe(0);
    expect(seen[0].body.max_completion_tokens).toBe(900);
  });

  it('asks for no reasoning at all — the key is absent, not set to a low effort', async () => {
    // Rewriting a deployment's own self-description is not a call worth deliberating over, and reasoning tokens would come out of this same cap.
    stubReply('- read the code');
    await summarise();
    expect('reasoning_effort' in seen[0].body).toBe(false);
  });

  it('says (none) rather than dropping a source a deployment does not have', async () => {
    // (none) flags an empty source as intentional; omitting the tag wouldn't.
    stubReply('- read the code');
    await summarise({ teamExpertise: '', pmIntegrations: '  ' });
    const user = String((seen[0].body.messages as Array<{ content: string }>)[1].content);
    expect(user).toContain('<team>\n(none)\n</team>');
    expect(user).toContain('<integrations>\n(none)\n</integrations>');
  });

  it('spends no round trip when there is nothing at all to summarise', async () => {
    // A deployment with no plugins is valid, not a fault.
    stubReply('- read the code');
    expect(await summarise({ skills: [], teamExpertise: '', pmIntegrations: '' })).toBe('');
    expect(seen).toHaveLength(0);
  });
});

describe('summariseCapabilities — what it returns', () => {
  it('returns the summary trimmed, and reshapes nothing', async () => {
    // Reformatting here would be a second place to get it wrong.
    const list = ['- Look up numbers in the analytics warehouse', '- Read the code in the team repositories'].join('\n');
    stubReply(`\n${list}\n\n`);
    expect(await summarise()).toBe(list);
  });

  it('is empty when the reply is only whitespace', async () => {
    stubReply('   \n  ');
    expect(await summarise()).toBe('');
  });

  it('is empty when the call fails outright, and names the consequence in the log', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    stubStatus(429);

    expect(await summarise()).toBe('');
    // Without this warning, the missing block goes unnoticed.
    expect(warn.mock.calls.some((c) => String(c[1]).includes('No capability summary'))).toBe(true);
  });

  it('is empty when the deadline expires, and does not throw', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    stubThrow('TimeoutError', 'The operation was aborted due to timeout');
    await expect(summarise()).resolves.toBe('');
    stubThrow('TypeError', 'fetch failed');
    await expect(summarise()).resolves.toBe('');
  });

  it('is empty when the prompt file cannot be read, without a request', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    stubReply('- read the code');
    promptUnreadable = true;
    try {
      expect(await summarise()).toBe('');
    } finally {
      promptUnreadable = false;
    }
    expect(seen).toHaveLength(0);
  });
});
