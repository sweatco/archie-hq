import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  classifyServerAuth,
  discoverProtectedResource,
  parseScopeParam,
  parseResourceMetadataParam,
  fetchProtectedResourceMetadata,
  fetchAuthServerMetadata,
  resetServerAuthClassCache,
} from '../discovery.js';

function protectedResourceResponse(resource: string): Response {
  return new Response(
    JSON.stringify({ resource, authorization_servers: ['https://auth.example.com'] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('parseResourceMetadataParam', () => {
  it('extracts a quoted resource_metadata value', () => {
    expect(parseResourceMetadataParam('Bearer resource_metadata="https://example.com/.well-known/r"'))
      .toBe('https://example.com/.well-known/r');
  });

  it('extracts an unquoted resource_metadata value', () => {
    expect(parseResourceMetadataParam('Bearer resource_metadata=https://example.com/r, realm="x"'))
      .toBe('https://example.com/r');
  });

  it('returns null when no resource_metadata is present', () => {
    expect(parseResourceMetadataParam('Bearer realm="example", error="invalid_token"')).toBeNull();
  });

  it('is case-insensitive on the param name', () => {
    expect(parseResourceMetadataParam('Bearer RESOURCE_METADATA="https://example.com/r"'))
      .toBe('https://example.com/r');
  });
});

describe('parseScopeParam', () => {
  it('parses and normalizes an insufficient-scope challenge', () => {
    expect(parseScopeParam('Bearer error="insufficient_scope", scope="write read write"'))
      .toEqual(['read', 'write']);
  });
});

describe('fetchProtectedResourceMetadata', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses a well-formed RFC 9728 document', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        resource: 'https://api.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['read', 'write'],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as any;

    const result = await fetchProtectedResourceMetadata(
      'https://example.com/.well-known/oauth-protected-resource',
      'https://api.example.com/mcp',
    );
    expect(result.resource).toBe('https://api.example.com/mcp');
    expect(result.authorization_servers).toEqual(['https://auth.example.com']);
    expect(result.scopes_supported).toEqual(['read', 'write']);
  });

  it('throws on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as any;
    await expect(fetchProtectedResourceMetadata(
      'https://example.com/nope',
      'https://api.example.com/mcp',
    )).rejects.toThrow(/HTTP 404/);
  });

  it('rejects when the metadata advertises a different resource than expected', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ resource: 'https://wrong.example.com', authorization_servers: ['https://auth.example.com'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as any;
    await expect(fetchProtectedResourceMetadata(
      'https://example.com/.well-known/oauth-protected-resource',
      'https://api.example.com/mcp',
    )).rejects.toThrow();
  });
});

describe('discoverProtectedResource', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetServerAuthClassCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetServerAuthClassCache();
  });

  it('uses path-specific RFC 9728 metadata before the root fallback', async () => {
    const serverUrl = 'https://mcp.example.com/public/mcp?tenant=one';
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const target = String(url);
      calls.push(target);
      if (target === serverUrl) return new Response('', { status: 200 });
      if (target === 'https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp') {
        return protectedResourceResponse(serverUrl);
      }
      return new Response('', { status: 500 });
    }) as typeof fetch;

    const result = await discoverProtectedResource(serverUrl);

    expect(result?.metadataUrl).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp',
    );
    expect(calls).toEqual([
      serverUrl,
      'https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp',
    ]);
  });

  it('falls back from missing path-specific metadata to root metadata', async () => {
    const serverUrl = 'https://mcp.example.com/public/mcp';
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const target = String(url);
      calls.push(target);
      if (target === serverUrl) return new Response('', { status: 200 });
      if (target.endsWith('/.well-known/oauth-protected-resource/public/mcp')) {
        return new Response('', { status: 404 });
      }
      return protectedResourceResponse(serverUrl);
    }) as typeof fetch;

    const result = await discoverProtectedResource(serverUrl);

    expect(result?.metadataUrl).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
    expect(calls).toEqual([
      serverUrl,
      'https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('uses an advertised metadata URL without trying constructed fallbacks', async () => {
    const serverUrl = 'https://mcp.example.com/public/mcp';
    const advertised = 'https://metadata.example.com/resource';
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const target = String(url);
      calls.push(target);
      if (target === serverUrl) {
        return new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata="${advertised}"` },
        });
      }
      return protectedResourceResponse(serverUrl);
    }) as typeof fetch;

    const result = await discoverProtectedResource(serverUrl);

    expect(result?.metadataUrl).toBe(advertised);
    expect(calls).toEqual([serverUrl, advertised]);
  });

  it('deduplicates concurrent discovery for the same normalized server URL', async () => {
    const serverUrl = 'https://mcp.example.com/mcp';
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target === serverUrl) {
        await probeGate;
        return new Response('', { status: 200 });
      }
      return protectedResourceResponse(serverUrl);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const first = discoverProtectedResource(serverUrl);
    const second = discoverProtectedResource(serverUrl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseProbe();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies a protected response without usable metadata as unknown', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      if (String(url) === 'https://mcp.example.com/mcp') {
        return new Response('', { status: 401 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    await expect(classifyServerAuth('https://mcp.example.com/mcp')).resolves.toBe('unknown');
  });
});

describe('fetchAuthServerMetadata', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses RFC 8414 path first', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/auth',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
          code_challenge_methods_supported: ['S256'],
          response_types_supported: ['code'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const m = await fetchAuthServerMetadata('https://auth.example.com');
    expect(calls[0]).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
    expect(m.token_endpoint).toBe('https://auth.example.com/token');
    expect(m.registration_endpoint).toBe('https://auth.example.com/register');
  });

  it('falls back to OIDC well-known when RFC 8414 is missing', async () => {
    const responses: Record<string, Response> = {
      'https://auth.example.com/.well-known/oauth-authorization-server': new Response('not found', { status: 404 }),
      'https://auth.example.com/.well-known/openid-configuration': new Response(
        JSON.stringify({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/auth',
          token_endpoint: 'https://auth.example.com/token',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    };
    globalThis.fetch = vi.fn(async (url: any) => responses[String(url)] ?? new Response('', { status: 500 })) as any;

    const m = await fetchAuthServerMetadata('https://auth.example.com');
    expect(m.token_endpoint).toBe('https://auth.example.com/token');
  });

  it('throws when both well-known endpoints fail', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as any;
    await expect(fetchAuthServerMetadata('https://auth.example.com')).rejects.toThrow(/Could not fetch/);
  });
});
