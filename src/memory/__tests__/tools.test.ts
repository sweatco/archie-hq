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

vi.mock('../paths.js', () => ({
  isMemoryEnabled: () => true,
  isInjectionEnabled: () => false,
  isMemoryToolsEnabled: () => true,
  getUserPath: (id: string) => join(usersDir, `${id}.md`),
  getUsersDir: () => usersDir,
  getMemoryDir: () => tempDir,
  getRecentActivityPath: () => activityPath,
  getEntitiesDir: () => entitiesDir,
  getEntityIndexPath: () => join(entitiesDir, 'index.md'),
  getEntityPath: (slug: string) => join(entitiesDir, `${slug}.md`),
  getTasksDir: () => tasksDir,
  getSummaryPath: (taskId: string) => join(tasksDir, taskId, 'summary.md'),
  getTaskTelemetryPath: (taskId: string) => join(tasksDir, taskId, 'telemetry.jsonl'),
  getEntityCap: () => 300,
  getEntityInjectMax: () => 8,
  getOrgInjectMax: () => 8,
  getEntityObsCap: () => 30,
  getTouchedByInjectMax: () => 10,
  isAllowedTaskId: (id: string) => /^[A-Za-z0-9._\-]+$/.test(id),
  isAllowedUserId: (id: string) => /^(U|W|B|T)[A-Z0-9]{6,}$/.test(id),
  isValidEntitySlug: (slug: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) && slug !== 'index',
}));

import { buildMemoryTools, rankSearchHits, createMemoryToolsMcpServer, RESULT_MAX_CHARS } from '../tools.js';

const CTX = {
  taskId: 'task-spawn-1',
  agent: 'pm-agent',
  authorUserIds: ['U07ABC123'],
};

function entityMarkdown(): string {
  return [
    '---',
    'entity: payment-service',
    'type: service',
    'display_name: "Payment Service"',
    'aliases: [payments-api]',
    'scope: repo',
    'repos: [backend]',
    'domain: engineering',
    'status: active',
    '---',
    '<!-- L0: NestJS payments API -->',
    '',
    '## Facts',
    '- [decision] uses idempotency keys for Stripe webhooks  <!-- touched: 2026-06-01 -->',
    '',
    '## Relations',
    '- depends_on [[postgres-prod]]',
    '',
  ].join('\n');
}

async function telemetry(): Promise<any[]> {
  const path = join(tasksDir, CTX.taskId, 'telemetry.jsonl');
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
}

function resultText(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

describe('memory read tools', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-tools-test-'));
    usersDir = join(tempDir, 'users');
    entitiesDir = join(tempDir, 'entities');
    tasksDir = join(tempDir, 'tasks');
    activityPath = join(tempDir, 'recent-activity.md');
    await mkdir(usersDir, { recursive: true });
    await mkdir(entitiesDir, { recursive: true });
    await mkdir(join(tasksDir, 'task-public-1'), { recursive: true });
    await writeFile(join(entitiesDir, 'payment-service.md'), entityMarkdown());
    await writeFile(join(usersDir, 'U07ABC123.md'), [
      '---',
      'slack_user_id: U07ABC123',
      'display_name: "Dana"',
      'aliases: []',
      '---',
      '## Communication',
      '- Prefers concise payments updates',
    ].join('\n'));
    await writeFile(join(usersDir, 'U07BOB999.md'), [
      '---',
      'slack_user_id: U07BOB999',
      'display_name: "Bob"',
      'aliases: []',
      '---',
      '## Communication',
      '- Wants detailed payments postmortems',
    ].join('\n'));
    await writeFile(join(tasksDir, 'task-public-1', 'summary.md'), [
      '---',
      'task_id: task-public-1',
      '---',
      '',
      '# Summary',
      '',
      'Fixed Stripe payment retries.',
    ].join('\n'));
    await writeFile(activityPath, [
      '# Recent Activity',
      '',
      '| Date | Task ID | Summary | Domain | User |',
      '|------|---------|---------|--------|------|',
      '| 2026-06-02 | task-public-1 | Fixed Stripe retries | engineering | U07ABC123 |',
      '',
    ].join('\n'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('ranks all public corpora while limiting user hits to task authors', async () => {
    const tools = buildMemoryTools(CTX);
    const result = await tools.searchMemory.handler({ query: 'payments stripe' } as never, {});
    const text = resultText(result);
    expect(text).toContain('[entity] payment-service');
    expect(text).toContain('[user] U07ABC123');
    expect(text).not.toContain('U07BOB999');
    expect(text).toContain('[task-summary] task-public-1');
    const records = await telemetry();
    expect(records[0]).toMatchObject({ kind: 'pull', tool: 'search_memory', zeroResult: false });
    expect(records[0]).not.toHaveProperty('denied');
  });

  it('reads entities by alias and rejects traversal identifiers', async () => {
    const tools = buildMemoryTools(CTX);
    const alias = await tools.readEntity.handler({ slug: 'payments-api' } as never, {});
    expect(resultText(alias)).toContain('uses idempotency keys');
    const invalid = await tools.readEntity.handler({ slug: '../secrets' } as never, {});
    expect(invalid.isError).toBe(true);
  });

  it('reads task summaries directly from the public memory store', async () => {
    const tools = buildMemoryTools(CTX);
    const result = await tools.readTaskSummary.handler({ taskId: 'task-public-1' } as never, {});
    expect(resultText(result)).toContain('Fixed Stripe payment retries.');
    const missing = await tools.readTaskSummary.handler({ taskId: 'task-missing' } as never, {});
    expect(resultText(missing)).toContain('No summary found');
  });

  it('keeps search ranking deterministic and clamps tool results', async () => {
    const hits = rankSearchHits(
      'payments',
      [],
      [],
      [{ taskId: 'task-z', text: `# Summary\n${'payments '.repeat(RESULT_MAX_CHARS)}` }],
      [],
    );
    expect(hits.map((hit) => hit.id)).toEqual(['task-z']);
    const tools = buildMemoryTools(CTX);
    await writeFile(join(tasksDir, 'task-public-1', 'summary.md'), 'x'.repeat(RESULT_MAX_CHARS + 100));
    const result = await tools.readTaskSummary.handler({ taskId: 'task-public-1' } as never, {});
    expect(resultText(result)).toContain('[result truncated');
  });

  it('registers exactly the three store-backed read tools', () => {
    const server = createMemoryToolsMcpServer(CTX) as any;
    const names = server.instance._registeredTools
      ? Object.keys(server.instance._registeredTools).sort()
      : server.tools?.map((tool: any) => tool.name).sort();
    expect(names).toEqual(['read_entity', 'read_task_summary', 'search_memory']);
  });
});
