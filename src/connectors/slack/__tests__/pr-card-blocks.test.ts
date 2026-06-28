/**
 * Unit tests for buildPrCardBlocks — the Slack `card` block: title row with the
 * linked PR number + head branch, and a subtitle with the CI summary.
 */

import { describe, it, expect } from 'vitest';
import type { PrCardData } from '../../../types/task.js';
import { buildPrCardBlocks } from '../client.js';

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

function card(c: PrCardData) {
  const blocks = buildPrCardBlocks(c) as Array<{
    type: string;
    title?: { type: string; text: string };
    subtitle?: { type: string; text: string };
  }>;
  return { block: blocks[0], title: blocks[0].title!.text, subtitle: blocks[0].subtitle!.text };
}

describe('buildPrCardBlocks', () => {
  it('emits a single card block with linked #number + branch title and a CI subtitle', () => {
    const { block, title, subtitle } = card(baseCard);
    expect(block.type).toBe('card');
    expect(block.title!.type).toBe('mrkdwn');
    expect(title).toBe('<https://github.com/sweatco/sweatcoin-mobile/pull/6543|#6543> fix/recovery-teardown-race');
    expect(subtitle).toBe('sweatcoin-mobile · :hourglass: CI checks (1/2)');
  });

  it('uses Slack emoji shortcodes for passed / failed / merged', () => {
    expect(card({ ...baseCard, ci: 'passed', ciPassed: 2 }).subtitle).toBe('sweatcoin-mobile · :white_check_mark: CI checks (2/2)');
    expect(card({ ...baseCard, ci: 'failed', ciPassed: 1 }).subtitle).toBe('sweatcoin-mobile · :x: CI checks (1/2)');
    expect(card({ ...baseCard, state: 'merged' }).subtitle).toBe('sweatcoin-mobile · :large_purple_circle: Merged');
  });

  it('escapes mrkdwn-special characters in the branch name', () => {
    const { title } = card({ ...baseCard, headRef: 'feat/<x>&<y>' });
    expect(title).toContain('feat/&lt;x&gt;&amp;&lt;y&gt;');
    expect(title).not.toContain('<x>');
  });
});
