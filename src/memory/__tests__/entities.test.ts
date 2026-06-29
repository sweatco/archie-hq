/**
 * Entity Store Tests
 *
 * Mocks paths.js so reads/writes land in a temp directory. Exercises
 * parse/serialize round-trips, alias resolution, and applyEntityUpdate's
 * resolve-or-create + sanitize + auto-touched_by behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let entitiesDir: string;
let entityCap = 300;
let entityObsCap = 30;

vi.mock('../paths.js', () => ({
  getEntitiesDir: () => entitiesDir,
  getEntityIndexPath: () => join(entitiesDir, 'index.md'),
  getEntityPath: (slug: string) => join(entitiesDir, `${slug}.md`),
  getEntityCap: () => entityCap,
  getEntityInjectMax: () => 8,
  getOrgInjectMax: () => 8,
  getEntityObsCap: () => entityObsCap,
  isValidEntitySlug: (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) && s !== 'index',
}));

vi.mock('../../system/logger.js', () => ({
  logger: { system: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  parseEntity,
  serializeEntity,
  readEntity,
  writeEntity,
  listEntities,
  resolveEntity,
  applyEntityUpdate,
} from '../entities.js';
import type { EntityRecord } from '../types.js';

const REC: EntityRecord = {
  entity: 'payment-service',
  type: 'service',
  displayName: 'Payment Service',
  aliases: ['payments-api'],
  scope: 'repo',
  repos: ['backend'],
  domain: 'engineering',
  status: 'active',
  summary: 'NestJS payments API',
  observations: [{ category: 'decision', text: 'chose idempotency keys', touched: '2026-06-01' }],
  relations: [
    { type: 'depends_on', target: 'postgres-prod' },
    { type: 'touched_by', target: 'task-1' },
  ],
};

describe('entity store', () => {
  beforeEach(async () => {
    entitiesDir = await mkdtemp(join(tmpdir(), 'archie-entities-test-'));
    entityCap = 300;
    entityObsCap = 30;
  });
  afterEach(async () => {
    await rm(entitiesDir, { recursive: true, force: true });
  });

  describe('parse/serialize', () => {
    it('round-trips a record through serialize → parse', () => {
      const parsed = parseEntity(serializeEntity(REC));
      expect(parsed).toEqual(REC);
    });

    it('returns null on content with no frontmatter', () => {
      expect(parseEntity('## Facts\n- [fact] x')).toBeNull();
    });

    it('coerces an unknown type/scope to safe defaults', () => {
      const md = [
        '---', 'entity: x', 'type: wizardry', 'display_name: "X"', 'aliases: []',
        'scope: galaxy', 'repos: []', 'domain: engineering', 'status: active', '---',
        '## Facts', '## Relations', '',
      ].join('\n');
      const parsed = parseEntity(md)!;
      expect(parsed.type).toBe('concept');
      expect(parsed.scope).toBe('org');
    });
  });

  describe('readEntity / writeEntity', () => {
    it('writes then reads back an equivalent record', async () => {
      await writeEntity(REC);
      expect(existsSync(join(entitiesDir, 'payment-service.md'))).toBe(true);
      expect(await readEntity('payment-service')).toEqual(REC);
    });

    it('readEntity returns null for a missing entity', async () => {
      expect(await readEntity('nope')).toBeNull();
    });
  });

  describe('resolveEntity', () => {
    it('resolves by canonical slug', async () => {
      const all = [REC];
      expect(resolveEntity('payment-service', all)?.entity).toBe('payment-service');
    });
    it('resolves by alias, case-insensitively', () => {
      expect(resolveEntity('Payments-API', [REC])?.entity).toBe('payment-service');
    });
    it('returns null when nothing matches', () => {
      expect(resolveEntity('unknown', [REC])).toBeNull();
    });
  });

  describe('applyEntityUpdate', () => {
    it('creates a new entity with sanitized fields and an auto touched_by edge', async () => {
      const applied = await applyEntityUpdate(
        {
          slug: 'payment-service',
          type: 'service',
          scope: 'repo',
          repos: ['backend'],
          summary: 'NestJS payments API',
          observations: [{ category: 'decision', text: 'chose idempotency keys' }],
          relations: [{ type: 'depends_on', target: 'postgres-prod' }],
        },
        'task-42',
        '2026-06-01',
      );
      expect(applied).toMatchObject({ slug: 'payment-service', created: true });
      const rec = (await readEntity('payment-service'))!;
      expect(rec.observations[0]).toEqual({ category: 'decision', text: 'chose idempotency keys', touched: '2026-06-01' });
      expect(rec.relations).toContainEqual({ type: 'touched_by', target: 'task-42' });
      expect(rec.relations).toContainEqual({ type: 'depends_on', target: 'postgres-prod' });
    });

    it('folds an update into an existing entity resolved by alias (no duplicate file)', async () => {
      await writeEntity(REC); // has alias payments-api
      const applied = await applyEntityUpdate(
        { slug: 'payments-api', observations: [{ category: 'fact', text: 'handles refunds' }] },
        'task-2',
        '2026-06-02',
      );
      expect(applied).toMatchObject({ slug: 'payment-service', created: false });
      expect(existsSync(join(entitiesDir, 'payments-api.md'))).toBe(false);
      const rec = (await readEntity('payment-service'))!;
      expect(rec.observations.map((o) => o.text)).toContain('handles refunds');
    });

    it('drops unknown relation types and observation categories (closed vocab)', async () => {
      await applyEntityUpdate(
        {
          slug: 'auth',
          type: 'service',
          observations: [
            { category: 'rumor', text: 'should be dropped' },
            { category: 'fact', text: 'kept fact' },
          ],
          relations: [
            { type: 'pwns', target: 'backend' },
            { type: 'depends_on', target: 'session-store' },
          ],
        },
        'task-3',
        '2026-06-03',
      );
      const rec = (await readEntity('auth'))!;
      expect(rec.observations.map((o) => o.text)).toEqual(['kept fact']);
      expect(rec.relations.filter((r) => r.type === 'depends_on')).toHaveLength(1);
      expect(rec.relations.some((r) => (r.type as string) === 'pwns')).toBe(false);
    });

    it('rejects a path-traversal slug — no file is written', async () => {
      const applied = await applyEntityUpdate(
        { slug: '../../etc/passwd', type: 'service', observations: [{ category: 'fact', text: 'x' }] },
        'task-4',
      );
      expect(applied).toBeNull();
      expect(await listEntities()).toHaveLength(0);
    });

    it('reports capExceeded when the entity count passes the soft cap', async () => {
      entityCap = 0;
      const applied = await applyEntityUpdate({ slug: 'thing', type: 'service' }, 'task-5');
      expect(applied?.capExceeded).toBe(true);
    });

    it('caps observations per page: keeps newest-touched, drops oldest, never drops relations', async () => {
      entityObsCap = 3;
      await applyEntityUpdate(
        { slug: 'svc', type: 'service', observations: [{ category: 'fact', text: 'f1' }], relations: [{ type: 'depends_on', target: 'db' }] },
        'task-1', '2026-01-01',
      );
      await applyEntityUpdate({ slug: 'svc', observations: [{ category: 'fact', text: 'f2' }] }, 'task-2', '2026-01-02');
      await applyEntityUpdate({ slug: 'svc', observations: [{ category: 'fact', text: 'f3' }] }, 'task-3', '2026-01-03');
      await applyEntityUpdate({ slug: 'svc', observations: [{ category: 'fact', text: 'f4' }] }, 'task-4', '2026-01-04');
      await applyEntityUpdate({ slug: 'svc', observations: [{ category: 'fact', text: 'f5' }] }, 'task-5', '2026-01-05');

      const rec = (await readEntity('svc'))!;
      const texts = rec.observations.map((o) => o.text);
      expect(texts).toHaveLength(3);
      expect(texts).toEqual(expect.arrayContaining(['f3', 'f4', 'f5']));
      expect(texts).not.toContain('f1');
      expect(texts).not.toContain('f2');
      // relations are not subject to the observation cap
      expect(rec.relations).toContainEqual({ type: 'depends_on', target: 'db' });
      expect(rec.relations.filter((r) => r.type === 'touched_by')).toHaveLength(5);
    });

    it('pickScope: repo-bearing → repo, explicit scope honored, org only as no-signal fallback', async () => {
      await applyEntityUpdate({ slug: 'svc-repo', type: 'service', repos: ['backend'] }, 'task-1', '2026-01-01');
      await applyEntityUpdate({ slug: 'svc-domain', type: 'service', scope: 'domain' }, 'task-1', '2026-01-01');
      await applyEntityUpdate({ slug: 'svc-bare', type: 'service' }, 'task-1', '2026-01-01');
      expect((await readEntity('svc-repo'))!.scope).toBe('repo');
      expect((await readEntity('svc-domain'))!.scope).toBe('domain');
      expect((await readEntity('svc-bare'))!.scope).toBe('org');
    });
  });
});
