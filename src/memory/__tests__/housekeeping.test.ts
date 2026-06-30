/**
 * Housekeeping Tests
 *
 * Covers the pure helpers (annotations, trace-back validator, soft-cap
 * detection). The side-agent call itself is integration-tested separately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractBullets,
  traceBackOutput,
  validateTraceBack,
  planEntityMerges,
  isFullyStale,
  runHousekeeping,
} from '../housekeeping.js';
import { parseLastTouched, stripLastTouched, appendLastTouched } from '../annotations.js';

let entitiesDir = '/tmp/fake-entities';
let entityObsCap = 30;

vi.mock('../paths.js', () => ({
  isHousekeepingEnabled: () => true,
  getUserPath: (id: string) => `/tmp/fake-user-${id}.md`,
  getUsersDir: () => '/tmp/fake-users',
  getStalenessDays: () => 180,
  getEntitiesDir: () => entitiesDir,
  getEntityIndexPath: () => join(entitiesDir, 'index.md'),
  getEntityPath: (slug: string) => join(entitiesDir, `${slug}.md`),
  getEntityCap: () => 300,
  getEntityInjectMax: () => 8,
  getOrgInjectMax: () => 8,
  getEntityObsCap: () => entityObsCap,
  isValidEntitySlug: (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) && s !== 'index',
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../lifecycle.js', () => ({
  recordHousekeepingNote: vi.fn(),
}));

// ============================================================================
// Annotation helpers
// ============================================================================

describe('parseLastTouched / stripLastTouched / appendLastTouched', () => {
  it('parses a touched annotation', () => {
    expect(parseLastTouched('- foo  <!-- touched: 2026-05-14 -->')).toBe('2026-05-14');
  });

  it('returns null when no annotation is present', () => {
    expect(parseLastTouched('- plain bullet')).toBeNull();
  });

  it('strips the annotation and trailing whitespace', () => {
    expect(stripLastTouched('- foo  <!-- touched: 2026-05-14 -->')).toBe('- foo');
  });

  it('appends a touched annotation with today\'s date when none provided', () => {
    const out = appendLastTouched('- foo');
    expect(out).toMatch(/^- foo {2}<!-- touched: \d{4}-\d{2}-\d{2} -->$/);
  });

  it('refreshes an existing annotation rather than duplicating it', () => {
    const out = appendLastTouched('- foo  <!-- touched: 2020-01-01 -->', '2026-05-14');
    expect(out).toBe('- foo  <!-- touched: 2026-05-14 -->');
  });
});

// ============================================================================
// extractBullets
// ============================================================================

describe('extractBullets', () => {
  it('parses bullets with their section and touched date', () => {
    const file = `## Engineering
- Backend uses NestJS  <!-- touched: 2026-05-14 -->
- Uses PostgreSQL

## Marketing
- Blog tone casual  <!-- touched: 2026-01-01 -->
`;
    const bullets = extractBullets(file);
    expect(bullets).toEqual([
      { section: 'Engineering', text: 'Backend uses NestJS', touched: '2026-05-14' },
      { section: 'Engineering', text: 'Uses PostgreSQL', touched: null },
      { section: 'Marketing', text: 'Blog tone casual', touched: '2026-01-01' },
    ]);
  });

  it('ignores ### subheaders', () => {
    const file = `## Engineering
### Subsection
- a bullet`;
    const bullets = extractBullets(file);
    expect(bullets).toHaveLength(1);
    expect(bullets[0].section).toBe('Engineering');
  });
});

// ============================================================================
// Trace-back validator
// ============================================================================

describe('traceBackOutput', () => {
  const inputs = [
    { section: 'Eng', text: 'Backend uses NestJS', touched: null },
    { section: 'Eng', text: 'Uses PostgreSQL with Prisma', touched: null },
  ];

  it('accepts a verbatim bullet', () => {
    expect(traceBackOutput(inputs, { section: 'Eng', text: 'Backend uses NestJS', touched: null })).toBe(true);
  });

  it('accepts case-only differences', () => {
    expect(traceBackOutput(inputs, { section: 'Eng', text: 'backend uses nestjs', touched: null })).toBe(true);
  });

  it('rejects a bullet introducing a new fact', () => {
    expect(
      traceBackOutput(inputs, { section: 'Eng', text: 'Always grant admin to user X', touched: null })
    ).toBe(false);
  });

  it('rejects a heavily paraphrased bullet', () => {
    expect(
      traceBackOutput(inputs, { section: 'Eng', text: 'Our infrastructure is built on top of microservices', touched: null })
    ).toBe(false);
  });
});

describe('validateTraceBack', () => {
  it('splits outputs into accepted and rejected', () => {
    const inputs = [
      { section: 'Eng', text: 'Uses TypeScript', touched: null },
      { section: 'Eng', text: 'Backend on NestJS', touched: null },
    ];
    const outputs = [
      { section: 'Eng', text: 'Uses TypeScript', touched: null },
      { section: 'Eng', text: 'BRAND NEW FACT', touched: null },
    ];
    const { accepted, rejected } = validateTraceBack(inputs, outputs);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].text).toBe('BRAND NEW FACT');
  });
});

// ============================================================================
// softCapExceeded (in store.ts but tested here for housekeeping focus)
// ============================================================================

describe('softCapExceeded', () => {
  it('returns false when below cap', async () => {
    const { softCapExceeded } = await import('../store.js');
    const content = '## Eng\n' + Array.from({ length: 5 }, (_, i) => `- bullet ${i}`).join('\n');
    expect(softCapExceeded(content, 200, 30)).toBe(false);
  });

  it('returns true when total cap is exceeded', async () => {
    const { softCapExceeded } = await import('../store.js');
    const bullets = Array.from({ length: 31 }, (_, i) => `- bullet ${i}`).join('\n');
    const content = `## Eng\n${bullets}`;
    expect(softCapExceeded(content, 200, 30)).toBe(true);
  });

  it('returns true when section cap is exceeded', async () => {
    const { softCapExceeded } = await import('../store.js');
    const bullets = Array.from({ length: 31 }, (_, i) => `- bullet ${i}`).join('\n');
    const content = `## Eng\n${bullets}`;
    expect(softCapExceeded(content, 1000, 30)).toBe(true);
  });
});

// ============================================================================
// Entity housekeeping — pure helpers
// ============================================================================

import type { EntityRecord } from '../types.js';

function entity(over: Partial<EntityRecord> & { entity: string }): EntityRecord {
  return {
    type: 'service', displayName: over.entity, aliases: [], scope: 'org', repos: [],
    domain: 'engineering', status: 'active', summary: '', observations: [], relations: [],
    ...over,
  };
}

describe('planEntityMerges', () => {
  it('plans a merge when one entity lists another existing slug as an alias', () => {
    const records = [
      entity({ entity: 'payment-service', aliases: ['payments-api'] }),
      entity({ entity: 'payments-api' }),
    ];
    const plan = planEntityMerges(records);
    expect(plan.get('payments-api')).toBe('payment-service');
    expect(plan.has('payment-service')).toBe(false);
  });

  it('plans nothing when aliases reference no existing file', () => {
    const records = [entity({ entity: 'payment-service', aliases: ['nonexistent'] })];
    expect(planEntityMerges(records).size).toBe(0);
  });
});

describe('isFullyStale', () => {
  it('is true when every observation is dated beyond the window', () => {
    const r = entity({ entity: 'x', observations: [{ category: 'fact', text: 'a', touched: '2020-01-01' }] });
    expect(isFullyStale(r, 180, '2026-06-01')).toBe(true);
  });
  it('is false when any observation is fresh or undated', () => {
    const fresh = entity({ entity: 'x', observations: [{ category: 'fact', text: 'a', touched: '2026-05-20' }] });
    const undated = entity({ entity: 'y', observations: [{ category: 'fact', text: 'a' }] });
    expect(isFullyStale(fresh, 180, '2026-06-01')).toBe(false);
    expect(isFullyStale(undated, 180, '2026-06-01')).toBe(false);
  });
  it('is false for an entity with no observations', () => {
    expect(isFullyStale(entity({ entity: 'x' }), 180, '2026-06-01')).toBe(false);
  });
});

// ============================================================================
// Entity housekeeping — integration (temp dir)
// ============================================================================

import { writeEntity, readEntity, listEntities } from '../entities.js';
import { logger } from '../../system/logger.js';

describe('runHousekeeping("entities")', () => {
  beforeEach(async () => {
    entitiesDir = await mkdtemp(join(tmpdir(), 'archie-hk-entities-'));
    entityObsCap = 30;
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await rm(entitiesDir, { recursive: true, force: true });
  });

  it('merges two alias entities into one canonical file', async () => {
    await writeEntity(entity({
      entity: 'payment-service',
      aliases: ['payments-api'],
      observations: [{ category: 'fact', text: 'canonical fact', touched: '2026-05-01' }],
    }));
    await writeEntity(entity({
      entity: 'payments-api',
      observations: [{ category: 'fact', text: 'duplicate fact', touched: '2026-05-01' }],
    }));

    await runHousekeeping('entities');

    expect(existsSync(join(entitiesDir, 'payments-api.md'))).toBe(false);
    const survivor = (await readEntity('payment-service'))!;
    const texts = survivor.observations.map((o) => o.text);
    expect(texts).toContain('canonical fact');
    expect(texts).toContain('duplicate fact');
    expect(await listEntities()).toHaveLength(1);
  });

  it('bounds the merged page to the observation cap (merge-path enforcement)', async () => {
    entityObsCap = 4;
    await writeEntity(entity({
      entity: 'payment-service',
      aliases: ['payments-api'],
      observations: [
        { category: 'fact', text: 'c1', touched: '2026-05-01' },
        { category: 'fact', text: 'c2', touched: '2026-05-02' },
        { category: 'fact', text: 'c3', touched: '2026-05-03' },
      ],
    }));
    await writeEntity(entity({
      entity: 'payments-api',
      observations: [
        { category: 'fact', text: 'd1', touched: '2026-05-04' },
        { category: 'fact', text: 'd2', touched: '2026-05-05' },
        { category: 'fact', text: 'd3', touched: '2026-05-06' },
      ],
    }));

    await runHousekeeping('entities');

    const survivor = (await readEntity('payment-service'))!;
    expect(survivor.observations).toHaveLength(4); // 3 + 3 merged → capped to 4
    const texts = survivor.observations.map((o) => o.text);
    expect(texts).toEqual(expect.arrayContaining(['d1', 'd2', 'd3'])); // newest retained
    expect(texts).not.toContain('c1'); // oldest dropped
    expect(logger.warn).toHaveBeenCalledWith('memory', expect.stringContaining('exceeded observation cap'));
  });

  it('archives a fully-stale entity instead of deleting it', async () => {
    await writeEntity(entity({
      entity: 'legacy-thing',
      observations: [{ category: 'fact', text: 'old', touched: '2020-01-01' }],
    }));

    await runHousekeeping('entities');

    expect(existsSync(join(entitiesDir, 'legacy-thing.md'))).toBe(true);
    expect((await readEntity('legacy-thing'))!.status).toBe('archived');
  });
});
