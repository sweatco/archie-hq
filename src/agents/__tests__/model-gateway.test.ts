/**
 * Unit tests for per-agent model-gateway routing: which models route to a
 * self-hosted Anthropic-format gateway, and the env that points one agent at
 * it. The `ANTHROPIC_API_KEY: ''` assertion is the load-bearing one — the CLI
 * reads that variable before ANTHROPIC_AUTH_TOKEN, so a non-empty value sends
 * the real Anthropic key to the gateway and never sends the gateway credential.
 */

import { describe, it, expect } from 'vitest';
import { isGatewayModel, buildModelGatewayEnv, isGatewayModelWithoutGateway } from '../model-gateway.js';

const GATEWAY = { ARCHIE_MODEL_GATEWAY_URL: 'http://bifrost:8080/anthropic' };

describe('isGatewayModel', () => {
  it('routes non-Anthropic provider prefixes to the gateway', () => {
    expect(isGatewayModel('openai/gpt-5.3-codex')).toBe(true);
    expect(isGatewayModel('vertex/gemini-3.1-pro')).toBe(true);
    expect(isGatewayModel('bedrock/meta.llama3-70b')).toBe(true);
  });

  it('keeps first-party Anthropic models on the direct path', () => {
    // Bare aliases — what every one of our query() call sites actually sends.
    expect(isGatewayModel('sonnet')).toBe(false);
    expect(isGatewayModel('opus')).toBe(false);
    expect(isGatewayModel('haiku')).toBe(false);
    // Concrete ids, with and without the anthropic/ prefix.
    expect(isGatewayModel('claude-opus-5')).toBe(false);
    expect(isGatewayModel('anthropic/claude-sonnet-5')).toBe(false);
    expect(isGatewayModel('ANTHROPIC/claude-sonnet-5')).toBe(false);
  });

  it('ignores the 1M-context marker when deciding the route', () => {
    // `sonnet[1m]` is the default for every non-PM agent, so this must not
    // suddenly become a gateway route.
    expect(isGatewayModel('sonnet[1m]')).toBe(false);
    expect(isGatewayModel('anthropic/claude-sonnet-5[1m]')).toBe(false);
    expect(isGatewayModel('openai/gpt-5.3-codex[1m]')).toBe(true);
  });
});

describe('buildModelGatewayEnv', () => {
  it('is a no-op for a Claude agent even when a gateway is configured', () => {
    expect(buildModelGatewayEnv('sonnet[1m]', GATEWAY)).toEqual({});
    expect(buildModelGatewayEnv('claude-opus-5', GATEWAY)).toEqual({});
  });

  it('is a no-op for a gateway model when no gateway is configured', () => {
    expect(buildModelGatewayEnv('openai/gpt-5.3-codex', {})).toEqual({});
  });

  it('empties ANTHROPIC_API_KEY so the gateway credential is the one that is sent', () => {
    const env = buildModelGatewayEnv('openai/gpt-5.3-codex', {
      ...GATEWAY,
      ARCHIE_MODEL_GATEWAY_TOKEN: 'gw-token',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://bifrost:8080/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('gw-token');
    // Present AND empty: merely omitting it would leave the caller's real key in place.
    expect(env).toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.ANTHROPIC_API_KEY).toBe('');
  });

  it('omits the auth token when none is configured (gateways may be unauthenticated)', () => {
    const env = buildModelGatewayEnv('openai/gpt-5.3-codex', GATEWAY);
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(env.ANTHROPIC_API_KEY).toBe('');
  });

  it('declares the real context window and output ceiling when configured', () => {
    // Unset, the CLI assumes 200K context and caps output at 32000 for an
    // unrecognised id — a quarter of what a GPT-5.6 tier allows.
    const env = buildModelGatewayEnv('openai/gpt-5.3-codex', {
      ...GATEWAY,
      ARCHIE_MODEL_GATEWAY_CONTEXT_TOKENS: '400000',
      ARCHIE_MODEL_GATEWAY_MAX_OUTPUT_TOKENS: '128000',
    });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('400000');
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('128000');
    const bare = buildModelGatewayEnv('openai/gpt-5.3-codex', GATEWAY);
    expect(bare).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
    expect(bare).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS');
  });

  it('keys limits off the alias TARGET in fleet mode, not the bare alias', () => {
    // Call sites pass `sonnet[1m]`, which carries no limits of its own; the
    // per-model map is written against the model the alias now points at.
    const env = buildModelGatewayEnv('sonnet[1m]', {
      ...GATEWAY,
      ARCHIE_MODEL_GATEWAY_ALIAS_SONNET: 'openai/gpt-5.6-terra',
      ARCHIE_MODEL_GATEWAY_CONTEXT_TOKENS: 'openai/gpt-5.6-terra=922000,openai/gpt-5.3-codex=400000',
      ARCHIE_MODEL_GATEWAY_MAX_OUTPUT_TOKENS: 'openai/gpt-5.6-terra=128000',
    });
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('openai/gpt-5.6-terra');
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('922000');
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('128000');
  });

  it('routes every agent in fleet mode, including plain Claude aliases', () => {
    const env = buildModelGatewayEnv('opus', {
      ...GATEWAY,
      ARCHIE_MODEL_GATEWAY_ALIAS_OPUS: 'openai/gpt-5.6-sol',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY.ARCHIE_MODEL_GATEWAY_URL);
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('openai/gpt-5.6-sol');
  });
});

describe('isGatewayModelWithoutGateway', () => {
  it('flags the misconfiguration that would otherwise fail opaquely', () => {
    expect(isGatewayModelWithoutGateway('openai/gpt-5.3-codex', {})).toBe(true);
    expect(isGatewayModelWithoutGateway('openai/gpt-5.3-codex', GATEWAY)).toBe(false);
    expect(isGatewayModelWithoutGateway('sonnet[1m]', {})).toBe(false);
  });
});
