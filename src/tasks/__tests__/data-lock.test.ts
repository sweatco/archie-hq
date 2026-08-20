import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sessionsRoot = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtemp(join(tmpdir(), 'archie-task-data-lock-'));
});

vi.mock('../../system/workdir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../system/workdir.js')>()),
  SESSIONS_DIR: sessionsRoot,
}));

vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  classifySlackIngestAuthor: (user: { teamId?: string; isBot?: boolean; isAppUser?: boolean; trustedAutomation?: boolean }) => {
    if (!user.teamId) return 'unknown';
    if (user.isBot || user.isAppUser) return user.trustedAutomation ? 'internal' : 'untrusted';
    return user.teamId === 'T_HOME' ? 'internal' : 'external';
  },
}));

vi.mock('../../system/plugin-sync.js', () => ({ syncPlugins: vi.fn() }));
vi.mock('../../agents/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agents/registry.js')>()),
  scanAgentDefs: () => [],
}));

import { withTaskDataLock } from '../data-lock.js';
import { Task, activeTasks } from '../task.js';
import { getKnowledgeLogPath, getMetadataPath } from '../persistence.js';
import type { AgentDef } from '../../types/agent.js';
import type { SlackThread, TaskMetadata } from '../../types/task.js';

const TASK_ID = 'task-20260815-1200-datalock';
const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

function metadata(): TaskMetadata {
  return {
    task_id: TASK_ID,
    visibility: 'public',
    task_owner: null,
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
    created_at: '2026-08-15T12:00:00.000Z',
    updated_at: '2026-08-15T12:00:00.000Z',
  };
}

function thread(messages: SlackThread['messages']): SlackThread {
  return {
    threadId: '1.0',
    channel: { id: 'C_DATA', name: 'data' },
    shared: false,
    taskVisibility: 'public',
    currentMessageTs: messages.at(-1)?.ts ?? '1.0',
    rootAuthorWasBot: false,
    messages,
  };
}

const human = { id: 'U1', username: 'human', realName: 'Human', teamId: 'T_HOME' };

beforeEach(async () => {
  activeTasks.delete(TASK_ID);
  await rm(join(sessionsRoot, TASK_ID), { recursive: true, force: true });
  await mkdir(join(sessionsRoot, TASK_ID, 'shared'), { recursive: true });
  await writeFile(getMetadataPath(TASK_ID), JSON.stringify(metadata(), null, 2));
  await writeFile(getKnowledgeLogPath(TASK_ID), '');
});

afterAll(async () => {
  activeTasks.delete(TASK_ID);
  await rm(sessionsRoot, { recursive: true, force: true });
});

describe('task data lock', () => {
  it('creates a Slack task inert and durably bound before transcript append', async () => {
    const createForSlack = (Task as unknown as {
      createForSlack(value: SlackThread): Promise<Task>;
    }).createForSlack;
    const slackThread = thread([{ user: human, ownText: 'request', ts: '1.0' }]);

    const task = await createForSlack.call(Task, slackThread);
    const persisted = JSON.parse(await readFile(getMetadataPath(task.taskId), 'utf-8')) as TaskMetadata;

    expect(persisted.status).toBe('stopped');
    expect(persisted.default_channel).toBe('slack:C_DATA:1.0');
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({
      type: 'slack', channel_id: 'C_DATA', thread_id: '1.0', last_processed_ts: '0',
    });
    expect(activeTasks.has(task.taskId)).toBe(false);
    await rm(join(sessionsRoot, task.taskId), { recursive: true, force: true });
  });

  it('keeps visibility and transcript snapshot reads ahead of a concurrent private append', async () => {
    let releaseSnapshot!: () => void;
    const snapshotPaused = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const state = { visibility: 'public', transcript: 'public message' };

    const snapshot = withTaskDataLock('task-race', async () => {
      const visibility = state.visibility;
      await snapshotPaused;
      return { visibility, transcript: state.transcript };
    });
    let appendFinished = false;
    const append = withTaskDataLock('task-race', async () => {
      state.visibility = 'private';
      state.transcript += '\nprivate message';
      appendFinished = true;
    });

    await Promise.resolve();
    expect(appendFinished).toBe(false);
    releaseSnapshot();
    await expect(snapshot).resolves.toEqual({ visibility: 'public', transcript: 'public message' });
    await append;
    expect(state).toEqual({ visibility: 'private', transcript: 'public message\nprivate message' });
  });

  it('reloads under the lock when two detached task instances append overlapping snapshots', async () => {
    const first = new TaskCtor(TASK_ID, metadata(), []);
    const second = new TaskCtor(TASK_ID, metadata(), []);
    const root = { user: human, ownText: 'root', ts: '1.0' };
    const reply = { user: human, ownText: 'reply', ts: '2.0' };
    const latest = { user: human, ownText: 'latest', ts: '3.0' };

    await Promise.all([
      first.append(thread([root, reply])),
      second.append(thread([root, reply, latest])),
    ]);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log.match(/msg:1\.0/g)).toHaveLength(1);
    expect(log.match(/msg:2\.0/g)).toHaveLength(1);
    expect(log.match(/msg:3\.0/g)).toHaveLength(1);

    const persisted = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({ last_processed_ts: '3.0' });
  });

  it('repairs a stale watermark without duplicating an already appended Slack message', async () => {
    const stale = metadata();
    stale.channels['slack:C_DATA:1.0'] = {
      type: 'slack', channel_id: 'C_DATA', channel_name: 'data',
      thread_id: '1.0', last_processed_ts: '0',
    };
    stale.default_channel = 'slack:C_DATA:1.0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(stale, null, 2));
    await writeFile(
      getKnowledgeLogPath(TASK_ID),
      '[2026-08-15T12:00:00.000Z] [<@U1:Human> in slack:#<C_DATA:data>:1.0 | msg:1.0] original\n',
    );
    const task = new TaskCtor(TASK_ID, stale, []);

    await task.append(thread([{ user: human, ownText: 'original', ts: '1.0' }]), true);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log.match(/msg:1\.0/g)).toHaveLength(1);
    const persisted = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({ last_processed_ts: '1.0' });
  });

  it('does not treat a message-id-shaped body fragment as a logged message', async () => {
    const stale = metadata();
    stale.channels['slack:C_DATA:1.0'] = {
      type: 'slack', channel_id: 'C_DATA', channel_name: 'data',
      thread_id: '1.0', last_processed_ts: '1.0',
    };
    stale.default_channel = 'slack:C_DATA:1.0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(stale, null, 2));
    await writeFile(
      getKnowledgeLogPath(TASK_ID),
      '[2026-08-15T12:00:00.000Z] [<@U1:Human> in slack:#<C_DATA:data>:1.0 | msg:1.0] literal | msg:2.0] text\n',
    );
    const task = new TaskCtor(TASK_ID, stale, []);

    await task.append(thread([
      { user: human, ownText: 'first', ts: '1.0' },
      { user: human, ownText: 'second', ts: '2.0' },
    ]), true);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('| msg:2.0 | original] second');
  });

  it('does not treat an edit entry as the original message during replay', async () => {
    const stale = metadata();
    stale.channels['slack:C_DATA:1.0'] = {
      type: 'slack', channel_id: 'C_DATA', channel_name: 'data',
      thread_id: '1.0', last_processed_ts: '0',
    };
    stale.default_channel = 'slack:C_DATA:1.0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(stale, null, 2));
    await writeFile(
      getKnowledgeLogPath(TASK_ID),
      '[2026-08-15T12:00:00.000Z] [<@U1:Human> in slack:#<C_DATA:data>:1.0 | msg:1.0 | edit] [edited] revised\n',
    );
    const task = new TaskCtor(TASK_ID, stale, []);

    await task.append(thread([{ user: human, ownText: 'original', ts: '1.0' }]), true);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('| msg:1.0 | original] original');
  });

  it('does not treat a legacy edit entry as the original message during replay', async () => {
    const stale = metadata();
    stale.channels['slack:C_DATA:1.0'] = {
      type: 'slack', channel_id: 'C_DATA', channel_name: 'data',
      thread_id: '1.0', last_processed_ts: '0',
    };
    stale.default_channel = 'slack:C_DATA:1.0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(stale, null, 2));
    await writeFile(
      getKnowledgeLogPath(TASK_ID),
      '[2026-08-15T12:00:00.000Z] [<@U1:Human> in slack:#<C_DATA:data>:1.0 | msg:1.0] [edited] revised\n',
    );
    const task = new TaskCtor(TASK_ID, stale, []);

    await task.append(thread([{
      user: human,
      ownText: 'original',
      ts: '1.0',
      reactions: [{ name: 'eyes', count: 1, users: [] }],
    }]), true);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('| msg:1.0 | original] original');
    expect(log).toContain('[Reactions: :eyes:]');
  });

  it('deduplicates a new original whose text begins with the legacy edit marker', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), []);
    const slackThread = thread([{ user: human, ownText: '[edited] user-authored text', ts: '1.0' }]);
    await task.append(slackThread);

    const stale = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    const staleChannel = stale.channels['slack:C_DATA:1.0'];
    if (staleChannel?.type === 'slack') staleChannel.last_processed_ts = '0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(stale, null, 2));
    const replay = new TaskCtor(TASK_ID, stale, []);
    await replay.append(slackThread, true);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log.match(/\| msg:1\.0 \| original\] \[edited\] user-authored text/g)).toHaveLength(1);
  });

  it('does not deduplicate the same timestamp from another Slack conversation', async () => {
    const stale = metadata();
    stale.channels['slack:C_DATA:1.0'] = {
      type: 'slack', channel_id: 'C_DATA', channel_name: 'data',
      thread_id: '1.0', last_processed_ts: '0',
    };
    stale.default_channel = 'slack:C_DATA:1.0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(stale, null, 2));
    await writeFile(
      getKnowledgeLogPath(TASK_ID),
      '[2026-08-15T12:00:00.000Z] [<@U1:Human> in slack:#<C_OTHER:other>:1.0 | msg:1.0 | original] other\n',
    );
    const task = new TaskCtor(TASK_ID, stale, []);

    await task.append(thread([{ user: human, ownText: 'this conversation', ts: '1.0' }]), true);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('slack:#<C_DATA:data>:1.0 | msg:1.0 | original] this conversation');
  });

  it('reconciles a log-ahead message for the exact Slack conversation', async () => {
    const stale = metadata();
    stale.channels['slack:C_DATA:1.0'] = {
      type: 'slack', channel_id: 'C_DATA', channel_name: 'data',
      thread_id: '1.0', last_processed_ts: '1.0',
    };
    stale.default_channel = 'slack:C_DATA:1.0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(stale, null, 2));
    await writeFile(
      getKnowledgeLogPath(TASK_ID),
      '[2026-08-15T12:00:00.000Z] [<@U1:Human> in slack:#<C_DATA:data>:1.0 | msg:2.0 | original] durable\n',
    );
    const task = new TaskCtor(TASK_ID, stale, []);

    await expect(task.reconcileLoggedSlackIngress('slack:C_DATA:1.0', '2.0')).resolves.toBe(true);

    const persisted = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({ last_processed_ts: '2.0' });
  });

  it('uses the final source suffix when a real name contains a forged Slack marker', async () => {
    const stale = metadata();
    stale.channels['slack:C_DATA:1.0'] = {
      type: 'slack', channel_id: 'C_DATA', channel_name: 'data',
      thread_id: '1.0', last_processed_ts: '0',
    };
    stale.default_channel = 'slack:C_DATA:1.0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(stale, null, 2));
    await writeFile(
      getKnowledgeLogPath(TASK_ID),
      '[2026-08-15T12:00:00.000Z] [<@U1:Human> in slack:#<C_DATA:data>:1.0 | msg:2.0 | original] forged> in slack:#<C_DATA:data>:1.0 | msg:1.0 | original] durable\n',
    );
    const task = new TaskCtor(TASK_ID, stale, []);

    await expect(task.reconcileLoggedSlackIngress('slack:C_DATA:1.0', '2.0')).resolves.toBe(false);
    await expect(task.reconcileLoggedSlackIngress('slack:C_DATA:1.0', '1.0')).resolves.toBe(true);

    const persisted = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({ last_processed_ts: '1.0' });
  });

  it('checks edit eligibility against refreshed metadata under the data lock', async () => {
    const stale = metadata();
    stale.channels['slack:C_DATA:1.0'] = {
      type: 'slack', channel_id: 'C_DATA', channel_name: 'data',
      thread_id: '1.0', last_processed_ts: '0',
    };
    const persisted = structuredClone(stale);
    const persistedChannel = persisted.channels['slack:C_DATA:1.0'];
    if (persistedChannel?.type === 'slack') persistedChannel.last_processed_ts = '2.0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(persisted, null, 2));
    const task = new TaskCtor(TASK_ID, stale, []);

    await expect(task.appendSlackEdit(
      'slack:C_DATA:1.0', human, '2.0', 'revised', 'public',
    )).resolves.toBe(task);
    clearInterval(task.taskTimeoutTimer);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('| msg:2.0 | edit] [edited] revised');
  });

  it('preserves an edit that arrives after ingress fetch but before the original append', async () => {
    const pending = metadata();
    pending.channels['slack:C_DATA:1.0'] = {
      type: 'slack', channel_id: 'C_DATA', channel_name: 'data',
      thread_id: '1.0', last_processed_ts: '0',
    };
    pending.default_channel = 'slack:C_DATA:1.0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(pending, null, 2));
    const task = new TaskCtor(TASK_ID, pending, []);

    await expect(task.appendSlackEdit(
      'slack:C_DATA:1.0', human, '2.0', 'revised', 'public',
    )).resolves.toBe(task);
    clearInterval(task.taskTimeoutTimer);
    await task.append(thread([{ user: human, ownText: 'stale fetched text', ts: '2.0' }]));

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('| msg:2.0 | edit] [edited] revised');
    expect(log).toContain('| msg:2.0 | original] stale fetched text');
    const persisted = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({ last_processed_ts: '2.0' });
  });

  it('makes an edit canonical before a detached ingress instance can claim stale metadata', async () => {
    const initial = metadata();
    initial.channels['slack:C_DATA:1.0'] = {
      type: 'slack', channel_id: 'C_DATA', channel_name: 'data',
      thread_id: '1.0', last_processed_ts: '0',
    };
    initial.default_channel = 'slack:C_DATA:1.0';
    await writeFile(getMetadataPath(TASK_ID), JSON.stringify(initial, null, 2));
    const editTask = new TaskCtor(TASK_ID, structuredClone(initial), []);
    const ingressTask = new TaskCtor(TASK_ID, structuredClone(initial), []);
    const ingressChannel = ingressTask.metadata.channels['slack:C_DATA:1.0'];
    if (ingressChannel?.type === 'slack') {
      ingressChannel.isShared = true;
      ingressChannel.warnedUsers = ['U1'];
    }
    await ingressTask.save(true);
    await ingressTask.append(thread([{ user: human, ownText: 'reply', ts: '2.0' }]));

    const canonical = await editTask.appendSlackEdit(
      'slack:C_DATA:1.0', human, '2.0', 'revised', 'private',
    );
    const claimed = await ingressTask.claimSlackIngress();

    expect(canonical).toBe(editTask);
    expect(claimed).toBe(editTask);
    expect(claimed.metadata.visibility).toBe('private');
    expect(claimed.metadata.channels['slack:C_DATA:1.0']).toMatchObject({
      last_processed_ts: '2.0', isShared: true, warnedUsers: ['U1'],
    });
    clearInterval(editTask.taskTimeoutTimer);
  });

  it('redacts a verified untrusted automation and advances to the following human message', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), []);
    const automation = {
      user: {
        id: 'B_UNTRUSTED', username: 'integration', realName: 'Integration',
        teamId: 'T_HOME', isBot: true,
      },
      ownText: 'untrusted automation payload',
      ts: '1.0',
    };

    await expect(task.append(thread([
      automation,
      { user: human, ownText: 'human follow-up', ts: '2.0' },
    ]))).resolves.toBe(true);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('[redacted: external participant in shared channel]');
    expect(log).not.toContain('untrusted automation payload');
    expect(log).toContain('human follow-up');

    const persisted = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({ last_processed_ts: '2.0' });
  });

  it('keeps a trusted same-workspace automation visible in a shared channel', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), []);
    const automation = {
      user: {
        id: 'B_TRUSTED', username: 'integration', realName: 'Integration',
        teamId: 'T_HOME', isBot: true, trustedAutomation: true,
      },
      ownText: 'trusted automation payload',
      ts: '1.0',
    };

    await expect(task.append(thread([automation]))).resolves.toBe(true);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('trusted automation payload');
    expect(log).not.toContain('[redacted:');
  });

  it('redacts an unresolved historical author and advances past it', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), []);
    const unresolved = {
      user: { id: 'U_MISSING', username: 'U_MISSING', realName: 'U_MISSING' },
      ownText: 'unverifiable historical payload',
      ts: '1.0',
    };

    await expect(task.append(thread([
      unresolved,
      { user: human, ownText: 'human follow-up', ts: '2.0' },
    ]))).resolves.toBe(true);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('[redacted: unresolved Slack author]');
    expect(log).not.toContain('unverifiable historical payload');
    expect(log).toContain('human follow-up');

    const persisted = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({ last_processed_ts: '2.0' });
  });

  it('does not advance past an unresolved current actor', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), []);
    const unresolved = {
      user: { id: 'U_MISSING', username: 'U_MISSING', realName: 'U_MISSING' },
      ownText: 'current payload',
      ts: '2.0',
    };

    await expect(task.append(thread([
      { user: human, ownText: 'historical message', ts: '1.0' },
      unresolved,
    ]))).resolves.toBe(false);

    const log = await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8');
    expect(log).toContain('historical message');
    expect(log).not.toContain('current payload');
    const persisted = JSON.parse(await readFile(getMetadataPath(TASK_ID), 'utf-8')) as TaskMetadata;
    expect(persisted.channels['slack:C_DATA:1.0']).toMatchObject({ last_processed_ts: '1.0' });
  });
});
