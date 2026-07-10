/**
 * Memory Read Tools + Pull Sensor Tests
 *
 * Temp-dir store, mocked paths module (same pattern as context.test.ts),
 * mocked knowledge-log reader. Covers: search ranking + zero-result, guard
 * rejections, result bounds, archived marking, pull-record shape and
 * fail-safety, and the no-write tool surface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempDir: string;
let usersDir: string;
let entitiesDir: string;
let tasksDir: string;
let activityPath: string;
let telemetryBase: () => string;

const knowledgeLogs = new Map<string, string>();

vi.mock('../paths.js', () => ({
  isMemoryEnabled: () => true,
  isInjectionEnabled: () => false,
  isMemoryToolsEnabled: () => true,
  getUserPath: (id: string) => {
    const safe = id.includes(':') ? id.replace(':', '__') : id;
    return join(usersDir, `${safe}.md`);
  },
  getUsersDir: () => usersDir,
  getMemoryDir: () => tempDir,
  getRecentActivityPath: () => activityPath,
  getEntitiesDir: () => entitiesDir,
  getEntityIndexPath: () => join(entitiesDir, 'index.md'),
  getEntityPath: (slug: string) => join(entitiesDir, `${slug}.md`),
  getTasksDir: () => tasksDir,
  getSummaryPath: (taskId: string) => join(tasksDir, taskId, 'summary.md'),
  getTaskTelemetryPath: (taskId: string) => join(telemetryBase(), taskId, 'telemetry.jsonl'),
  getEntityCap: () => 300,
  getEntityInjectMax: () => 8,
  getOrgInjectMax: () => 8,
  getEntityObsCap: () => 30,
  getTouchedByInjectMax: () => 10,
  isAllowedTaskId: (t: string) => /^[A-Za-z0-9._\-]+$/.test(t),
  isAllowedUserId: (id: string) => /^(U|W|B|T)[A-Z0-9]{6,}$/.test(id) || /^(cli|local):[A-Za-z0-9_\-]+$/.test(id),
  isValidEntitySlug: (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) && s !== 'index',
}));

vi.mock('../../tasks/persistence.js', () => ({
  readKnowledgeLog: async (taskId: string) => knowledgeLogs.get(taskId) ?? '',
}));

import { buildMemoryTools, rankSearchHits, createMemoryToolsMcpServer, GREP_MAX_MATCHES, RESULT_MAX_CHARS } from '../tools.js';
import { appendTelemetry, recordPull } from '../telemetry.js';

const SPAWN = { taskId: 'task-spawn-1', agent: 'pm-agent' };

function entityMd(slug: string, opts: { scope?: string; status?: string; aliases?: string; facts?: string[]; relations?: string[]; summary?: string } = {}): string {
  return [
    '---',
    `entity: ${slug}`,
    'type: service',
    `display_name: "${slug}"`,
    `aliases: [${opts.aliases ?? ''}]`,
    `scope: ${opts.scope ?? 'repo'}`,
    'repos: [backend]',
    'domain: engineering',
    `status: ${opts.status ?? 'active'}`,
    '---',
    `<!-- L0: ${opts.summary ?? `${slug} summary`} -->`,
    '',
    '## Facts',
    ...(opts.facts ?? ['- [fact] does things  <!-- touched: 2026-06-01 -->']),
    '',
    '## Relations',
    ...(opts.relations ?? []),
    '',
  ].join('\n');
}

async function readTelemetry(taskId: string): Promise<any[]> {
  const path = join(telemetryBase(), taskId, 'telemetry.jsonl');
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf-8');
  return raw.trim().split('\n').map((l) => JSON.parse(l));
}

describe('memory read tools', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-tools-test-'));
    usersDir = join(tempDir, 'users');
    entitiesDir = join(tempDir, 'entities');
    tasksDir = join(tempDir, 'tasks');
    activityPath = join(tempDir, 'recent-activity.md');
    telemetryBase = () => tasksDir;
    knowledgeLogs.clear();

    await mkdir(usersDir, { recursive: true });
    await mkdir(entitiesDir, { recursive: true });
    await mkdir(tasksDir, { recursive: true });

    await writeFile(join(entitiesDir, 'payment-service.md'), entityMd('payment-service', {
      aliases: 'payments-api',
      summary: 'NestJS payments API, Stripe integration',
      facts: ['- [decision] chose idempotency keys for stripe webhooks  <!-- touched: 2026-06-01 -->'],
      relations: ['- depends_on [[postgres-prod]]'],
    }));
    await writeFile(join(entitiesDir, 'old-thing.md'), entityMd('old-thing', {
      status: 'archived',
      summary: 'retired subsystem',
    }));
    await writeFile(join(usersDir, 'U07ABC123.md'), [
      '---',
      'slack_user_id: U07ABC123',
      'display_name: "Dana"',
      'aliases: []',
      '---',
      '## Communication',
      '- Prefers concise Slack updates about payments  <!-- touched: 2026-05-14 -->',
      '',
    ].join('\n'));
    await mkdir(join(tasksDir, 'task-old-1'), { recursive: true });
    await writeFile(join(tasksDir, 'task-old-1', 'summary.md'), [
      '---',
      'task_id: task-old-1',
      '---',
      '',
      '# Summary',
      '',
      'Fixed stripe webhook retries in the payment flow.',
      '',
    ].join('\n'));
    await writeFile(activityPath, [
      '# Recent Activity',
      '',
      '| Date | Task ID | Summary | Domain | User |',
      '|------|---------|---------|--------|------|',
      '| 2026-06-02 | task-old-1 | Fixed stripe webhook retries | engineering | U07ABC123 |',
      '',
    ].join('\n'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ---- rankSearchHits (pure) ----

  it('ranks by overlap and searches entity facts text', () => {
    const hits = rankSearchHits(
      'stripe idempotency',
      [
        {
          entity: 'payment-service', type: 'service', displayName: 'payment-service', aliases: [],
          scope: 'repo', repos: ['backend'], domain: 'engineering', status: 'active',
          summary: 'payments API',
          observations: [{ category: 'decision', text: 'chose idempotency keys for stripe webhooks' }],
          relations: [],
        },
      ],
      [], [], [],
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('payment-service');
    expect(hits[0].score).toBe(2);
  });

  it('returns empty for a stopword-only query', () => {
    expect(rankSearchHits('the of and', [], [], [], [])).toEqual([]);
  });

  it('excludes archived entities from search', () => {
    const archived = {
      entity: 'old-thing', type: 'system', displayName: 'old-thing', aliases: [],
      scope: 'org', repos: [], domain: '', status: 'archived',
      summary: 'retired subsystem', observations: [], relations: [],
    } as const;
    expect(rankSearchHits('retired subsystem', [archived as any], [], [], [])).toEqual([]);
  });

  // ---- search_memory ----

  it('search_memory returns ranked hits across kinds and records a pull line', async () => {
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.searchMemory.handler({ query: 'stripe payments' } as never, {});
    const text = res.content[0].text as string;
    expect(text).toContain('[entity] payment-service');
    expect(text).toContain('[user] U07ABC123');
    expect(text).toContain('[task-summary] task-old-1');
    expect(res.isError).toBeUndefined();

    const records = await readTelemetry(SPAWN.taskId);
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('pull');
    expect(records[0].tool).toBe('search_memory');
    expect(records[0].returned).toContain('payment-service');
    expect(records[0].zeroResult).toBe(false);
    expect(records[0].agent).toBe('pm-agent');
  });

  it('zero-result search is a normal response and a recorded store gap', async () => {
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.searchMemory.handler({ query: 'kubernetes federation quantum' } as never, {});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('No results');
    const records = await readTelemetry(SPAWN.taskId);
    expect(records[0].zeroResult).toBe(true);
    expect(records[0].args.query).toBe('kubernetes federation quantum');
  });

  // ---- read_entity ----

  it('read_entity returns the rendered block for a valid slug', async () => {
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.readEntity.handler({ slug: 'payment-service' } as never, {});
    expect(res.content[0].text).toContain('<entity slug="payment-service"');
    expect(res.content[0].text).toContain('idempotency keys');
  });

  it('read_entity resolves an alias to the canonical page', async () => {
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.readEntity.handler({ slug: 'payments-api' } as never, {});
    expect(res.content[0].text).toContain('<entity slug="payment-service"');
    const records = await readTelemetry(SPAWN.taskId);
    expect(records[0].returned).toEqual(['payment-service']);
  });

  it('read_entity resolves a benign non-slug alias shape (uppercase) without erroring', async () => {
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.readEntity.handler({ slug: 'PAYMENTS-API' } as never, {});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('<entity slug="payment-service"');
  });

  it('read_entity marks archived pages', async () => {
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.readEntity.handler({ slug: 'old-thing' } as never, {});
    expect(res.content[0].text).toMatch(/archived/i);
    expect(res.content[0].text).toContain('<entity slug="old-thing"');
  });

  it('read_entity rejects a traversal slug before any filesystem access', async () => {
    // Point the store dirs at paths that would throw loudly if touched, then
    // remove read permission entirely: the guard must fire first.
    const sealed = join(tempDir, 'sealed');
    entitiesDir = sealed; // does not exist — any listing would return []/throw, but the point is the error path
    const tools = buildMemoryTools(SPAWN);
    for (const slug of ['../../etc/passwd', 'a/b', 'has.dots.and/slash', '.']) {
      const res: any = await tools.readEntity.handler({ slug } as never, {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Invalid entity slug');
    }
  });

  it('read_entity misses on an unknown-but-valid slug without erroring', async () => {
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.readEntity.handler({ slug: 'does-not-exist' } as never, {});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('No entity found');
    const records = await readTelemetry(SPAWN.taskId);
    expect(records[0].zeroResult).toBe(true);
  });

  // ---- read_task_summary ----

  it('read_task_summary returns summary content', async () => {
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.readTaskSummary.handler({ taskId: 'task-old-1' } as never, {});
    expect(res.content[0].text).toContain('Fixed stripe webhook retries');
  });

  it('read_task_summary rejects malformed task ids', async () => {
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.readTaskSummary.handler({ taskId: '../escape' } as never, {});
    expect(res.isError).toBe(true);
    const res2: any = await tools.readTaskSummary.handler({ taskId: '..' } as never, {});
    expect(res2.isError).toBe(true);
  });

  it('read_task_summary miss is a normal response', async () => {
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.readTaskSummary.handler({ taskId: 'task-unknown' } as never, {});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('No summary found');
  });

  // ---- grep_task_log ----

  it('grep_task_log returns line-numbered case-insensitive matches in an untrusted-data wrapper', async () => {
    knowledgeLogs.set('task-old-1', 'first line\nSecond STRIPE line\nthird line about stripe\n');
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.grepTaskLog.handler({ taskId: 'task-old-1', pattern: 'stripe' } as never, {});
    const text = res.content[0].text as string;
    expect(text).toContain('untrusted transcript data');
    expect(text).toContain('2: Second STRIPE line');
    expect(text).toContain('3: third line about stripe');
    expect(text).toContain('2 matching line(s)');
  });

  it('grep_task_log bounds matches and reports the total', async () => {
    knowledgeLogs.set('task-old-1', Array.from({ length: 60 }, (_, i) => `match line ${i}`).join('\n'));
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.grepTaskLog.handler({ taskId: 'task-old-1', pattern: 'match' } as never, {});
    const text = res.content[0].text as string;
    expect(text).toContain(`showing first ${GREP_MAX_MATCHES} of 60`);
    expect(text.split('\n').filter((l) => /^\d+: /.test(l))).toHaveLength(GREP_MAX_MATCHES);
  });

  it('grep_task_log handles a missing log and an invalid id', async () => {
    const tools = buildMemoryTools(SPAWN);
    const miss: any = await tools.grepTaskLog.handler({ taskId: 'task-none', pattern: 'x' } as never, {});
    expect(miss.content[0].text).toContain('No knowledge log');
    const bad: any = await tools.grepTaskLog.handler({ taskId: 'a/b', pattern: 'x' } as never, {});
    expect(bad.isError).toBe(true);
  });

  // ---- bounds / fail-safety / surface ----

  it('clamps oversized results with an explicit marker', async () => {
    await mkdir(join(tasksDir, 'task-big'), { recursive: true });
    await writeFile(join(tasksDir, 'task-big', 'summary.md'), `# Summary\n\n${'x'.repeat(RESULT_MAX_CHARS + 500)}`);
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.readTaskSummary.handler({ taskId: 'task-big' } as never, {});
    expect(res.content[0].text).toContain('[result truncated');
    expect(res.content[0].text.length).toBeLessThan(RESULT_MAX_CHARS + 200);
  });

  it('sensor failure never affects the tool result', async () => {
    // Point telemetry at a path whose parent is a FILE — mkdir fails.
    const blocker = join(tempDir, 'blocker');
    await writeFile(blocker, 'not a dir');
    telemetryBase = () => blocker;
    const tools = buildMemoryTools(SPAWN);
    const res: any = await tools.readEntity.handler({ slug: 'payment-service' } as never, {});
    expect(res.content[0].text).toContain('<entity slug="payment-service"');
  });

  it('writes no telemetry without a taskId', async () => {
    const tools = buildMemoryTools({ agent: 'pm-agent' });
    await tools.searchMemory.handler({ query: 'stripe' } as never, {});
    expect(existsSync(join(tasksDir, 'undefined'))).toBe(false);
  });

  it('exposes exactly four read-only tools — no write surface', () => {
    const tools = buildMemoryTools(SPAWN);
    const names = Object.values(tools).map((t: any) => t.name).sort();
    expect(names).toEqual(['grep_task_log', 'read_entity', 'read_task_summary', 'search_memory']);
    for (const n of names) expect(n).not.toMatch(/write|delete|remember|forget|update|create/);
    const server = createMemoryToolsMcpServer(SPAWN);
    expect(server).toBeTruthy();
  });
});

describe('telemetry appender', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-telemetry-test-'));
    tasksDir = join(tempDir, 'tasks');
    telemetryBase = () => tasksDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('mixes selection (kind-less) and pull records in one file, partitionable by kind', async () => {
    await appendTelemetry('task-mix', { v: 1, ts: 'now', taskId: 'task-mix', selected: [] });
    await recordPull('task-mix', 'pm-agent', 'search_memory', { query: 'q' }, { returned: [], count: 0, zeroResult: true });
    const records = await readTelemetry('task-mix');
    expect(records).toHaveLength(2);
    const selection = records.filter((r) => r.kind === undefined);
    const pulls = records.filter((r) => r.kind === 'pull');
    expect(selection).toHaveLength(1);
    expect(pulls).toHaveLength(1);
    expect(pulls[0].tool).toBe('search_memory');
  });

  it('recordPull without a taskId skips silently', async () => {
    await recordPull(undefined, 'pm-agent', 'search_memory', { query: 'q' }, { returned: [], count: 0, zeroResult: true });
    expect(existsSync(tasksDir)).toBe(false);
  });

  it('appendTelemetry never throws on an unwritable path', async () => {
    const blocker = join(tempDir, 'blocker');
    await writeFile(blocker, 'not a dir');
    telemetryBase = () => blocker;
    await expect(appendTelemetry('task-x', { v: 1 })).resolves.toBeUndefined();
  });
});
