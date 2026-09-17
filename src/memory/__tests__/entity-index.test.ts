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
  isValidEntitySlug: (slug: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) && slug !== 'index',
}));

vi.mock('../../system/logger.js', () => ({
  logger: { system: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { writeEntity } from '../entities.js';
import { rebuildIndex, readIndexMarkdown, renderIndex } from '../entity-index.js';
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

describe('entity index', () => {
  beforeEach(async () => {
    entitiesDir = await mkdtemp(join(tmpdir(), 'archie-entindex-test-'));
  });

  afterEach(async () => {
    await rm(entitiesDir, { recursive: true, force: true });
  });

  it('rebuilds a complete persisted index including archived entities', async () => {
    await writeEntity(rec({ entity: 'payment-service', summary: 'payments' }));
    await writeEntity(rec({ entity: 'retired-service', status: 'archived', summary: 'retired' }));
    await rebuildIndex();

    const markdown = await readIndexMarkdown();
    expect(markdown).toContain('[[payment-service]]');
    expect(markdown).toContain('[[retired-service]]');
  });

  it('rebuildIndex reflects the files', async () => {
    await writeEntity(rec({ entity: 'payment-service' }));
    await writeEntity(rec({ entity: 'stripe' }));
    await rebuildIndex();
    await rm(join(entitiesDir, 'stripe.md'));
    await rebuildIndex();

    const markdown = await readIndexMarkdown();
    expect(markdown).toContain('[[payment-service]]');
    expect(markdown).not.toContain('[[stripe]]');
  });

  it.each(['summary', 'displayName'] as const)('escapes backslashes and pipes in the %s cell', (field) => {
    const markdown = renderIndex([rec({ entity: 'payment-service', [field]: 'A\\|B' })]);
    expect(markdown).toContain('| A\\\\\\|B |');
  });

  it('sorts by latest touch descending, then slug, with undated records last', () => {
    const markdown = renderIndex([
      rec({ entity: 'undated' }),
      rec({ entity: 'zulu', observations: [{ category: 'fact', text: 'z', touched: '2026-09-15' }] }),
      rec({ entity: 'alpha', observations: [{ category: 'fact', text: 'a', touched: '2026-09-15' }] }),
      rec({ entity: 'older', observations: [{ category: 'fact', text: 'o', touched: '2026-09-14' }] }),
    ]);
    const slugs = markdown.split('\n').filter((line) => line.startsWith('| [[')).map((line) => line.match(/\[\[([^\]]+)/)![1]);
    expect(slugs).toEqual(['alpha', 'zulu', 'older', 'undated']);
  });

  it('keeps only complete rows and an omission notice within the budget', () => {
    const first = rec({ entity: 'alpha', summary: 'first' });
    const second = rec({ entity: 'bravo', summary: 'second' });
    const headerLength = renderIndex([]).length;
    const firstRowLength = renderIndex([first]).length - headerLength;
    const budget = headerLength + firstRowLength + '_Additional entities omitted._\n'.length;
    const markdown = renderIndex([first, second], budget);

    expect(markdown.length).toBeLessThanOrEqual(budget);
    expect(markdown).toContain('[[alpha]]');
    expect(markdown).not.toContain('[[bravo]]');
    expect(markdown).toContain('_Additional entities omitted._');
    expect(markdown.split('\n').filter((line) => line.startsWith('| [['))).toHaveLength(1);
  });

  it('never exceeds a finite budget when the omission notice cannot fit', () => {
    const markdown = renderIndex([rec({ entity: 'payment-service', summary: 'payments' })], 170);
    expect(markdown.length).toBeLessThanOrEqual(170);
  });
});
