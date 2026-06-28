/**
 * Pure formatting helpers for PR cards.
 *
 * Dependency-free (only a type import) so every surface shares it: the Slack
 * card builder, the CLI renderer, and the GitHub client's CI summary. Keeping
 * the text identical here is what makes the card read the same on Slack and the
 * CLI; emoji are supplied per-surface (Slack shortcodes vs. unicode) via the
 * `PrCardEmoji` set.
 */

import type { PrCardData } from '../types/task.js';

/** Emoji set for one surface. Slack uses `:shortcode:`; the CLI uses unicode. */
export interface PrCardEmoji {
  merged: string;
  closed: string;
  ciPending: string;
  ciPassed: string;
  ciFailed: string;
}

export const SLACK_PR_CARD_EMOJI: PrCardEmoji = {
  merged: ':large_purple_circle:',
  closed: ':no_entry_sign:',
  ciPending: ':hourglass:',
  ciPassed: ':white_check_mark:',
  ciFailed: ':x:',
};

export const CLI_PR_CARD_EMOJI: PrCardEmoji = {
  merged: '🟣',
  closed: '🚫',
  ciPending: '⏳',
  ciPassed: '✅',
  ciFailed: '❌',
};

/** Plain title line: `#482 fix/recovery-teardown-race`. Slack links the `#num`. */
export function prCardTitlePlain(card: PrCardData): string {
  return `#${card.prNumber} ${card.headRef}`;
}

/**
 * Subtitle: `<repo> · <status>`. For an open PR the status is the CI summary
 * (`:hourglass: CI checks (1/2)`), omitted when the PR has no checks; a
 * merged/closed PR shows its final state instead.
 */
export function prCardSubtitle(card: PrCardData, emoji: PrCardEmoji): string {
  const repo = card.repo.split('/').pop() || card.repo;
  if (card.state === 'merged') return `${repo} · ${emoji.merged} Merged`;
  if (card.state === 'closed') return `${repo} · ${emoji.closed} Closed`;
  if (card.ciTotal > 0) {
    const icon = card.ci === 'passed' ? emoji.ciPassed : card.ci === 'failed' ? emoji.ciFailed : emoji.ciPending;
    return `${repo} · ${icon} CI checks (${card.ciPassed}/${card.ciTotal})`;
  }
  return repo;
}

/**
 * Channel-agnostic change-detection key. Deliberately excludes PR title and
 * description so editing those never moves/refreshes the card; includes the
 * head branch, head sha (new commits), state, and the CI verdict + counts (so
 * each check completing flips it and the card updates).
 */
export function prCardFingerprint(card: PrCardData): string {
  return [card.state, card.headRef, card.head_sha, card.ci, card.ciPassed, card.ciTotal].join('|');
}

/**
 * Summarise a list of checks into a verdict plus counts.
 * Failure-class beats pending beats passed; `passed` counts checks that
 * concluded OK (success/skipped/neutral), so `passed/total` reads as a progress
 * fraction. Accepts the minimal `{ status, conclusion }` shape.
 */
export function summarizeCi(
  entries: ReadonlyArray<{ status: string; conclusion: string | null }>,
): { state: PrCardData['ci']; passed: number; total: number } {
  const total = entries.length;
  if (total === 0) return { state: 'none', passed: 0, total: 0 };
  const isFailure = (c: string | null) => c === 'failure' || c === 'timed_out' || c === 'action_required';
  let failed = 0;
  let pending = 0;
  let passed = 0;
  for (const e of entries) {
    if (isFailure(e.conclusion)) failed++;
    else if (e.status !== 'completed' || e.conclusion === null) pending++;
    else passed++;
  }
  const state: PrCardData['ci'] = failed > 0 ? 'failed' : pending > 0 ? 'pending' : 'passed';
  return { state, passed, total };
}
