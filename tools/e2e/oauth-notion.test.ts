import { describe, expect, it } from 'vitest';
import {
  dmIdentity,
  parseArgs,
  redactEvidenceText,
  validateMarker,
  validatePreflight,
} from './oauth-notion.js';

describe('Notion OAuth E2E arguments', () => {
  it('parses the required page and marker pairs', () => {
    expect(parseArgs([
      '--shared-page', 'https://www.notion.so/shared',
      '--shared-marker', 'SHARED_123',
      '--personal-page', 'https://workspace.notion.so/personal',
      '--personal-marker', 'PERSONAL_456',
      '--timeout-seconds', '90',
      '--out-dir', '/tmp/evidence',
      '--reuse-shared',
    ])).toEqual({
      sharedPage: 'https://www.notion.so/shared',
      sharedMarker: 'SHARED_123',
      personalPage: 'https://workspace.notion.so/personal',
      personalMarker: 'PERSONAL_456',
      timeoutFlag: '90',
      outDir: '/tmp/evidence',
      reuseShared: true,
    });
  });

  it('rejects missing and unknown arguments', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--shared-page', 'https://www.notion.so/shared'])).toThrow(/shared-marker is required/);
  });
});

describe('Notion OAuth E2E preflight', () => {
  const valid = {
    serverUrl: 'https://mcp.notion.com/mcp',
    publicUrl: 'https://archie.example.com',
    sharedPage: 'https://www.notion.so/shared',
    personalPage: 'https://workspace.notion.so/personal',
    sharedMarker: 'SHARED_123',
    personalMarker: 'PERSONAL_456',
  };

  it('accepts only the official endpoint, public HTTPS callback, Notion pages, and distinct safe markers', () => {
    expect(validatePreflight(valid)).toEqual([]);
    expect(validateMarker('MARKER_123')).toBe(true);
  });

  it('reports every unsafe or ambiguous input', () => {
    const errors = validatePreflight({
      ...valid,
      serverUrl: 'https://lookalike.example/mcp',
      publicUrl: 'http://localhost:3000',
      sharedPage: 'https://example.com/shared',
      personalPage: 'not a url',
      sharedMarker: 'same bad marker',
      personalMarker: 'same bad marker',
    });
    expect(errors).toHaveLength(7);
    expect(errors.join('\n')).toContain('must be https://mcp.notion.com/mcp');
    expect(errors.join('\n')).toContain('must use public HTTPS');
    expect(errors.join('\n')).toContain('markers must differ');
  });
});

describe('Notion OAuth E2E evidence safety', () => {
  it('redacts URLs and credential-shaped values', () => {
    const output = redactEvidenceText(
      'open https://auth.example/authorize?state=SECRET Bearer abc.def ' +
      'access_token=AT refresh_token:RT client_secret=CS',
    );
    expect(output).not.toContain('SECRET');
    expect(output).not.toContain('abc.def');
    expect(output).not.toContain('AT');
    expect(output).not.toContain('RT');
    expect(output).not.toContain('CS');
    expect(output).toContain('<redacted-url>');
  });

  it('resolves identity only from the default 1:1 DM channel', () => {
    const metadata = {
      default_channel: 'slack:D1:1.0',
      channels: {
        'slack:D1:1.0': { type: 'slack', channel_id: 'D1', dm_user_id: 'U1' },
        'slack:C1:2.0': { type: 'slack', channel_id: 'C1' },
      },
    };
    expect(dmIdentity(metadata)).toEqual({ channelId: 'D1', userId: 'U1' });
    expect(dmIdentity({ ...metadata, default_channel: 'slack:C1:2.0' })).toBeNull();
  });
});
