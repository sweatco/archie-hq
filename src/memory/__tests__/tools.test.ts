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
  outcomes: [] as Array<Record<string, string>>,
  profiles: new Map<string, string>(),
  classify: vi.fn(),
  listEntities: vi.fn(),
  readActivity: vi.fn(),
  readUser: vi.fn(),
  readPrivateOutcomes: vi.fn(),
}));

vi.mock('../paths.js', () => ({
  isMemoryReady: () => state.ready,
  isMemoryToolsEnabled: () => state.tools,
  isMemoryHumanUserId: (id: string) => /^(U|W)[A-Z0-9]{6,}$/.test(id),
  isAllowedTaskId: (id: string) => /^[A-Za-z0-9._-]+$/.test(id),
  getChannelPrivatePath: (id: string) => join(tempRoot, 'private', 'channels', `${id}.md`),
  getUserPrivatePath: (id: string) => join(tempRoot, 'private', 'users', `${id}.md`),
  getSummaryPath: (id: string) => join(tempRoot, 'public', 'tasks', `${id}.md`),
}));

vi.mock('../../connectors/slack/client.js', () => ({
  classifySlackMemoryScope: state.classify,
}));

vi.mock('../entities.js', () => ({
  listEntities: state.listEntities,
  serializeEntity: (entity: Record<string, unknown>) => JSON.stringify(entity),
}));

vi.mock('../activity.js', () => ({ readActivity: state.readActivity }));
vi.mock('../store.js', () => ({ readUser: state.readUser }));
vi.mock('../outcomes.js', () => ({ readPrivateOutcomes: state.readPrivateOutcomes }));
vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { createMemoryMcpServer, shouldAttachMemoryTools } from '../tools.js';
import type { Task } from '../../tasks/task.js';

function metadata(destination: TaskMetadata['memory_destination'] | null = { channel_id: 'C07PRIVATE' }): TaskMetadata {
  return {
    task_id: 'task-current',
    participants: [],
    channels: {
      'slack:C07PRIVATE:100.0': {
        type: 'slack', channel_id: 'C07PRIVATE', channel_name: 'private', thread_id: '100.0',
      },
    },
    default_channel: 'slack:C07PRIVATE:100.0',
    agent_sessions: {},
    repositories: {},
    ...(destination ? { memory_destination: destination } : {}),
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

describe('memory tools', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'archie-memory-tools-'));
  });

  beforeEach(async () => {
    await rm(join(tempRoot, 'public'), { recursive: true, force: true });
    state.ready = true;
    state.tools = true;
    state.metadata = metadata();
    state.entities = [{
      entity: 'payments', aliases: ['billing'], summary: 'Payments service', observations: [], relations: [],
    }];
    state.activity = [{
      date: '2026-08-31', taskId: 'task-shared', summary: 'Payments rollout', domain: 'engineering', user: 'U07AUTHOR1',
    }];
    state.outcomes = [{ task_id: 'task-shared', created_at: '2026-08-31T12:00:00.000Z', summary: 'Private payments decision' }];
    state.profiles = new Map([['U07AUTHOR1', 'Prefers concise payments updates']]);
    state.classify.mockReset();
    state.classify.mockResolvedValue({ kind: 'channel' });
    state.listEntities.mockReset();
    state.listEntities.mockImplementation(async () => state.entities);
    state.readActivity.mockReset();
    state.readActivity.mockImplementation(async () => state.activity);
    state.readUser.mockReset();
    state.readUser.mockImplementation(async (id: string) => state.profiles.get(id) ?? '');
    state.readPrivateOutcomes.mockReset();
    state.readPrivateOutcomes.mockImplementation(async () => state.outcomes);
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('attaches exactly three tools only for ready, enabled, internal tasks', () => {
    expect(Object.keys(handlers()).sort()).toEqual(['read_entity', 'read_task_summary', 'search_memory']);
    expect(shouldAttachMemoryTools(state.metadata!)).toBe(true);
    state.tools = false;
    expect(shouldAttachMemoryTools(state.metadata!)).toBe(false);
    state.tools = true;
    state.metadata = metadata(null);
    expect(shouldAttachMemoryTools(state.metadata)).toBe(false);
  });

  it('searches exact private, public entity/activity, and structured-author profile sources deterministically', async () => {
    const task = fakeTask();
    const search = handlers(task).search_memory!;
    const output = textOf(await search({ query: 'payments', limit: 10 }));

    expect(output).toContain('Private payments decision');
    expect(output).toContain('Payments service');
    expect(output).toContain('Prefers concise payments updates');
    expect(output).not.toContain('"id": "activity:task-shared"');
    expect(state.readUser).toHaveBeenCalledWith('U07AUTHOR1');
    expect(state.readUser).not.toHaveBeenCalledWith('cli:forged');
  });

  it('rejects traversal-shaped entity identifiers before entity reads', async () => {
    const readEntity = handlers().read_entity!;
    state.listEntities.mockClear();

    const output = textOf(await readEntity({ identifier: '../../private' }));

    expect(output).toContain('Invalid entity identifier');
    expect(state.listEntities).not.toHaveBeenCalled();
  });

  it('reads public entities by alias and XML-escapes bounded output', async () => {
    state.entities = [{
      entity: 'payments', aliases: ['billing'], summary: `<script>${'x'.repeat(9_000)}</script>`, observations: [], relations: [],
    }];
    const output = textOf(await handlers().read_entity!({ identifier: 'billing' }));

    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('[truncated]');
    expect(output.length).toBeLessThanOrEqual(8_000);
    expect(output.endsWith('</memory_evidence>')).toBe(true);
  });

  it('does not return an empty structured-author profile', async () => {
    state.profiles.clear();
    state.entities = [];
    state.activity = [];
    state.outcomes = [];
    const task = fakeTask();

    const output = textOf(await handlers(task).search_memory!({ query: 'actual author', limit: 10 }));

    expect(output).toContain('[]');
    expect(task.save).not.toHaveBeenCalled();
  });

  it('prefers the exact authorized private outcome over a public task summary', async () => {
    await mkdir(join(tempRoot, 'public', 'tasks'), { recursive: true });
    await writeFile(join(tempRoot, 'public', 'tasks', 'task-shared.md'), 'public version');

    const output = textOf(await handlers().read_task_summary!({ task_id: 'task-shared' }));

    expect(output).toContain('Private payments decision');
    expect(output).not.toContain('public version');
  });

  it('uses public memory but not the private vault when the destination becomes public', async () => {
    state.classify.mockResolvedValue({ kind: 'public' });
    await mkdir(join(tempRoot, 'public', 'tasks'), { recursive: true });
    await writeFile(join(tempRoot, 'public', 'tasks', 'task-shared.md'), 'public version');

    const output = textOf(await handlers().read_task_summary!({ task_id: 'task-shared' }));

    expect(output).toContain('public version');
    expect(output).not.toContain('Private payments decision');
    expect(state.readPrivateOutcomes).not.toHaveBeenCalled();
  });

  it('narrows a public task to the same channel when it becomes private', async () => {
    state.metadata = metadata();
    state.classify.mockResolvedValue({ kind: 'channel' });
    const task = fakeTask();

    const output = textOf(await handlers(task).read_task_summary!({ task_id: 'task-shared' }));

    expect(output).toContain('Private payments decision');
    expect(task.metadata.memory_destination).toEqual({ channel_id: 'C07PRIVATE' });
    expect(task.save).not.toHaveBeenCalled();
  });

  it('never reads a private vault for a public-scoped task', async () => {
    state.metadata = metadata();
    state.classify.mockResolvedValue({ kind: 'public' });

    const output = textOf(await handlers().search_memory!({ query: 'payments', limit: 10 }));

    expect(output).not.toContain('Private payments decision');
    expect(state.readPrivateOutcomes).not.toHaveBeenCalled();
  });

  it('rejects malformed task IDs before summary file access', async () => {
    const output = textOf(await handlers().read_task_summary!({ task_id: '../task-shared' }));

    expect(output).toContain('Invalid task ID');
    expect(state.readPrivateOutcomes).not.toHaveBeenCalled();
  });

  it('reads only the exact authorized private vault', async () => {
    await handlers().read_task_summary!({ task_id: 'task-shared' });

    expect(state.readPrivateOutcomes).toHaveBeenCalledTimes(1);
    expect(state.readPrivateOutcomes).toHaveBeenCalledWith(
      join(tempRoot, 'private', 'channels', 'C07PRIVATE.md'),
    );
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

  it('denies memory without mutating the fixed scope when live classification fails', async () => {
    state.classify.mockResolvedValue({ kind: 'none' });
    const task = fakeTask();

    const output = textOf(await handlers(task).search_memory!({ query: 'payments', limit: 10 }));

    expect(output).toContain('Memory unavailable');
    expect(task.metadata.memory_destination).toEqual({ channel_id: 'C07PRIVATE' });
    expect(task.save).not.toHaveBeenCalled();
    expect(state.listEntities).not.toHaveBeenCalled();
  });

});
