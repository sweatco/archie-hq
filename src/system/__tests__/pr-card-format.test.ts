/**
 * Unit tests for the pure PR-card helpers: CI summary (verdict + counts),
 * fingerprint change-detection, and the title/subtitle text shared by Slack and
 * the CLI.
 */

import { describe, it, expect } from 'vitest';
import type { PrCardData } from '../../types/task.js';
import {
  summarizeCi,
  prCardFingerprint,
  prCardTitlePlain,
  prCardSubtitle,
  CLI_PR_CARD_EMOJI,
} from '../pr-card-format.js';

const baseCard: PrCardData = {
  repo: 'sweatco/sweatcoin-mobile',
  prNumber: 6543,
  url: 'https://github.com/sweatco/sweatcoin-mobile/pull/6543',
  headRef: 'fix/recovery-teardown-race',
  state: 'open',
  head_sha: 'abc1234',
  ci: 'pending',
  ciPassed: 1,
  ciTotal: 2,
};

const completed = (conclusion: string | null) => ({ status: 'completed', conclusion });

describe('summarizeCi', () => {
  it('returns none/0/0 when there are no checks', () => {
    expect(summarizeCi([])).toEqual({ state: 'none', passed: 0, total: 0 });
  });

  it('counts passed out of total when all succeed', () => {
    expect(summarizeCi([completed('success'), completed('skipped')])).toEqual({ state: 'passed', passed: 2, total: 2 });
  });

  it('reports pending with a partial passed count while checks run', () => {
    expect(summarizeCi([completed('success'), { status: 'in_progress', conclusion: null }]))
      .toEqual({ state: 'pending', passed: 1, total: 2 });
  });

  it('reports failed when any check is a failure class', () => {
    expect(summarizeCi([completed('success'), completed('failure')])).toEqual({ state: 'failed', passed: 1, total: 2 });
    expect(summarizeCi([completed('timed_out')])).toEqual({ state: 'failed', passed: 0, total: 1 });
  });
});

describe('prCardFingerprint', () => {
  it('changes when state, branch, sha, or CI counts change', () => {
    const fp = prCardFingerprint(baseCard);
    expect(prCardFingerprint({ ...baseCard })).toBe(fp);
    expect(prCardFingerprint({ ...baseCard, ci: 'passed', ciPassed: 2 })).not.toBe(fp);
    expect(prCardFingerprint({ ...baseCard, ciTotal: 3 })).not.toBe(fp);
    expect(prCardFingerprint({ ...baseCard, state: 'merged' })).not.toBe(fp);
    expect(prCardFingerprint({ ...baseCard, head_sha: 'def5678' })).not.toBe(fp);
    expect(prCardFingerprint({ ...baseCard, headRef: 'other' })).not.toBe(fp);
  });
});

describe('prCardTitlePlain', () => {
  it('renders the PR number and head branch', () => {
    expect(prCardTitlePlain(baseCard)).toBe('#6543 fix/recovery-teardown-race');
  });
});

describe('prCardSubtitle', () => {
  const e = CLI_PR_CARD_EMOJI;

  it('shows repo (short name) and a CI summary for an open PR with checks', () => {
    expect(prCardSubtitle(baseCard, e)).toBe('sweatcoin-mobile · ⏳ CI checks (1/2)');
    expect(prCardSubtitle({ ...baseCard, ci: 'passed', ciPassed: 2 }, e)).toBe('sweatcoin-mobile · ✅ CI checks (2/2)');
    expect(prCardSubtitle({ ...baseCard, ci: 'failed', ciPassed: 1 }, e)).toBe('sweatcoin-mobile · ❌ CI checks (1/2)');
  });

  it('shows just the repo when an open PR has no checks', () => {
    expect(prCardSubtitle({ ...baseCard, ci: 'none', ciPassed: 0, ciTotal: 0 }, e)).toBe('sweatcoin-mobile');
  });

  it('shows the final state for merged / closed PRs', () => {
    expect(prCardSubtitle({ ...baseCard, state: 'merged' }, e)).toBe('sweatcoin-mobile · 🟣 Merged');
    expect(prCardSubtitle({ ...baseCard, state: 'closed' }, e)).toBe('sweatcoin-mobile · 🚫 Closed');
  });
});
