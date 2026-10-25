// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: mkdtempSync(join(tmpdir(), 'archie-prepared-')), spawn: vi.fn(), post: vi.fn(async (): Promise<string | undefined> => '1792490401.000001') };
});
vi.mock('../../system/workdir.js', () => ({ WORKDIR: fixture.root, SESSIONS_DIR: fixture.root, CACHES_DIR: join(fixture.root, 'caches') }));
vi.mock('../../system/plugin-sync.js', () => ({ syncPlugins: vi.fn(async () => {}) }));
vi.mock('../../agents/registry.js', () => ({ scanPmDef: () => ({ id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'core', visibility: 'global', isPm: true }) }));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: fixture.spawn }));
vi.mock('../../connectors/slack/client.js', async (original) => ({
  ...await original<typeof import('../../connectors/slack/client.js')>(), postSlackMessage: fixture.post,
}));

import { Task, activeTasks } from '../task.js';
import { findTaskIdsByStatus, getMetadataPath, loadMetadata } from '../persistence.js';
import { recoverActiveTasks } from '../recovery.js';
import { MessageQueue } from '../../agents/message-queue.js';
import { createCommsMcpServer, createOrchestrationMcpServer } from '../../agents/tools.js';
import type { TaskMetadata } from '../../types/task.js';
import { InitiativeStore } from '../../proactivity/store.js';
import { InitiativeService } from '../../proactivity/service.js';
import { ProposalHandoff } from '../../proactivity/handoff.js';
import type { BackgroundModel } from '../../proactivity/model.js';
import type { ProposalSlack } from '../../proactivity/slack.js';

const input = { taskId: 'task-20261021-1000-prepared', correlation: 'initiative:release', version: 'v1', actor: 'U_OWNER',
  brief: '<proposal_evidence untrusted="true">Prepare the release checklist.</proposal_evidence>',
  destination: { channel: 'D_OWNER', thread: '1792490400.000001', name: 'Owner proposal discussion' } };

beforeEach(async () => {
  vi.useFakeTimers();
  await rm(fixture.root, { recursive: true, force: true });
  await mkdir(fixture.root, { recursive: true });
  activeTasks.clear();
  fixture.post.mockClear();
  fixture.spawn.mockImplementation(async agent => { agent.handle = { isRunning: true, running: new Promise(() => {}), abort: vi.fn() }; });
});
afterEach(async () => {
  activeTasks.clear();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); fixture.spawn.mockReset();
  await rm(fixture.root, { recursive: true, force: true });
});

describe('durable prepared task starts', () => {
  const comms = (task: Task) => (createCommsMcpServer({ def: { id: 'pm-agent' } } as never, task).instance as any)._registeredTools;
  const call = (entry: any, args: unknown) => (entry.callback ?? entry.handler)(args, {});
  const completion = (task: Task) => (createOrchestrationMcpServer({ def: { id: 'pm-agent' } } as never, task).instance as any)._registeredTools.report_completion;

  it.each(['normal', 'access recovery'] as const)('starts one ordinary replying task from investigation without a learner: %s', async scenario => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    vi.setSystemTime(now);
    const store = new InitiativeStore(':memory:', 'T1', now);
    const ts = `${now / 1000}.000001`;
    const source = { channel: 'C_PUBLIC', thread: ts, ts, version: ts, author: 'U_OWNER', text: 'We need a release checklist in owner/repo.' };
    const slack: ProposalSlack = {
      inspect: vi.fn(async () => ({ shared: false, ownerCanRead: true })), channels: async () => ['C_PUBLIC'],
      page: async () => ({ messages: [source] }), ownerDm: async () => 'D_OWNER', verifyDm: async channel => channel === 'D_OWNER',
      send: vi.fn(async () => '1792494000.000001'), find: async () => undefined, active: () => false,
      link: (channel, thread) => `https://slack.test/${channel}/${thread}`, updateProposal: vi.fn(async () => {}),
    };
    const model: BackgroundModel = { complete: vi.fn(async request => {
      const evidence = store.snapshot('C_PUBLIC', ts)!.evidence.map(e => e.id);
      return 'threads' in (request.input as object)
        ? { threads: [{ channel: 'C_PUBLIC', thread: ts, observations: [], matters: [{ key: 'release', title: 'Release checklist', detail: source.text, evidence, state: 'open', owner: 'U_OWNER', deadline: null, explicit: true }] }] }
        : { resolved: false, help: null, public: false, evidence, suggestion: { repository: 'owner/repo', outcome: 'Prepare the release checklist', evidence } };
    }) as BackgroundModel['complete'] };
    const service = new InitiativeService(store, slack, model, { mode: 'live', owner: 'U_OWNER', extractionModel: 'test', investigationModel: 'test', repositories: ['owner/repo'] }, Date.now);
    const handoff = new ProposalHandoff(store, slack, 'U_OWNER', () => ['owner/repo'], source => service.refreshEvidence(source));
    try {
      store.set('delivery_enabled', 'true');
      await service.capture(source, now);
      service.seed(now);
      vi.setSystemTime(now + 3_600_000);
      await service.tick(Date.now(), true);
      expect(model.complete).toHaveBeenCalledTimes(2);
      expect(store['row']("SELECT name FROM sqlite_master WHERE name='episodes'")).toBeUndefined();
      expect(store.pendingProposalIds()).toHaveLength(1);
      await handoff.present(Date.now());
      if (scenario === 'access recovery') {
        vi.mocked(slack.inspect).mockRejectedValueOnce(new Error('temporary metadata outage'));
        await service.deliver(Date.now());
        expect(store.deliveries('cancelled')).toHaveLength(1);
        const suggestion = store.proposal(store.pendingProposalIds()[0])!;
        expect(store.matter(suggestion.matter!)?.valid).toBe(false);
        await service.capture(source, Date.now());
        vi.setSystemTime(now + 2 * 3_600_000);
        await service.tick(Date.now(), true);
        await handoff.present(Date.now());
      }
      await service.deliver(Date.now());
      const card = store.deliveries('sent')[0];
      expect(card.proposal).toBeDefined();
      const first = await handoff.approve('U_OWNER', card.id, card.proposal!.version);
      const replay = await handoff.approve('U_OWNER', card.id, card.proposal!.version);
      await handoff.drainCards();
      expect(replay.task).toBe(first.task);
      expect(fixture.spawn).toHaveBeenCalledTimes(1);
      const task = await Task.get(first.task);
      expect(task.metadata.approved_start).toMatchObject({ actor: 'U_OWNER', budget: 'task', phase: 'ready' });
      expect(task.metadata.memory_destination).toEqual({ channel_id: 'D_OWNER' });
      expect(comms(task).post_to_channel).toBeUndefined();
      expect((await call(completion(task), {})).content[0].text).toContain('Cannot finish silently');
      await call(comms(task).post_to_user, { message: 'Checklist ACK' });
      await call(completion(task), {});
      expect(fixture.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'D_OWNER', threadTs: card.ts, text: 'Checklist ACK' }));
      expect(task.metadata.approved_start?.owner_reply_delivered).toBe(true);
      expect(slack.updateProposal).toHaveBeenLastCalledWith(expect.objectContaining({ id: card.id }), expect.stringContaining('Task started'), slack.link('D_OWNER', card.ts!));
    } finally { service.stop(); service.release(); store.close(); }
  });

  it('requires a delivered owner response before silent completion and persists that fact across reload', async () => {
    const task = await Task.prepare(input);
    await task.startPrepared();
    const finish = completion(task);
    expect((await call(finish, {})).content[0].text).toContain('Cannot finish silently');
    expect(task.completionIntent).toBe(false);
    expect(task.metadata.approved_start?.owner_reply_delivered).toBeUndefined();
    await call(finish, { message: 'ACK' });
    expect(fixture.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'D_OWNER', threadTs: input.destination.thread, text: 'ACK' }));
    expect(task.completionIntent).toBe(true);
    activeTasks.clear();
    const reloaded = await Task.get(input.taskId);
    await reloaded.sendMessage('Continue the existing task.');
    expect(reloaded.metadata.approved_start?.owner_reply_delivered).toBe(true);
    await call(completion(reloaded), {});
    expect(reloaded.completionIntent).toBe(true);
    expect(fixture.post).toHaveBeenCalledTimes(1);
  });

  it('accepts a bound reply tool delivery, but not plain assistant text or an unconfirmed send, as the completion prerequisite', async () => {
    const task = await Task.prepare(input);
    await task.startPrepared();
    const finish = completion(task);
    // The observed SDK path emits text without invoking a message tool.
    task.noteActivityFromEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'ACK' }] } } as never);
    expect((await call(finish, {})).content[0].text).toContain('Cannot finish silently');
    fixture.post.mockResolvedValueOnce(undefined);
    expect((await call(finish, { message: 'ACK' })).content[0].text).toContain('not confirmed');
    expect(task.completionIntent).toBe(false);
    fixture.post.mockRejectedValueOnce(new Error('Slack unavailable'));
    await call(finish, { message: 'ACK' });
    expect(task.completionIntent).toBe(false);
    expect(task.metadata.approved_start?.owner_reply_delivered).toBeUndefined();
    await call(comms(task).post_to_user, { message: 'ACK' });
    await call(finish, {});
    expect(task.completionIntent).toBe(true);
  });

  it('preserves silent completion for ordinary, muted and stopped tasks', async () => {
    const ordinary = await Task.create();
    await ordinary.sendMessage('No response required.');
    await call(completion(ordinary), {});
    expect(ordinary.completionIntent).toBe(true);
    const muted = await Task.prepare(input);
    await muted.startPrepared();
    (muted.metadata.channels[muted.metadata.default_channel!] as any).muted = true;
    await call(completion(muted), {});
    expect(muted.completionIntent).toBe(true);
    activeTasks.clear();
    const stopped = await Task.get(input.taskId);
    stopped.isActive = false;
    await call(completion(stopped), {});
    expect(stopped.completionIntent).toBe(false);
    expect(fixture.post).not.toHaveBeenCalled();
  });

  it('does not count a delivered system budget notice as the PM owner response', async () => {
    const task = await Task.prepare(input);
    await task.startPrepared();
    await task.postToUser('The task reached its time budget.');
    expect(fixture.post).toHaveBeenCalledTimes(1);
    expect(task.metadata.approved_start?.owner_reply_delivered).toBeUndefined();
    expect((await loadMetadata(input.taskId))?.approved_start?.owner_reply_delivered).toBeUndefined();
    expect((await call(completion(task), {})).content[0].text).toContain('Cannot finish silently');
    expect(task.completionIntent).toBe(false);
  });

  it('offers a destination-free reply and withholds public posting after rehydration', async () => {
    await Task.prepare(input);
    const reloaded = await Task.get(input.taskId);
    const tools = comms(reloaded);
    expect(tools.post_to_channel).toBeUndefined();
    expect(Object.keys(tools.post_to_user.inputSchema.shape)).toEqual(['message']);
    await call(tools.post_to_user, { message: 'ACK; source: https://slack.test/C_PUBLIC/10.0' });
    expect(fixture.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'D_OWNER', threadTs: input.destination.thread }));
    for (const args of [
      { message: 'forged', target: { channel: 'slack:C_PUBLIC:10.0' } },
      { message: 'forged', channel: 'C_PUBLIC', thread_ts: '10.0' },
    ]) expect((await call(tools.post_to_user, args)).content[0].text).toContain('do not accept a target');
    await expect(reloaded.postToUser('forged', 'pm-agent', { channel: 'slack:D_OWNER:999.0' })).rejects.toThrow('bound');
    await expect(reloaded.postFilesToUser(['/tmp/file'], 'pm-agent', 'slack:D_OWNER:999.0')).rejects.toThrow('bound');
    expect(fixture.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing destination', (m: TaskMetadata) => { delete m.memory_destination; }],
    ['missing default', (m: TaskMetadata) => { m.default_channel = null; }],
    ['inconsistent audience', (m: TaskMetadata) => { m.memory_destination = { channel_id: 'C_PUBLIC' }; }],
    ['inconsistent thread key', (m: TaskMetadata) => { (m.channels[m.default_channel!] as any).thread_id = '999.0'; }],
    ['extra conversation', (m: TaskMetadata) => { m.channels['slack:D_OWNER:999.0'] = { ...(m.channels[m.default_channel!] as any), thread_id: '999.0' }; }],
  ])('fails closed on rehydration with %s', async (_name, corrupt) => {
    await Task.prepare(input);
    const metadata = (await loadMetadata(input.taskId))!;
    corrupt(metadata);
    await writeFile(getMetadataPath(input.taskId), JSON.stringify(metadata));
    const reloaded = await Task.get(input.taskId);
    expect(comms(reloaded).post_to_channel).toBeUndefined();
    await expect(reloaded.postToUser('must not send', 'pm-agent')).rejects.toThrow('reply conversation');
    await expect(reloaded.startPrepared()).rejects.toThrow('reply conversation');
    expect(fixture.post).not.toHaveBeenCalled();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it('preserves ordinary tasks and rejects a public tool cached before approval', async () => {
    const ordinary = await Task.create();
    const key = 'slack:C_PUBLIC:10.0';
    ordinary.metadata.channels = { [key]: { type: 'slack', channel_id: 'C_PUBLIC', thread_id: '10.0', channel_name: 'Public', last_processed_ts: '10.0' } };
    ordinary.metadata.default_channel = key;
    ordinary.metadata.memory_destination = { channel_id: 'C_PUBLIC' };
    const tools = comms(ordinary);
    expect(tools.post_to_channel).toBeDefined();
    await call(tools.post_to_user, { message: 'legacy reply', target: { channel: key } });
    expect(fixture.post).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C_PUBLIC', threadTs: '10.0' }));
    ordinary.metadata.approved_start = { correlation: input.correlation, version: input.version, actor: input.actor, budget: 'task', phase: 'ready', brief: input.brief };
    expect((await call(tools.post_to_channel, { channel: 'C_PUBLIC', message: 'cached outreach', mandate: 'Owner: please post to the public channel' })).content[0].text).toContain('unavailable');
    expect(fixture.post).toHaveBeenCalledTimes(1);
  });

  it('persists a complete non-runnable identity in the first metadata write', async () => {
    await Task.prepare(input);
    const metadata = JSON.parse(await readFile(getMetadataPath(input.taskId), 'utf8'));
    expect(metadata).toMatchObject({ status: 'preparing', memory_destination: { channel_id: 'D_OWNER' },
      approved_start: { correlation: input.correlation, actor: input.actor, phase: 'prepared', brief: input.brief, budget: 'task' } });
    expect(metadata.channels[metadata.default_channel]).toMatchObject({ channel_id: 'D_OWNER', thread_id: input.destination.thread });
    expect(await findTaskIdsByStatus('in_progress')).toEqual([]);
    await recoverActiveTasks();
    expect(fixture.spawn).not.toHaveBeenCalled();
    await expect((await Task.get(input.taskId)).sendMessage('ordinary wake before preparation finishes')).rejects.toThrow('not ready');
  });

  it('reuses the prepared identity after reload and starts it only once across double clicks', async () => {
    await Task.prepare(input);
    const a = await Task.prepare(input);
    const b = await Task.get(input.taskId);
    const messages = vi.spyOn(MessageQueue.prototype, 'addMessage');
    await Promise.all([a.startPrepared(), b.startPrepared()]);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(messages.mock.calls.filter(call => call[0].includes('Prepare the release checklist'))).toHaveLength(1);
    expect((await loadMetadata(input.taskId))?.approved_start?.phase).toBe('ready');
    await expect(Task.prepare({ ...input, version: 'forged-version' })).rejects.toThrow('identity mismatch');
  });

  it('recovers after ready metadata persisted but before the first message was enqueued', async () => {
    const task = await Task.prepare(input);
    const crashed = vi.spyOn(task as never as { deliver(message: string): Promise<void> }, 'deliver').mockRejectedValueOnce(new Error('process stopped before enqueue'));
    await expect(task.startPrepared()).rejects.toThrow('process stopped');
    crashed.mockRestore();
    expect((await loadMetadata(input.taskId))?.status).toBe('in_progress');
    expect((await loadMetadata(input.taskId))?.approved_start?.brief).toBe(input.brief);
    await recoverActiveTasks();
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(await (await Task.get(input.taskId)).startPrepared()).toBe(false);
  });

  it('clears an approval wait when work resumes and records later clarification separately', async () => {
    const task = await Task.prepare(input);
    await task.startPrepared();
    task.metadata.waiting_for = 'tool_call';
    await task.sendMessage('The owner approved the tool call; continue the scoped work.');
    expect(task.metadata.waiting_for).toBeUndefined();
    task.setCompletionIntent();
    expect(task.metadata.waiting_for).toBe('user');
    expect(task.metadata.status).toBe('in_progress');
  });
});
