// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ReplayResult } from './types.js';
import { REPLAY_NATIVE_TOOLS } from './sdk-tools.js';
import { runtimeDiagnostics, sdkExecutionErrors } from './diagnostics.js';
import { recordedTools } from './recorded-tools.js';

const root = process.env.ARCHIE_WORKDIR!;
const { id, input, concise } = JSON.parse(await readFile(join(root, 'input.json'), 'utf8'));
const result: ReplayResult = { id, mode: ['task', 'session'].includes(input.kind) ? 'fresh-sdk' : 'recorded-component', posts: [], deliveries: [],
  status: 'completed', errors: [], elapsedMs: 0, firstPostMs: null, words: 0,
  usage: { sdkUsd: null, backgroundUsd: null, coverage: 'No inference: recorded component decisions.' } };
let requestId = 0;
const pending = new Map<number, (value: any) => void>();
process.on('message', (message: any) => { pending.get(message.id)?.(message.value); pending.delete(message.id); });
const request = (type: string, data: object = {}) => new Promise<any>((done) => { const id = ++requestId; pending.set(id, done); process.send!({ id, type, ...data }); });
const runtime = (path: string) => import(pathToFileURL(join(process.env.REPLAY_RUNTIME_ROOT!, path)).href);

async function taskReplay() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Fresh SDK replay requires ANTHROPIC_API_KEY');
  const plugins = join(root, 'plugins');
  await mkdir(plugins);
  await writeFile(join(plugins, 'archie.json'), JSON.stringify({ allowedNetworkDomains: [] }));
  await writeFile(join(plugins, 'pm.md'), concise ? 'Keep the user-facing answer concise while preserving every requested fact.' : '');
  const { Task } = await runtime('src/tasks/task.ts') as typeof import('../../src/tasks/task.js');
  const { onEvent } = await runtime('src/system/event-bus.ts') as typeof import('../../src/system/event-bus.js');
  const { aggregateTaskUsage } = await runtime('src/agents/task-usage.ts') as typeof import('../../src/agents/task-usage.js');
  const { initEventPersistence } = await runtime('src/tasks/persistence.ts') as typeof import('../../src/tasks/persistence.js');
  initEventPersistence();
  let task = await Task.create();
  const taskId = task.taskId;
  const configure = () => {
    task.linkCliChannel();
    task.pmDef.tools = REPLAY_NATIVE_TOOLS;
    task.pmDef.model = process.env.ARCHIE_PM_MODEL!;
    task.pmDef.effort = process.env.ARCHIE_PM_EFFORT as 'low' | 'medium' | 'high';
    task.pmDef.maxTurns = Number(process.env.REPLAY_MAX_TURNS);
    if (input.kind === 'session') task.pmDef.mcpServers = recordedTools(input.catalog, (name, input) => request('recorded-tool', { name, input }));
    task.pmDef.mcpPolicy = {};
    for (const name of ['comms-tools', 'orchestration-tools', 'repo-tools', 'scheduling-tools', 'research-tools', 'file-bridge', 'memory-tools', 'observation-tools']) {
      task.pmDef.mcpPolicy[name] = { default: 'deny', tiers: {}, titles: {} };
    }
    task.pmDef.mcpPolicy['comms-tools'].tiers.post_to_user = 'allow';
    task.pmDef.mcpPolicy['orchestration-tools'].tiers.report_completion = 'allow';
    if (input.kind === 'session') for (const name of Object.keys(task.pmDef.mcpServers ?? {})) task.pmDef.mcpPolicy[name] = { default: 'allow', tiers: {}, titles: {} };
  };
  configure();
  const start = performance.now();
  onEvent((event) => {
    if (event.taskId !== taskId) return;
    if (event.type === 'message' && event.data.from === 'pm-agent' && event.data.to === 'user') {
      const text = String(event.data.message);
      result.posts.push(text); result.deliveries.push({ audience: typeof event.data.destination === 'string' ? event.data.destination : 'unknown', text });
      result.firstPostMs ??= performance.now() - start;
    }
    if (event.type === 'approval:requested') result.errors.push('Unexpected approval request');
  });
  try {
    let turn = 0;
    while (true) {
      const next = input.kind === 'session' ? await request('next-turn') : input.messages[turn] ? { message: input.messages[turn] } : null;
      if (!next) break;
      if (turn) {
        // Production ingress reloads parked tasks; their old agent queue is stopped.
        task = await Task.get(taskId);
        configure();
      }
      const message = next.message;
      const before = { posts: result.posts.length, deliveries: result.deliveries.length, at: performance.now() };
      await task.sendMessage(message);
      while (task.metadata.status === 'in_progress') await new Promise((done) => setTimeout(done, 100));
      if (task.agent?.handle) await task.agent.handle.running;
      if (task.metadata.status !== 'completed') throw new Error(`Task settled as ${task.metadata.status}`);
      if (input.kind === 'session') (result.turns ??= []).push({ posts: result.posts.slice(before.posts).filter((post) => post.trim()).length,
        deliveries: result.deliveries.slice(before.deliveries).filter((delivery) => delivery.text.trim()).length,
        words: result.posts.slice(before.posts).join(' ').match(/\S+/g)?.length ?? 0, elapsedMs: performance.now() - before.at });
      turn++;
    }
  } finally {
    result.elapsedMs = performance.now() - start;
    // Usage persistence is queued independently of task settlement.
    await new Promise((done) => setTimeout(done, 50));
    const usage = await aggregateTaskUsage(task.taskId);
    result.usage = { sdkUsd: usage.cost?.grand ?? null, backgroundUsd: null, tokens: usage.grand,
      coverage: `SDK cumulative query cost including subagents; ${usage.cost?.costRecordedTurns ?? 0} recorded results, ${usage.transcriptTurns} transcript turns. Background extraction disabled; no grader model.` };
    result.diagnostics = await runtimeDiagnostics(join(root, 'sessions', task.taskId));
    result.errors.push(...sdkExecutionErrors(result.diagnostics));
  }
}

async function componentReplay() {
  const { InitiativeStore } = await runtime('src/proactivity/store.ts') as typeof import('../../src/proactivity/store.js');
  const { InitiativeService } = await runtime('src/proactivity/service.ts') as typeof import('../../src/proactivity/service.js');
  const { ObservationRecall } = await runtime('src/proactivity/recall.ts') as typeof import('../../src/proactivity/recall.js');
  const now = Date.parse('2026-10-20T10:00:00Z');
  const ts = '1792490401.000001';
  const store = new InitiativeStore(join(root, 'state.sqlite'), 'T1', now);
  let accessible = true;
  const slack: import('../../src/proactivity/slack.js').ObservationSlack = {
    inspect: async (channel) => accessible && channel === 'C1' ? { shared: false, ownerCanRead: true } : null,
    channels: async () => ['C1'],
    page: async () => ({ messages: store.snapshot('C1', ts)?.evidence ?? [] }),
    ownerDm: async () => 'D1', verifyDm: async (channel) => channel === 'D1',
    send: async (delivery) => { result.deliveries.push({ audience: delivery.channel, text: delivery.text }); return ts; },
    find: async () => undefined, active: () => false, link: (channel, thread) => `https://slack.test/${channel}/${thread}`,
  };
  let calls = 0;
  const model: import('../../src/proactivity/model.js').BackgroundModel = {
    complete: async (request) => {
      const evidence = store.snapshot('C1', ts)!.evidence.map((e) => e.id);
      // Keep both ticks in one deadline phase so this fixture measures duplicate suppression.
      const response = calls++ === 0 ? { threads: [{ channel: 'C1', thread: ts,
        observations: [{ key: 'release', text: 'Release Friday', kind: 'commitment', evidence }],
        matters: [{ key: 'release', title: 'Release', detail: 'Release Friday', evidence, state: 'open', owner: 'U1', deadline: { date: '2026-10-20', time: '12:01', timeZone: 'Europe/Lisbon' }, explicit: true }],
      }] } : { resolved: false, help: 'I can prepare the release checklist.', public: false, evidence };
      return request.schema.parse(response);
    },
  };
  const service = new InitiativeService(store, slack, model, { mode: 'live', owner: 'U1', extractionModel: 'recorded', investigationModel: 'recorded' }, () => now);
  const start = performance.now();
  try {
    store.channel('C1', true, false);
    const source = { channel: 'C1', thread: ts, ts, version: ts, author: 'U1', text: 'I will release Friday' };
    store.record(source, now);
    if (input.mutation === 'duplicate') store.record(source, now);
    store.schedule('extract', 'global', now);
    await service.tick(now, true);
    if (input.kind === 'memory') {
      const recall = new ObservationRecall(store, slack);
      const metadata = (taskId: string) => ({ task_id: taskId, channels: {}, memory_destination: { channel_id: 'C1' } }) as import('../../src/types/task.js').TaskMetadata;
      await recall.search(metadata('task-20261020-1000-learn'), 'release', 5);
      if (input.mutation === 'stale') {
        store.record({ ...source, version: '1792490500.000001', text: 'Correction: release Monday' }, now + 100_000);
        const snapshot = store.snapshot('C1', ts)!;
        store.apply([snapshot], [{ id: 'release-monday', channel: 'C1', thread: ts, text: 'Release Monday', kind: 'change', evidence: snapshot.evidence.map((e) => e.id) }], []);
      }
      accessible = input.mutation !== 'revoke';
      const hits = await recall.search(metadata('task-20261020-1100-recall'), 'release', 5);
      result.posts = hits.map((hit) => hit.text);
    } else {
      await service.tick(now + 60_000, true);
      if (input.mutation === 'cancel') store.record({ ...source, version: '1792490500.000001', text: 'Cancelled' }, now + 60_000);
      accessible = input.mutation !== 'revoke';
      store.set('delivery_enabled', 'true');
      await service.deliver(now + 60_000);
      await service.deliver(now + 120_000);
      result.posts = result.deliveries.map((delivery) => delivery.text);
    }
    result.elapsedMs = performance.now() - start;
  } finally { service.stop(); store.close(); }
}

async function taskMemoryReplay() {
  process.env.ARCHIE_MEMORY = 'true';
  const { setMemoryReady } = await runtime('src/memory/paths.ts') as typeof import('../../src/memory/paths.js');
  const { applyUserUpdatesWithIdentity } = await runtime('src/memory/store.ts') as typeof import('../../src/memory/store.js');
  const { buildMemoryContext } = await runtime('src/memory/context.ts') as typeof import('../../src/memory/context.js');
  const { getAuthorizedMemoryAuthors } = await runtime('src/memory/task-authors.ts') as typeof import('../../src/memory/task-authors.js');
  const { Task } = await runtime('src/tasks/task.ts') as typeof import('../../src/tasks/task.js');
  await mkdir(join(root, 'plugins'));
  setMemoryReady(true);
  const start = performance.now();
  const source = await Task.create();
  source.metadata.memory_authors = { U12345678: 'Morgan' };
  await applyUserUpdatesWithIdentity('U12345678', 'Morgan', [{ action: 'add', section: 'Preferences', content: 'Release updates arrive Friday.' }]);
  if (input.mutation === 'stale') await applyUserUpdatesWithIdentity('U12345678', 'Morgan', [{ action: 'update', old: 'Release updates arrive Friday.', content: 'Release updates arrive Monday.' }]);
  const later = await Task.create();
  if (later.taskId === source.taskId) throw new Error('Recall requires a distinct task');
  later.metadata.memory_authors = input.mutation === 'revoke' ? {} : { U12345678: 'Morgan' };
  result.posts = [await buildMemoryContext(getAuthorizedMemoryAuthors(later.metadata))];
  result.elapsedMs = performance.now() - start;
}

try {
  await (['task', 'session'].includes(input.kind) ? taskReplay() : input.kind === 'task-memory' ? taskMemoryReplay() : componentReplay());
} catch (error) { result.status = 'failed'; result.errors.push(error instanceof Error ? error.message : String(error)); }
result.words = result.posts.join(' ').match(/\S+/g)?.length ?? 0;
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
// Task timers are process-owned; no runtime survives an arm.
process.exit(0);
