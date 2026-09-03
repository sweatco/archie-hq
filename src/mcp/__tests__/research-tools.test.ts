import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callPerplexity, PERPLEXITY_PRESETS } from '../research-tools.js';

describe('Perplexity Agent API integration', () => {
  const originalApiKey = process.env.PERPLEXITY_API_KEY;
  const originalMaxOutputTokens = process.env.PERPLEXITY_MAX_OUTPUT_TOKENS;

  beforeEach(() => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
    delete process.env.PERPLEXITY_MAX_OUTPUT_TOKENS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = originalApiKey;
    if (originalMaxOutputTokens === undefined) delete process.env.PERPLEXITY_MAX_OUTPUT_TOKENS;
    else process.env.PERPLEXITY_MAX_OUTPUT_TOKENS = originalMaxOutputTokens;
  });

  it('uses the current tier-based preset names', () => {
    expect(PERPLEXITY_PRESETS).toEqual(['fast', 'low', 'medium']);
  });

  it('sends a valid tier-based preset to the Agent API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: 'Answer',
      citations: ['https://example.com/source'],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callPerplexity('low', 'What changed?')).resolves.toEqual({
      output_text: 'Answer',
      citations: ['https://example.com/source'],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.perplexity.ai/v1/agent');
    expect(JSON.parse(init.body as string)).toEqual({
      preset: 'low',
      model: 'anthropic/claude-sonnet-4-6',
      input: 'What changed?',
      stream: false,
      max_output_tokens: 64000,
    });
  });
});
