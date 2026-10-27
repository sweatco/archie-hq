// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { replay } from './adapter.js';
import { checks, type Episode } from './types.js';
import { Cassette } from './cassette.js';

it.each(['cli', 'slack:#fixture', undefined])('retains actual worker delivery destination (%s)', async (destination) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'archie-worker-events-'));
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-only-no-sdk';
  try {
    const files = {
      'src/system/event-bus.ts': 'const listeners=[]; export const onEvent=(cb)=>listeners.push(cb); export const emit=(event)=>listeners.forEach(cb=>cb(event));',
      'src/tasks/persistence.ts': 'export const initEventPersistence=()=>{};',
      'src/agents/task-usage.ts': 'export const aggregateTaskUsage=async()=>({cost:{grand:0,costRecordedTurns:1},grand:{},transcriptTurns:1});',
      'src/tasks/task.ts': `
        import { mkdir, writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        import { emit } from '../system/event-bus.ts';
        export class Task {
          static async create(){return new Task()}
          taskId='task-20261020-1000-fixture'; pmDef={}; metadata={status:'completed'};
          agent={handle:{running:Promise.resolve()}}; linkCliChannel(){}
          async sendMessage(){
            const root=join(process.env.ARCHIE_WORKDIR,'sessions',this.taskId);
            const project=join(root,'claude/pm/session/projects/test');
            await mkdir(join(root,'shared'),{recursive:true}); await mkdir(project,{recursive:true});
            await writeFile(join(root,'shared/usage.jsonl'),JSON.stringify({subtype:'success',num_turns:1}));
            await writeFile(join(project,'current.jsonl'),JSON.stringify({type:'assistant',message:{stop_reason:'end_turn',content:[]}}));
            emit({taskId:this.taskId,type:'message',data:{from:'pm-agent',to:'user',destination:${JSON.stringify(destination)},message:'fixture reply'}});
          }
        }`,
    };
    for (const [path, source] of Object.entries(files)) {
      await mkdir(join(runtimeRoot, path, '..'), { recursive: true });
      await writeFile(join(runtimeRoot, path), source);
    }
    const episode: Episode = { id: 'worker-event', cohort: 'stress', input: { kind: 'task', messages: ['Synthetic event fixture; no model call.'] }, expected: { required: [], forbidden: [] } };
    const result = await replay(episode, { runtimeRoot, timeoutMs: 5000 });
    expect(result.deliveries).toEqual([{ audience: destination ?? 'unknown', text: 'fixture reply' }]);
    expect(checks(episode, result)).toMatchObject({ execution: true, delivery: destination === 'cli' });
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

it('reloads real completed Tasks and reapplies isolation while retaining the chronological cassette', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archie-real-task-resume-'));
  const hook = join(root, 'stub-sdk.mts');
  const turns = ['first', 'later'].map(message => ({ at: '2026-10-20T10:00:00Z', sender: 'user', message,
    tools: [{ name: 'mcp__fixture__fetch', input: { page: message }, output: { content: [{ type: 'text' as const, text: `receipt-${message}` }], isError: false } }] }));
  const cassette = new Cassette(turns);
  try {
    await writeFile(join(root, 'input.json'), JSON.stringify({ id: 'real-resume', input: { kind: 'session', catalog: [{ name: 'mcp__fixture__fetch', keys: ['page'] }] } }));
    // Only provider spawning is replaced: Task, Agent, queue, persistence, MCP and IPC remain real.
    await writeFile(hook, `
      import assert from 'node:assert/strict';
      import { mkdir, appendFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { Agent } from ${JSON.stringify(pathToFileURL(resolve('src/agents/agent.ts')).href)};
      import { Client } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
      import { InMemoryTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/inMemory.js'))};
      const seen = [], snapshots = [];
      Agent.prototype.spawn = async function(task) {
        const snapshot = { taskId: task.taskId, distinctTask: !seen.some(x => x.task === task), distinctAgent: !seen.some(x => x.agent === this), distinctQueue: !seen.some(x => x.queue === this.queue),
          persistedSession: task.metadata.agent_sessions['pm-agent']?.session_id, model: this.def.model, effort: this.def.effort, maxTurns: this.def.maxTurns,
          tools: this.def.tools, policy: structuredClone(this.def.mcpPolicy), servers: Object.keys(this.def.mcpServers) };
        seen.push({ task, agent: this, queue: this.queue }); snapshots.push(snapshot);
        const running = (async () => {
          const message = await this.queue.nextMessage();
          this.session.session_id = 'synthetic-sdk-session';
          const server = this.def.mcpServers.fixture.instance;
          const [a,b] = InMemoryTransport.createLinkedPair(); const client = new Client({name:'test',version:'1'});
          await server.connect(b); await client.connect(a);
          try { assert.equal((await client.callTool({name:'fetch',arguments:{page:message.content}})).content[0].text, 'receipt-' + message.content); }
          finally { await client.close(); await server.close(); }
          await task.postToUser('reply-' + message.content, 'pm-agent'); task.updateAgentState(false);
          const dir = join(process.env.ARCHIE_WORKDIR,'sessions',task.taskId), project = join(dir,'claude/pm/session/projects/test');
          await mkdir(project,{recursive:true});
          await appendFile(join(dir,'shared/usage.jsonl'),JSON.stringify({subtype:'success',num_turns:1})+'\\n');
          await appendFile(join(project,'current.jsonl'),JSON.stringify({type:'assistant',message:{stop_reason:'end_turn',content:[]}})+'\\n');
          await task.complete();
          assert.throws(() => this.queue.addMessage('stopped'), /Queue has been stopped/);
          await writeFile(join(process.env.ARCHIE_WORKDIR,'lifecycle.json'),JSON.stringify(snapshots));
        })();
        this.handle = { running, isRunning:true, abort(){} };
      };
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', hook, resolve('tools/replay/worker.ts')], { env: {
      PATH: process.env.PATH, HOME: root, TMPDIR: root, ARCHIE_WORKDIR: root, ARCHIE_MEMORY: 'false', ARCHIE_SECRETS_DIR: join(root, 'secrets'),
      ANTHROPIC_API_KEY: 'synthetic-no-provider', ARCHIE_PM_MODEL: 'haiku', ARCHIE_PM_EFFORT: 'low', REPLAY_MAX_TURNS: '64', REPLAY_RUNTIME_ROOT: process.cwd(),
    }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let log = ''; child.stdout!.on('data', data => log += data); child.stderr!.on('data', data => log += data);
    child.on('message', (message: any) => child.send({ id: message.id, value: message.type === 'next-turn' ? cassette.next() : cassette.call(message.name, message.input) }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    clearTimeout(timer); expect(code, log).toBe(0);
    const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
    expect(result.status, JSON.stringify(result.errors)).toBe('completed');
    expect(result.turns).toHaveLength(2); expect(result.posts).toEqual(['reply-first', 'reply-later']);
    expect(cassette.summary()).toEqual({ expected: 2, consumed: 2, complete: true, errors: [] });
    const snapshots = JSON.parse(await readFile(join(root, 'lifecycle.json'), 'utf8'));
    expect(new Set(snapshots.map((s: any) => s.taskId)).size).toBe(1);
    expect(snapshots[1].persistedSession).toBe('synthetic-sdk-session');
    for (const snapshot of snapshots) {
      expect(snapshot).toMatchObject({ distinctTask: true, distinctAgent: true, distinctQueue: true, model: 'haiku', effort: 'low', maxTurns: 64, tools: [], servers: ['fixture'] });
      expect(snapshot.policy['comms-tools']).toMatchObject({ default: 'deny', tiers: { post_to_user: 'allow' } });
      expect(snapshot.policy['orchestration-tools']).toMatchObject({ default: 'deny', tiers: { report_completion: 'allow' } });
      for (const name of ['repo-tools', 'scheduling-tools', 'research-tools', 'file-bridge', 'memory-tools', 'observation-tools']) expect(snapshot.policy[name].default).toBe('deny');
      expect(snapshot.policy.fixture.default).toBe('allow');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
