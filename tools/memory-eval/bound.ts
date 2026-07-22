/**
 * memory:eval — worst-case injected-token bound (enablement gate).
 *
 * Every term goes through the EXPORTED production render path (renderEntityBlock,
 * renderUserPreferencesBlock, renderRecentActivityBlock) — never a
 * reimplementation — and uses the sensor's chars/4 rule so the bound stays
 * comparable with post-enablement telemetry. Budget values are read back
 * through the production flag accessors, so a misspelled env var surfaces as
 * the default it actually produced, not the value the operator thought they set.
 *
 * The user term is a true bound: runtime does not cap involved users, but a
 * user contributes at most one block, so the sum over every user file bounds
 * any spawn's user contribution.
 */

import {
  renderEntityBlock,
  renderUserPreferencesBlock,
  renderRecentActivityBlock,
  renderEntityIndexBlock,
  estimateTokens,
} from '../../src/memory/context.js';
import { renderIndex } from '../../src/memory/entity-index.js';
import {
  getOrgInjectMax,
  getEntityInjectMax,
  getTouchedByInjectMax,
} from '../../src/memory/paths.js';
import type { EntityRecord } from './types.js';

const tok = estimateTokens;

export interface WorstCaseBound {
  budgets: { orgInjectMax: number; entityInjectMax: number; touchedByInjectMax: number };
  indexTokens: number;
  largestOrgPage: { slug: string; tokens: number } | null;
  largestNonOrgPage: { slug: string; tokens: number } | null;
  orgTermTokens: number;
  nonOrgTermTokens: number;
  userBlocks: Array<{ id: string; tokens: number }>;
  userTermTokens: number;
  recentActivityTokens: number;
  totalTokens: number;
}

export function computeWorstCaseBound(
  records: EntityRecord[],
  users: Array<{ id: string; displayName: string; text: string }>,
  indexMarkdown: string,
  recentActivity: string,
): WorstCaseBound {
  const budgets = {
    orgInjectMax: getOrgInjectMax(),
    entityInjectMax: getEntityInjectMax(),
    touchedByInjectMax: getTouchedByInjectMax(),
  };

  const active = records.filter((r) => r.status !== 'archived');
  let largestOrg: { slug: string; tokens: number } | null = null;
  let largestNonOrg: { slug: string; tokens: number } | null = null;
  for (const r of active) {
    // Rendered bytes AFTER touched_by truncation — the bytes injection produces.
    const t = tok(renderEntityBlock(r));
    if (r.scope === 'org') {
      if (!largestOrg || t > largestOrg.tokens) largestOrg = { slug: r.entity, tokens: t };
    } else if (!largestNonOrg || t > largestNonOrg.tokens) {
      largestNonOrg = { slug: r.entity, tokens: t };
    }
  }

  const userBlocks = users
    .filter((u) => u.text.trim())
    .map((u) => ({
      id: u.id,
      tokens: tok(renderUserPreferencesBlock({ userId: u.id, displayName: u.displayName }, u.text)),
    }));

  const indexMd = indexMarkdown.trim() || renderIndex(records).trim();
  const indexTokens = indexMd ? tok(renderEntityIndexBlock(indexMd)) : 0;
  const recentActivityTokens = recentActivity.trim() ? tok(renderRecentActivityBlock(recentActivity)) : 0;

  const orgTermTokens = (largestOrg?.tokens ?? 0) * budgets.orgInjectMax;
  const nonOrgTermTokens = (largestNonOrg?.tokens ?? 0) * budgets.entityInjectMax;
  const userTermTokens = userBlocks.reduce((a, b) => a + b.tokens, 0);

  return {
    budgets,
    indexTokens,
    largestOrgPage: largestOrg,
    largestNonOrgPage: largestNonOrg,
    orgTermTokens,
    nonOrgTermTokens,
    userBlocks,
    userTermTokens,
    recentActivityTokens,
    totalTokens: indexTokens + orgTermTokens + nonOrgTermTokens + userTermTokens + recentActivityTokens,
  };
}
