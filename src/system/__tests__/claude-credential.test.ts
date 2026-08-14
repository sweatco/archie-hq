import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const systemMock = vi.fn();
vi.mock('../logger.js', () => ({ logger: { system: (m: string) => systemMock(m) } }));

import {
  resolveClaudeCredential,
  claudeCredentialEnv,
  assertClaudeCredentialAvailable,
} from '../claude-credential.js';
import { StartupError } from '../startup-error.js';

const savedApiKey = process.env.ANTHROPIC_API_KEY;
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

beforeEach(() => {
  systemMock.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
});

describe('resolveClaudeCredential', () => {
  it('resolves api_key from ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const r = resolveClaudeCredential();
    expect(r.kind).toBe('api_key');
    expect(r.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
  });

  it('resolves oauth_token_env from CLAUDE_CODE_OAUTH_TOKEN when no api key', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    const r = resolveClaudeCredential();
    expect(r.kind).toBe('oauth_token_env');
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-env' });
  });

  it('prefers api key over env token', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    expect(resolveClaudeCredential().kind).toBe('api_key');
  });

  it('resolves none when no credential is set', () => {
    expect(resolveClaudeCredential().kind).toBe('none');
  });

  it('treats a whitespace-only value as absent', () => {
    process.env.ANTHROPIC_API_KEY = '   ';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    expect(resolveClaudeCredential().kind).toBe('oauth_token_env');
  });
});

describe('claudeCredentialEnv', () => {
  it('returns the env fragment', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    expect(claudeCredentialEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-env' });
  });

  it('returns {} when nothing resolves', () => {
    expect(claudeCredentialEnv()).toEqual({});
  });
});

describe('assertClaudeCredentialAvailable', () => {
  it('throws when no credential is available', () => {
    expect(() => assertClaudeCredentialAvailable()).toThrow(/No Claude credential/);
  });

  it('logs the resolved kind and does not throw when available', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assertClaudeCredentialAvailable();
    expect(systemMock).toHaveBeenCalledWith('Claude auth: api_key');
  });

  it('logs the "oauth_token (env)" label for a subscription token', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    assertClaudeCredentialAvailable();
    expect(systemMock).toHaveBeenCalledWith('Claude auth: oauth_token (env)');
  });

  it('throws a StartupError whose details name both credential env vars', () => {
    let err: unknown;
    try {
      assertClaudeCredentialAvailable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StartupError);
    const details = (err as StartupError).details.join('\n');
    expect(details).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(details).toContain('ANTHROPIC_API_KEY');
  });
});
