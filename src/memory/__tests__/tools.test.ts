import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TaskMetadata } from '../../types/task.js';

let tempRoot: string;
const state = vi.hoisted(() => ({
  ready: true,
  tools: true,
  metadata: null as TaskMetadata | null,
  entities: [] as Array<Record<string, any>>,
  activity: [] as Array<Record<string, string>>,
  profiles: new Map<string, string>(),
  classify: vi.fn(),
  listEntities: vi.fn(),
  readActivity: vi.fn(),
  readUser: vi.fn(),
}));

vi.mock('../paths.js', () => ({
  isMemoryReady: () => state.ready,
  isMemoryToolsEnabled: () => state.tools,
  isMemoryHumanUserId: (id: string) => /^(U|W)[A-Z0-9]{6,}$/.test(id),
  isAllowedTaskId: (id: string) => /^[A-Za-z0-9._-]+$/.test(id),
  isSlackConversationId: (id: string) => /^(C|D|G)[A-Z0-9]+$/.test(id),
  getPublicMemoryDir: () => join(tempRoot, 'public'),
  getTaskChannelDir: (visibility: string, channelId: string) => join(tempRoot, visibility, channelId),
  getTaskOverviewPath: (visibility: string, channelId: string) => join(tempRoot, visibility, channelId, 'rolling-summary.md'),
  getTaskSummaryPath: (visibility: string, channelId: string, taskId: string) => join(tempRoot, visibility, channelId, `${taskId}.md`),
}));

vi.mock('../../connectors/slack/client.js', () => ({ classifySlackMemoryScope: state.classify }));
vi.mock('../entities.js', () => ({
  listEntities: state.listEntities,
  serializeEntity: (entity: Record<string, unknown>) => JSON.stringify(entity),
}));
vi.mock('../activity.js', () => ({ readActivity: state.readActivity }));
vi.mock('../store.js', () => ({ readUser: state.readUser }));
vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { createMemoryMcpServer, shouldAttachMemoryTools } from '../tools.js';
import type { Task } from '../../tasks/task.js';

function metadata(channelId = 'G07PRIVATE1'): TaskMetadata {
  return {
    task_id: 'task-current',
    channels: {
      [`slack:${channelId}:100.0`]: {
        type: 'slack', channel_id: channelId, channel_name: 'test', thread_id: '100.0',
      },
    },
    default_channel: `slack:${channelId}:100.0`,
    agent_sessions: {},
    repositories: [],
    memory_destination: { channel_id: channelId },
    memory_authors: { U07AUTHOR1: 'Actual Author', 'cli:forged': 'Forged' },
  } as unknown as TaskMetadata;
}

function fakeTask(): Task {
  return {
    taskId: 'task-current',
    metadata: state.metadata!,
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as Task;
}

function handlers(task = fakeTask()) {
  const server = createMemoryMcpServer(task);
  const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
  return Object.fromEntries(Object.entries(raw).map(([name, entry]: [string, any]) => [
    name,
    (args: Record<string, unknown>) => (entry.callback ?? entry.handler ?? entry.cb)(args, {}),
  ])) as Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>;
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

async function writeTask(
  visibility: 'public' | 'private',
  channelId: string,
  taskId: string,
  summary: string,
  tail = '',
): Promise<void> {
  const directory = join(tempRoot, visibility, channelId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${taskId}.md`), [
    '---',
    `task_id: ${taskId}`,
    `channel_id: ${channelId}`,
    'status: completed',
    'created_at: "2026-08-31T12:00:00.000Z"',
    'extraction_at: "2026-08-31T12:05:00.000Z"',
    '---',
    '',
    '# Summary',
    '',
    summary,
    tail,
    '',
  ].join('\n'));
}

describe('memory tools', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'archie-memory-tools-'));
  });

  beforeEach(async () => {
    await rm(join(tempRoot, 'public'), { recursive: true, force: true });
    await rm(join(tempRoot, 'private'), { recursive: true, force: true });
    state.ready = true;
    state.tools = true;
    state.metadata = metadata();
    state.entities = [{
      entity: 'payments', aliases: ['billing'], status: 'active', summary: 'Payments service', observations: [], relations: [],
    }];
    state.activity = [{
      date: '2026-08-31', taskId: 'task-activity', summary: 'Payments rollout', domain: 'engineering', user: 'U07AUTHOR1',
    }];
    state.profiles = new Map([['U07AUTHOR1', 'Prefers concise payments updates']]);
    state.classify.mockReset();
    state.classify.mockResolvedValue({ kind: 'private_channel', channel_id: 'G07PRIVATE1' });
    state.listEntities.mockReset();
    state.listEntities.mockImplementation(async () => state.entities);
    state.readActivity.mockReset();
    state.readActivity.mockImplementation(async () => state.activity);
    state.readUser.mockReset();
    state.readUser.mockImplementation(async (id: string) => state.profiles.get(id) ?? '');
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('attaches exactly three tools only for ready, enabled tasks with a destination', () => {
    expect(Object.keys(handlers()).sort()).toEqual(['read_entity', 'read_task_summary', 'search_memory']);
    expect(shouldAttachMemoryTools(state.metadata!)).toBe(true);
    state.tools = false;
    expect(shouldAttachMemoryTools(state.metadata!)).toBe(false);
    state.tools = true;
    delete state.metadata!.memory_destination;
    expect(shouldAttachMemoryTools(state.metadata!)).toBe(false);
  });

  it('searches complete public and exact-private task files with entity, activity, and authorized profiles', async () => {
    await writeTask('private', 'G07PRIVATE1', 'task-private', 'Private payments decision');
    await writeTask('private', 'G07FOREIGN1', 'task-foreign', 'Foreign payments secret');
    await writeTask('public', 'C07PUBLIC1', 'task-public', 'Public payments decision');

    const output = textOf(await handlers().search_memory!({ query: 'payments', limit: 20 }));

    expect(output).toContain('Private payments decision');
    expect(output).toContain('Public payments decision');
    expect(output).toContain('Payments service');
    expect(output).toContain('Prefers concise payments updates');
    expect(output).not.toContain('Foreign payments secret');
    expect(state.readUser).toHaveBeenCalledWith('U07AUTHOR1');
    expect(state.readUser).not.toHaveBeenCalledWith('cli:forged');
  });

  it('finds a term deep in an old task body even when absent from activity and overview', async () => {
    await writeTask('public', 'C07PUBLIC1', 'task-old', 'Old public summary', `\n## Memory Updates\n\n${'padding '.repeat(100)}deepneedle answer-value`);
    await writeFile(join(tempRoot, 'public', 'C07PUBLIC1', 'rolling-summary.md'), '# no old task here\n');
    state.entities = [];
    state.activity = [];
    state.profiles.clear();

    const output = textOf(await handlers().search_memory!({ query: 'deepneedle', limit: 10 }));

    expect(output).toContain('"kind": "task"');
    expect(output).toContain('deepneedle answer-value');
  });

  it('prefers the exact authorized private file over a public file with the same task ID', async () => {
    await writeTask('private', 'G07PRIVATE1', 'task-shared', 'Private version');
    await writeTask('public', 'C07PUBLIC1', 'task-shared', 'Public version');

    const output = textOf(await handlers().read_task_summary!({ task_id: 'task-shared' }));

    expect(output).toContain('Private version');
    expect(output).not.toContain('Public version');
  });

  it('public authorization excludes every private task directory', async () => {
    state.classify.mockResolvedValue({ kind: 'public', channel_id: 'G07PRIVATE1' });
    await writeTask('private', 'G07PRIVATE1', 'task-private', 'Private-only needle');
    await writeTask('public', 'C07PUBLIC1', 'task-public', 'Public-only needle');

    const search = textOf(await handlers().search_memory!({ query: 'needle', limit: 10 }));
    expect(search).toContain('Public-only needle');
    expect(search).not.toContain('Private-only needle');
  });

  it('DM authorization uses its D conversation directory and fails closed when live classification is denied', async () => {
    state.metadata = metadata('D07PERSON01');
    state.classify.mockResolvedValue({ kind: 'user', user_id: 'U07AUTHOR1' });
    await writeTask('private', 'D07PERSON01', 'task-dm', 'DM-only value');
    expect(textOf(await handlers().read_task_summary!({ task_id: 'task-dm' }))).toContain('DM-only value');

    state.classify.mockResolvedValue({ kind: 'none' });
    expect(textOf(await handlers().read_task_summary!({ task_id: 'task-dm' }))).toContain('Memory unavailable');
  });

  it('keeps archived and catalogue-omitted entities readable and searchable', async () => {
    state.entities = [
      { entity: 'omitted', aliases: [], status: 'active', summary: 'summary', observations: [{ text: 'omittedneedle detail' }], relations: [] },
      { entity: 'archived', aliases: ['old-system'], status: 'archived', summary: 'archivedneedle detail', observations: [], relations: [] },
    ];

    expect(textOf(await handlers().search_memory!({ query: 'omittedneedle', limit: 10 }))).toContain('omitted');
    expect(textOf(await handlers().read_entity!({ identifier: 'old-system' }))).toContain('archivedneedle');
  });

  it('allows public entities and activity without recorded authors but reads no profiles', async () => {
    state.metadata!.memory_authors = {};
    const output = textOf(await handlers().search_memory!({ query: 'payments', limit: 10 }));

    expect(output).toContain('Payments service');
    expect(output).toContain('Payments rollout');
    expect(state.readUser).not.toHaveBeenCalled();
  });

  it('rejects invalid identifiers and bounds escaped tool output', async () => {
    expect(textOf(await handlers().read_task_summary!({ task_id: '../task' }))).toContain('Invalid task ID');
    expect(textOf(await handlers().read_entity!({ identifier: '../../private' }))).toContain('Invalid entity identifier');
    state.entities = [{
      entity: 'payments', aliases: ['billing'], status: 'active', summary: `<script>${'x'.repeat(9_000)}</script>`, observations: [], relations: [],
    }];
    const output = textOf(await handlers().read_entity!({ identifier: 'billing' }));
    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('[truncated]');
    expect(output.length).toBeLessThanOrEqual(8_000);
  });

  it('returns stable ranked results and honors the requested bound', async () => {
    state.entities = [
      { entity: 'zeta', aliases: [], summary: 'payments', observations: [], relations: [] },
      { entity: 'alpha', aliases: [], summary: 'payments', observations: [], relations: [] },
    ];
    const search = handlers().search_memory!;
    const first = textOf(await search({ query: 'payments', limit: 2 }));
    const second = textOf(await search({ query: 'payments', limit: 2 }));

    expect(first).toBe(second);
    expect(JSON.parse(first.slice(first.indexOf('\n') + 1, first.lastIndexOf('\n')))).toHaveLength(2);
  });

  it('denies memory without mutating fixed scope when live classification fails', async () => {
    state.classify.mockResolvedValue({ kind: 'none' });
    const task = fakeTask();
    const output = textOf(await handlers(task).search_memory!({ query: 'payments', limit: 10 }));

    expect(output).toContain('Memory unavailable');
    expect(task.metadata.memory_destination).toEqual({ channel_id: 'G07PRIVATE1' });
    expect(task.save).not.toHaveBeenCalled();
    expect(state.listEntities).not.toHaveBeenCalled();
  });
});
