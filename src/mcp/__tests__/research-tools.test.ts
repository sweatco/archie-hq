import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callPerplexity, PERPLEXITY_PRESETS } from '../research-tools.js';

function okResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200 });
}

describe('Perplexity Agent API integration', () => {
  const originalApiKey = process.env.PERPLEXITY_API_KEY;

  beforeEach(() => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = originalApiKey;
  });

  it('exposes the four search tiers, and not the sandbox or collection presets', () => {
    expect(PERPLEXITY_PRESETS).toEqual(['fast', 'low', 'medium', 'high']);
    expect(PERPLEXITY_PRESETS).not.toContain('xhigh');
    expect(PERPLEXITY_PRESETS).not.toContain('wide-research');
  });

  it('sends every tier with no fields that override the preset', async () => {
    for (const preset of PERPLEXITY_PRESETS) {
      const fetchMock = vi.fn().mockResolvedValue(okResponse({ output_text: 'x', citations: [] }));
      vi.stubGlobal('fetch', fetchMock);

      await callPerplexity(preset, 'q');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.perplexity.ai/v1/agent');
      expect(JSON.parse(init.body as string)).toEqual({ preset, input: 'q', stream: false });
    }
  });

  it('parses text and dedupes citations from the response envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({
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
    })));

    const result = await callPerplexity('high', 'q');

    expect(result.output_text).toBe('Report body.');
    expect(result.citations).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });

  it('falls back to the top-level text and citations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({
      output_text: 'Answer',
      citations: ['https://example.com/source'],
    })));

    await expect(callPerplexity('low', 'q')).resolves.toEqual({
      output_text: 'Answer',
      citations: ['https://example.com/source'],
    });
  });

  it('surfaces the status and body when the Agent API rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid request' } }), { status: 400 }),
    ));

    await expect(callPerplexity('fast', 'q')).rejects.toThrow(/400.*invalid request/);
  });
});
