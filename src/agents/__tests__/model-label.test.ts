/**
 * Unit tests for the footer model helpers: beautified labels (drop `claude-`,
 * capitalised family, dotted version, `(1M)` marker) and the shared
 * resolveAgentModel default rule.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import { modelDisplayLabel, resolveAgentModel, resolveAgentEffort, modelChangingAgentIds } from '../model-label.js';

// The ARCHIE_MAX_MODE_* env overrides are read at call time; unstub after each test.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('modelDisplayLabel', () => {
  it('derives family + version from a concrete claude id (no per-version table)', () => {
    expect(modelDisplayLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelDisplayLabel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelDisplayLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelDisplayLabel('claude-fable-5')).toBe('Fable 5');
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

  const repo = { repos: [{ github: 'o/r', baseBranch: 'main', autoMerge: false }], primary: 'o/r' };

  it('max mode: leaves the model unchanged without a frontmatter or env override', () => {
    // the built-in max-mode default is effort-only, so the model is untouched
    expect(resolveAgentModel(def({ model: 'opus', repo }), true)).toBe('opus');
    expect(resolveAgentModel(def({ isPm: false }), true)).toBe('sonnet[1m]');
    expect(resolveAgentModel(def({ isPm: true }), true)).toBe('opus');
  });

  it('max mode: an explicit frontmatter maxMode.model wins for any agent', () => {
    expect(resolveAgentModel(def({ model: 'opus', repo, maxMode: { model: 'claude-fable-5' } }), true)).toBe('claude-fable-5');
    expect(resolveAgentModel(def({ maxMode: { model: 'claude-fable-5' } }), true)).toBe('claude-fable-5'); // generic too
    expect(resolveAgentModel(def({ model: 'opus', repo, maxMode: { model: 'claude-fable-5' } }), false)).toBe('opus'); // off → ignored
  });

  it('max mode: ARCHIE_MAX_MODE_MODEL is a fallback for repo/dynamic agents only', () => {
    vi.stubEnv('ARCHIE_MAX_MODE_MODEL', 'claude-fable-5');
    expect(resolveAgentModel(def({ model: 'opus', repo }), true)).toBe('claude-fable-5'); // repo picks up env
    expect(resolveAgentModel(def({ isPm: false }), true)).toBe('sonnet[1m]');              // generic unaffected
    expect(resolveAgentModel(def({ isPm: true }), true)).toBe('opus');                     // PM unaffected
    expect(resolveAgentModel(def({ repo, maxMode: { model: 'claude-opus-4-8' } }), true)).toBe('claude-opus-4-8'); // frontmatter wins
  });
});

describe('resolveAgentEffort', () => {
  const repo = { repos: [{ github: 'o/r', baseBranch: 'main', autoMerge: false }], primary: 'o/r' };
  const def = (over: Partial<AgentDef>): AgentDef => ({
    id: 'x-agent', key: 'x', role: '', expertise: '', pluginName: 'p', ...over,
  } as AgentDef);

  it('off max mode: returns the configured effort (may be undefined)', () => {
    expect(resolveAgentEffort(def({ repo, effort: 'high' }), false)).toBe('high');
    expect(resolveAgentEffort(def({ effort: 'high' }), false)).toBe('high');
    expect(resolveAgentEffort(def({ repo }), false)).toBeUndefined();
  });

  it('max mode: repo/dynamic agents default to max effort', () => {
    expect(resolveAgentEffort(def({ repo }), true)).toBe('max');
    expect(resolveAgentEffort(def({ repo, effort: 'high' }), true)).toBe('max');
  });

  it('max mode: generic agents and the PM keep their normal effort', () => {
    expect(resolveAgentEffort(def({ effort: 'high' }), true)).toBe('high');
    expect(resolveAgentEffort(def({ isPm: true, effort: 'high' }), true)).toBe('high');
    expect(resolveAgentEffort(def({}), true)).toBeUndefined();
  });

  it('max mode: an explicit frontmatter maxMode.effort wins for any agent', () => {
    expect(resolveAgentEffort(def({ repo, maxMode: { effort: 'high' } }), true)).toBe('high');
    expect(resolveAgentEffort(def({ maxMode: { effort: 'max' } }), true)).toBe('max'); // generic
  });

  it('max mode: ARCHIE_MAX_MODE_EFFORT overrides the repo default (repo/dynamic only)', () => {
    vi.stubEnv('ARCHIE_MAX_MODE_EFFORT', 'high');
    expect(resolveAgentEffort(def({ repo }), true)).toBe('high');
    expect(resolveAgentEffort(def({ effort: 'low' }), true)).toBe('low'); // generic unaffected by env
    vi.stubEnv('ARCHIE_MAX_MODE_EFFORT', 'bogus');
    expect(resolveAgentEffort(def({ repo }), true)).toBe('max'); // invalid env ignored → max default
  });
});

describe('modelChangingAgentIds', () => {
  const repo = { repos: [{ github: 'o/r', baseBranch: 'main', autoMerge: false }], primary: 'o/r' };
  const def = (over: Partial<AgentDef>): AgentDef => ({
    id: 'x-agent', key: 'x', role: '', expertise: '', pluginName: 'p', ...over,
  } as AgentDef);

  it('selects only non-PM agents whose model changes under max mode', () => {
    const team = [
      def({ id: 'pm-agent', isPm: true }),                                                    // PM — excluded
      def({ id: 'backend-agent', model: 'opus', repo, maxMode: { model: 'claude-fable-5' } }), // model swap → included
      def({ id: 'infra-agent', model: 'opus', repo }),                                        // repo, effort-only default → NOT included
      def({ id: 'copywriter-agent' }),                                                        // generic, unchanged → NOT included
    ];
    expect(modelChangingAgentIds(team)).toEqual(['backend-agent']);
  });

  it('includes repo/dynamic agents that swap via env, but not generic agents or the PM', () => {
    vi.stubEnv('ARCHIE_MAX_MODE_MODEL', 'claude-fable-5');
    const team = [
      def({ id: 'dyn-agent', model: 'opus', repo }), // repo/dynamic → env swap → included
      def({ id: 'copywriter-agent' }),               // generic → env doesn't apply → NOT included
      def({ id: 'pm-agent', isPm: true }),           // PM → excluded
    ];
    expect(modelChangingAgentIds(team)).toEqual(['dyn-agent']);
  });
});
