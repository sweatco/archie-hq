import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseResourceMetadataParam,
  fetchProtectedResourceMetadata,
  fetchAuthServerMetadata,
} from '../discovery.js';

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
