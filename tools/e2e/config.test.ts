import { describe, it, expect } from 'vitest';
import { portFromDotenv, resolveBaseUrl, resolveTimeoutSeconds } from './config.js';

describe('resolveBaseUrl — precedence', () => {
  it('ARCHIE_URL wins over everything', () => {
    const url = resolveBaseUrl(
      { ARCHIE_URL: 'http://remote:8080', PORT: '4000' },
      'PORT=5000\n',
    );
    expect(url).toBe('http://remote:8080');
  });

  it('PORT env var wins over .env PORT', () => {
    const url = resolveBaseUrl({ PORT: '4000' }, 'PORT=5000\n');
    expect(url).toBe('http://localhost:4000');
  });

  it('.env PORT wins over the default', () => {
    const url = resolveBaseUrl({}, 'ANTHROPIC_API_KEY=sk-x\nPORT=5000\n');
    expect(url).toBe('http://localhost:5000');
  });

  it('falls back to http://localhost:3000', () => {
    expect(resolveBaseUrl({}, undefined)).toBe('http://localhost:3000');
    expect(resolveBaseUrl({}, 'ANTHROPIC_API_KEY=sk-x\n')).toBe('http://localhost:3000');
  });
});

describe('portFromDotenv', () => {
  it('captures the value only — stops at whitespace, quotes, and inline comments', () => {
    expect(portFromDotenv('PORT=3210 # local override\n')).toBe('3210');
    expect(portFromDotenv('PORT="3210"\n')).toBe('3210');
    expect(portFromDotenv('  PORT = 3210\n')).toBe('3210');
  });

  it('ignores files without a PORT line', () => {
    expect(portFromDotenv('EXPORT=1\n#PORT=9999\n')).toBeUndefined();
    expect(portFromDotenv(undefined)).toBeUndefined();
  });
});

describe('resolveTimeoutSeconds — override chain', () => {
  it('flag beats env beats default', () => {
    expect(resolveTimeoutSeconds('120', '300', 600)).toBe(120);
    expect(resolveTimeoutSeconds(undefined, '300', 600)).toBe(300);
    expect(resolveTimeoutSeconds(undefined, undefined, 600)).toBe(600);
  });

  it('an empty env var falls through to the default', () => {
    expect(resolveTimeoutSeconds(undefined, '', 600)).toBe(600);
  });

  it('rejects invalid values loudly instead of falling through', () => {
    expect(() => resolveTimeoutSeconds('abc', undefined, 600)).toThrow(/invalid timeout from flag/);
    expect(() => resolveTimeoutSeconds('-5', undefined, 600)).toThrow(/positive number/);
    expect(() => resolveTimeoutSeconds(undefined, 'soon', 600)).toThrow(/invalid timeout from env/);
  });
});
