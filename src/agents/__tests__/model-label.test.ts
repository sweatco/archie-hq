/**
 * Unit tests for the footer model helpers: beautified labels (drop `claude-`,
 * capitalised family, dotted version, `(1M)` marker) and the shared
 * resolveAgentModel default rule.
 */

import { describe, it, expect } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import { modelDisplayLabel, resolveAgentModel, resolveAgentEffort } from '../model-label.js';

describe('modelDisplayLabel', () => {
  it('derives family + version from a concrete claude id (no per-version table)', () => {
    expect(modelDisplayLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelDisplayLabel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelDisplayLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelDisplayLabel('claude-fable-5')).toBe('Fable 5');
    expect(modelDisplayLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelDisplayLabel('claude-haiku-4-5')).toBe('Haiku 4.5');
  });

  it('parses versions generically — a model we have never seen still renders (proves nothing is hard-coded)', () => {
    expect(modelDisplayLabel('claude-opus-6')).toBe('Opus 6');
    expect(modelDisplayLabel('claude-sonnet-7-2')).toBe('Sonnet 7.2');
    expect(modelDisplayLabel('claude-quasar-10-3-20281231')).toBe('Quasar 10.3');
  });

  it('drops the provider prefix, dots the version, and drops the date/suffix', () => {
    expect(modelDisplayLabel('claude-sonnet-4-6-20250929')).toBe('Sonnet 4.6');
    expect(modelDisplayLabel('anthropic/claude-haiku-4-5')).toBe('Haiku 4.5');
  });

  it('renders a bare family alias as the family only (the version is not in the string)', () => {
    // A bare alias has no version — that lives in the SDK's alias table. The
    // footer prefers the resolved concrete id for the versioned label; this is
    // only the pre-resolution fallback.
    expect(modelDisplayLabel('opus')).toBe('Opus');
    expect(modelDisplayLabel('sonnet')).toBe('Sonnet');
    expect(modelDisplayLabel('haiku')).toBe('Haiku');
  });

  it('renders the [1m] marker as (1M) for both concrete ids and aliases', () => {
    expect(modelDisplayLabel('claude-sonnet-5[1m]')).toBe('Sonnet 5 (1M)');
    expect(modelDisplayLabel('claude-sonnet-4-6[1m]')).toBe('Sonnet 4.6 (1M)');
    expect(modelDisplayLabel('sonnet[1m]')).toBe('Sonnet (1M)');
    expect(modelDisplayLabel('opus[1m]')).toBe('Opus (1M)');
  });

  it('passes through unknown non-Claude ids unchanged', () => {
    expect(modelDisplayLabel('some-future-model')).toBe('some-future-model');
    expect(modelDisplayLabel('gpt-5')).toBe('gpt-5');
  });

  it('falls back to the raw id on a malformed id with no family (no empty label)', () => {
    // A bare prefix yields an empty family; returning the raw id keeps the
    // footer from rendering a dangling ` + ` separator.
    expect(modelDisplayLabel('claude-')).toBe('claude-');
    expect(modelDisplayLabel('anthropic/claude-')).toBe('anthropic/claude-');
    expect(modelDisplayLabel('claude-[1m]')).toBe('claude- (1M)');
  });

  it('is case-insensitive on the [1m] marker and tolerates whitespace', () => {
    expect(modelDisplayLabel('claude-sonnet-5[1M]')).toBe('Sonnet 5 (1M)');
    expect(modelDisplayLabel('  opus  ')).toBe('Opus');
    expect(modelDisplayLabel('  claude-opus-5  ')).toBe('Opus 5');
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

  it('max mode: leaves the model unchanged without a maxMode override', () => {
    expect(resolveAgentModel(def({ model: 'opus' }), true)).toBe('opus');
    expect(resolveAgentModel(def({ isPm: false }), true)).toBe('sonnet[1m]');
    expect(resolveAgentModel(def({ isPm: true }), true)).toBe('opus');
  });

  it('max mode: an explicit maxMode.model wins for any agent', () => {
    expect(resolveAgentModel(def({ model: 'opus', maxMode: { model: 'claude-fable-5-1' } }), true)).toBe('claude-fable-5-1');
    expect(resolveAgentModel(def({ isPm: true, maxMode: { model: 'claude-fable-5-1' } }), true)).toBe('claude-fable-5-1');
    expect(resolveAgentModel(def({ model: 'opus', maxMode: { model: 'claude-fable-5-1' } }), false)).toBe('opus'); // off → ignored
  });
});

describe('resolveAgentEffort', () => {
  const def = (over: Partial<AgentDef>): AgentDef => ({
    id: 'x-agent', key: 'x', role: '', expertise: '', pluginName: 'p', ...over,
  } as AgentDef);

  it('off max mode: returns the configured effort (may be undefined)', () => {
    expect(resolveAgentEffort(def({ effort: 'high' }), false)).toBe('high');
    expect(resolveAgentEffort(def({}), false)).toBeUndefined();
  });

  it('max mode: without a maxMode.effort the normal effort is kept', () => {
    expect(resolveAgentEffort(def({ effort: 'high' }), true)).toBe('high');
    expect(resolveAgentEffort(def({ isPm: true, effort: 'high' }), true)).toBe('high');
    expect(resolveAgentEffort(def({}), true)).toBeUndefined();
  });

  it('max mode: an explicit maxMode.effort wins for any agent', () => {
    expect(resolveAgentEffort(def({ effort: 'high', maxMode: { effort: 'max' } }), true)).toBe('max');
    expect(resolveAgentEffort(def({ isPm: true, maxMode: { effort: 'xhigh' } }), true)).toBe('xhigh');
    expect(resolveAgentEffort(def({ effort: 'high', maxMode: { effort: 'max' } }), false)).toBe('high'); // off → ignored
  });
});
