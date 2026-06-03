/**
 * Entity Index + Selection Tests
 *
 * rebuildIndex/readIndexMarkdown use a temp dir (paths mocked). selectEntities
 * is pure and is exercised with hand-built records covering the spec scenarios:
 * org-always, repo match, one-hop expansion, bound + logged drops, archived
 * excluded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let entitiesDir: string;

vi.mock('../paths.js', () => ({
  getEntitiesDir: () => entitiesDir,
  getEntityIndexPath: () => join(entitiesDir, 'index.md'),
  getEntityPath: (slug: string) => join(entitiesDir, `${slug}.md`),
  getEntityCap: () => 300,
  getEntityInjectMax: () => 8,
  isValidEntitySlug: (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) && s !== 'index',
}));

vi.mock('../../system/logger.js', () => ({
  logger: { system: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { writeEntity } from '../entities.js';
import { rebuildIndex, readIndexMarkdown, selectEntities } from '../entity-index.js';
import type { EntityRecord } from '../types.js';

function rec(over: Partial<EntityRecord> & { entity: string }): EntityRecord {
  return {
    type: 'service',
    displayName: over.entity,
    aliases: [],
    scope: 'repo',
    repos: [],
    domain: 'engineering',
    status: 'active',
    summary: '',
    observations: [],
    relations: [],
    ...over,
  };
}

describe('entity index (derived)', () => {
  beforeEach(async () => {
    entitiesDir = await mkdtemp(join(tmpdir(), 'archie-entindex-test-'));
  });
  afterEach(async () => {
    await rm(entitiesDir, { recursive: true, force: true });
  });

  it('rebuildIndex writes one row per entity and is readable', async () => {
    await writeEntity(rec({ entity: 'payment-service', summary: 'payments' }));
    await writeEntity(rec({ entity: 'stripe', type: 'integration', scope: 'org', summary: 'processor' }));
    await rebuildIndex();

    const md = await readIndexMarkdown();
    expect(md).toContain('[[payment-service]]');
    expect(md).toContain('[[stripe]]');
    const rows = md.split('\n').filter((l) => l.startsWith('| [['));
    expect(rows).toHaveLength(2);
  });

  it('rebuildIndex reflects the files — a deleted entity drops out', async () => {
    await writeEntity(rec({ entity: 'payment-service' }));
    await writeEntity(rec({ entity: 'stripe' }));
    await rebuildIndex();
    await rm(join(entitiesDir, 'stripe.md'));
    await rebuildIndex();

    const md = await readIndexMarkdown();
    expect(md).toContain('[[payment-service]]');
    expect(md).not.toContain('[[stripe]]');
  });
});

describe('selectEntities (push selection)', () => {
  it('always includes scope:org entities', () => {
    const records = [
      rec({ entity: 'stripe', scope: 'org' }),
      rec({ entity: 'mobile-app', scope: 'repo', repos: ['mobile'] }),
    ];
    const { selected } = selectEntities(records, { repo: 'backend' });
    const slugs = selected.map((r) => r.entity);
    expect(slugs).toContain('stripe');
    expect(slugs).not.toContain('mobile-app');
  });

  it('includes entities tagged to the spawned repo', () => {
    const records = [
      rec({ entity: 'payment-service', scope: 'repo', repos: ['backend'] }),
      rec({ entity: 'mobile-app', scope: 'repo', repos: ['mobile'] }),
    ];
    const { selected } = selectEntities(records, { repo: 'backend' });
    expect(selected.map((r) => r.entity)).toEqual(['payment-service']);
  });

  it('expands one hop along relations', () => {
    const records = [
      rec({ entity: 'payment-service', scope: 'repo', repos: ['backend'], relations: [{ type: 'depends_on', target: 'postgres-prod' }] }),
      rec({ entity: 'postgres-prod', scope: 'repo', repos: ['infra'] }),
    ];
    const { selected } = selectEntities(records, { repo: 'backend' });
    expect(selected.map((r) => r.entity).sort()).toEqual(['payment-service', 'postgres-prod']);
  });

  it('bounds non-org selection to max and reports dropped slugs', () => {
    const records = [
      rec({ entity: 'a', scope: 'domain', displayName: 'alpha bravo' }),
      rec({ entity: 'b', scope: 'domain', displayName: 'alpha bravo' }),
      rec({ entity: 'c', scope: 'domain', displayName: 'alpha bravo' }),
    ];
    // All three score on the title tokens; max=2 keeps the top 2, drops 1.
    const { selected, dropped } = selectEntities(records, { taskTitle: 'alpha bravo' }, 2);
    expect(selected).toHaveLength(2);
    expect(dropped).toHaveLength(1);
    expect([...selected.map((r) => r.entity), ...dropped].sort()).toEqual(['a', 'b', 'c']);
  });

  it('exempts scope:org entities from the page bound (org knowledge stays always-on)', () => {
    const records = [
      rec({ entity: 'a', scope: 'org' }),
      rec({ entity: 'b', scope: 'org' }),
      rec({ entity: 'c', scope: 'org' }),
    ];
    // Even with max=1, every org page is injected; none are dropped.
    const { selected, dropped } = selectEntities(records, {}, 1);
    expect(selected.map((r) => r.entity).sort()).toEqual(['a', 'b', 'c']);
    expect(dropped).toEqual([]);
  });

  it('applies the bound only to non-org pages; org pages are always kept', () => {
    const records = [
      rec({ entity: 'org1', scope: 'org' }),
      rec({ entity: 'org2', scope: 'org' }),
      rec({ entity: 'r1', scope: 'repo', repos: ['backend'] }),
      rec({ entity: 'r2', scope: 'repo', repos: ['backend'] }),
    ];
    const { selected, dropped } = selectEntities(records, { repo: 'backend' }, 1);
    const slugs = selected.map((r) => r.entity);
    expect(slugs).toContain('org1');
    expect(slugs).toContain('org2');
    expect(dropped).toHaveLength(1);
    expect(['r1', 'r2']).toContain(dropped[0]);
  });

  it('never injects archived entities', () => {
    const records = [
      rec({ entity: 'old', scope: 'org', status: 'archived' }),
      rec({ entity: 'live', scope: 'org' }),
    ];
    const { selected } = selectEntities(records, {});
    expect(selected.map((r) => r.entity)).toEqual(['live']);
  });

  it('scores by task-title token overlap', () => {
    const records = [
      rec({ entity: 'payment-service', scope: 'domain', displayName: 'Payment Service', summary: 'handles payments' }),
      rec({ entity: 'unrelated-thing', scope: 'domain', displayName: 'Unrelated Thing' }),
    ];
    const { selected } = selectEntities(records, { taskTitle: 'fix the payment flow' });
    expect(selected.map((r) => r.entity)).toContain('payment-service');
    expect(selected.map((r) => r.entity)).not.toContain('unrelated-thing');
  });
});
