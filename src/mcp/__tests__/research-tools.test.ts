import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callPerplexity, PERPLEXITY_PRESETS } from '../research-tools.js';

function okResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200 });
}

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

  it('exposes the four search tiers, and not the sandbox or collection presets', () => {
    expect(PERPLEXITY_PRESETS).toEqual(['fast', 'low', 'medium', 'high']);
    expect(PERPLEXITY_PRESETS).not.toContain('xhigh');
    expect(PERPLEXITY_PRESETS).not.toContain('wide-research');
  });

  // Pinning a model is what broke the `fast` tier, which rejects Anthropic
  // models with HTTP 400 regardless of the output cap. The request must carry
  // the preset and nothing that overrides it.
  it('sends only the preset and input, with no model override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      output_text: 'Answer',
      citations: ['https://example.com/source'],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await callPerplexity('fast', 'What changed?');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.perplexity.ai/v1/agent');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ preset: 'fast', input: 'What changed?', stream: false });
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('max_output_tokens');
  });

  it('sends every tier without a model override', async () => {
    for (const preset of PERPLEXITY_PRESETS) {
      const fetchMock = vi.fn().mockResolvedValue(okResponse({ output_text: 'x', citations: [] }));
      vi.stubGlobal('fetch', fetchMock);

      await callPerplexity(preset, 'q');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.preset).toBe(preset);
      expect(body).not.toHaveProperty('model');
    }
  });

  it('caps output length only when PERPLEXITY_MAX_OUTPUT_TOKENS is set', async () => {
    process.env.PERPLEXITY_MAX_OUTPUT_TOKENS = '16384';
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ output_text: 'x', citations: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await callPerplexity('medium', 'q');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).max_output_tokens).toBe(16384);
  });

  // Shape observed from the live Agent API: citations arrive both as
  // `search_results` items and as `url_citation` annotations on the message.
  it('parses text and dedupes citations from the live response envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      output: [
        {
          type: 'search_results',
          results: [
            { url: 'https://example.com/a' },
            { url: 'https://example.com/b' },
          ],
        },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Report body.',
              annotations: [
                { type: 'url_citation', url: 'https://example.com/a' },
                { type: 'url_citation', url: 'https://example.com/c' },
              ],
            },
          ],
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callPerplexity('high', 'q');

    expect(result.output_text).toBe('Report body.');
    expect(result.citations).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });

  it('surfaces the status and body when the Agent API rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid request' } }), { status: 400 }),
    ));

    await expect(callPerplexity('fast', 'q')).rejects.toThrow(/400.*invalid request/);
  });
});
