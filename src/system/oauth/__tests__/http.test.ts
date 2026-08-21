import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSafeOAuthUrl, oauthFetch } from '../http.js';

describe('OAuth HTTP policy', () => {
  let originalFetch: typeof fetch;
  let originalLoopbackOverride: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLoopbackOverride = process.env.ARCHIE_OAUTH_ALLOW_INSECURE_LOOPBACK;
    delete process.env.ARCHIE_OAUTH_ALLOW_INSECURE_LOOPBACK;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalLoopbackOverride === undefined) {
      delete process.env.ARCHIE_OAUTH_ALLOW_INSECURE_LOOPBACK;
    } else {
      process.env.ARCHIE_OAUTH_ALLOW_INSECURE_LOOPBACK = originalLoopbackOverride;
    }
  });

  it.each([
    'http://auth.example.com/token',
    'https://user:secret@auth.example.com/token',
    'https://127.0.0.1/token',
    'https://10.0.0.1/token',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/token',
    'https://[::ffff:127.0.0.1]/token',
    'https://[fc00::1]/token',
  ])('rejects unsafe endpoint %s', (url) => {
    expect(() => assertSafeOAuthUrl(url)).toThrow();
  });

  it('allows a public HTTPS endpoint', () => {
    expect(assertSafeOAuthUrl('https://auth.example.com/token').toString())
      .toBe('https://auth.example.com/token');
  });

  it('limits the explicit insecure-development override to loopback', () => {
    process.env.ARCHIE_OAUTH_ALLOW_INSECURE_LOOPBACK = '1';
    expect(assertSafeOAuthUrl('http://localhost:8080/token').protocol).toBe('http:');
    expect(assertSafeOAuthUrl('http://[::1]:8080/token').protocol).toBe('http:');
    expect(() => assertSafeOAuthUrl('http://10.0.0.1/token')).toThrow(/HTTPS/);
  });

  it('revalidates a GET redirect and rejects a private target', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', {
      status: 302,
      headers: { Location: 'https://127.0.0.1/internal' },
    })) as typeof fetch;

    await expect(oauthFetch('https://auth.example.com/discovery')).rejects.toThrow(/public address/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('strips credentials when following a cross-origin GET redirect', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      if (calls.length === 1) {
        return new Response('', {
          status: 302,
          headers: { Location: 'https://metadata.example.com/document' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await oauthFetch('https://auth.example.com/discovery', {
      headers: { Authorization: 'Bearer secret', Cookie: 'session=secret', Accept: 'application/json' },
    });

    expect(calls.map(({ url }) => url)).toEqual([
      'https://auth.example.com/discovery',
      'https://metadata.example.com/document',
    ]);
    expect(calls[1].headers.get('authorization')).toBeNull();
    expect(calls[1].headers.get('cookie')).toBeNull();
    expect(calls[1].headers.get('accept')).toBe('application/json');
  });

  it('never forwards an OAuth POST body across a redirect', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', {
      status: 307,
      headers: { Location: 'https://other.example.com/token' },
    })) as typeof fetch;

    await expect(oauthFetch('https://auth.example.com/token', {
      method: 'POST',
      body: 'client_secret=secret',
    })).rejects.toThrow(/refusing to forward request credentials/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('caps GET redirect chains', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const current = new URL(String(url));
      const hop = Number(current.searchParams.get('hop') ?? '0');
      return new Response('', {
        status: 302,
        headers: { Location: `https://auth.example.com/discovery?hop=${hop + 1}` },
      });
    }) as typeof fetch;

    await expect(oauthFetch('https://auth.example.com/discovery')).rejects.toThrow(/exceeded 3 redirects/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it('propagates caller cancellation into the request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    }) as typeof fetch;

    await expect(oauthFetch('https://auth.example.com/token', { signal: controller.signal }))
      .rejects.toThrow('cancelled');
  });
});
