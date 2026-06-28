/**
 * Unit tests for the footer model helpers: beautified labels (drop `claude-`,
 * capitalised family, dotted version, `(1M)` marker) and the shared
 * resolveAgentModel default rule.
 */

import { describe, it, expect } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import { modelDisplayLabel, resolveAgentModel } from '../model-label.js';

describe('modelDisplayLabel', () => {
  it('beautifies the short aliases', () => {
    expect(modelDisplayLabel('opus')).toBe('Opus 4.8');
    expect(modelDisplayLabel('sonnet')).toBe('Sonnet 4.6');
    expect(modelDisplayLabel('haiku')).toBe('Haiku 4.5');
  });

  it('renders the [1m] marker as (1M)', () => {
    expect(modelDisplayLabel('sonnet[1m]')).toBe('Sonnet 4.6 (1M)');
    expect(modelDisplayLabel('opus[1m]')).toBe('Opus 4.8 (1M)');
  });

  it('beautifies full claude ids: drops the prefix, dots the version, drops the date', () => {
    expect(modelDisplayLabel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelDisplayLabel('claude-sonnet-4-6-20250929')).toBe('Sonnet 4.6');
    expect(modelDisplayLabel('claude-sonnet-4-6[1m]')).toBe('Sonnet 4.6 (1M)');
    expect(modelDisplayLabel('anthropic/claude-haiku-4-5')).toBe('Haiku 4.5');
  });

  it('passes through unknown non-Claude ids unchanged', () => {
    expect(modelDisplayLabel('some-future-model')).toBe('some-future-model');
  });

  it('is case-insensitive on the [1m] marker and tolerates whitespace', () => {
    expect(modelDisplayLabel('sonnet[1M]')).toBe('Sonnet 4.6 (1M)');
    expect(modelDisplayLabel('  opus  ')).toBe('Opus 4.8');
  });
});

describe('resolveAgentModel', () => {
  const def = (over: Partial<AgentDef>): AgentDef => ({
    id: 'x-agent', key: 'x', role: '', expertise: '', pluginName: 'p', ...over,
  } as AgentDef);

  it('defaults the PM to opus and other agents to sonnet[1m]', () => {
    expect(resolveAgentModel(def({ isPm: true }))).toBe('opus');
    expect(resolveAgentModel(def({ isPm: false }))).toBe('sonnet[1m]');
  });

  it('honours an explicit model override', () => {
    expect(resolveAgentModel(def({ isPm: true, model: 'sonnet' }))).toBe('sonnet');
    expect(resolveAgentModel(def({ model: 'opus[1m]' }))).toBe('opus[1m]');
  });
});
