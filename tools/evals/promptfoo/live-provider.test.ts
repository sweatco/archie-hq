import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined } from '../../../src/test-support/assertions.js';
import { terminalState } from './assertions.js';
import { encodeLiveSettings, LIVE_SETTINGS_ENV } from './live-settings.js';

const TASK_ID = 'task-20260101-0900-evalfx';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', TASK_ID);

const CASE = { caseId: 'standup-reminder', turns: [{ message: 'Set up a standup reminder.' }] };

interface FakeInstance {
  url: string;
  checkout: string;
  /** Messages of the tasks created so far. */
  created: string[];
  /** While set, `POST /api/tasks` does not answer until `release()` is called. */
  holdCreates: boolean;
  release: () => void;
  /** How many of the next `POST /api/tasks` calls fail without creating a task. */
  failCreates: number;
  /** While set, the task's events stop short of the ones that settle it. */
  taskRunning: boolean;
  /** Write the usage record of the task's last turn, when the instance was started without it. */
  landLastUsage: () => Promise<void>;
}

interface FakeInstanceOptions {
  /** False for a checkout the instance was not booted from: its tasks' folders are not there. */
  taskFolderInCheckout?: boolean;
  /** Leave the usage record of the task's last turn unwritten until `landLastUsage()`. */
  withholdLastUsage?: boolean;
}

/** The fixture's events up to the PM starting its first turn. */
const EVENTS_WHILE_RUNNING = 3;

const servers: Server[] = [];
const roots: string[] = [];

/**
 * An instance that serves the synthetic fixture task: every created task has
 * the fixture's id and events, and its folder sits where an eval instance
 * keeps sessions.
 */
async function startFakeInstance(options: FakeInstanceOptions = {}): Promise<FakeInstance> {
  const checkout = await mkdtemp(join(tmpdir(), 'evals-live-'));
  roots.push(checkout);
  const sessionsDir = join(checkout, 'eval-instance', 'workdir', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  if (options.taskFolderInCheckout !== false) {
    await cp(FIXTURE, join(sessionsDir, TASK_ID), { recursive: true });
  }
  const usagePath = join(sessionsDir, TASK_ID, 'shared', 'usage.jsonl');
  const usageLines = (await readFile(join(FIXTURE, 'shared', 'usage.jsonl'), 'utf8'))
    .trimEnd()
    .split('\n');
  const lastUsage = expectDefined(usageLines.pop());
  if (options.withholdLastUsage) await writeFile(usagePath, usageLines.join('\n') + '\n');
  await writeFile(
    join(checkout, 'package-lock.json'),
    JSON.stringify({
      packages: { 'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.321' } },
    }),
  );
  const eventLines = await readFile(join(FIXTURE, 'shared', 'events.jsonl'), 'utf8');
  const events = eventLines
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

  const heldCreates: (() => void)[] = [];
  const instance: FakeInstance = {
    url: '',
    checkout,
    created: [],
    holdCreates: false,
    release: () => {
      instance.holdCreates = false;
      for (const answer of heldCreates.splice(0)) answer();
    },
    failCreates: 0,
    taskRunning: false,
    landLastUsage: () => appendFile(usagePath, lastUsage + '\n'),
  };

  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://fake');
    if (url.pathname === '/health') return send(200, { status: 'ok', git_sha: 'abc1234' });
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        if (instance.failCreates > 0) {
          instance.failCreates -= 1;
          return send(500, { error: 'Failed to create task' });
        }
        instance.created.push((JSON.parse(body) as { message: string }).message);
        const answer = () => send(201, { task_id: TASK_ID });
        if (instance.holdCreates) heldCreates.push(answer);
        else answer();
      });
      return;
    }
    if (url.pathname === `/api/tasks/${TASK_ID}/events`) {
      const after = Number(url.searchParams.get('after') ?? 0);
      const visible = instance.taskRunning ? events.slice(0, EVENTS_WHILE_RUNNING) : events;
      return send(200, { events: visible.slice(after), total: visible.length });
    }
    send(404, { error: 'not found' });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  instance.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return instance;
}

/** The provider keeps a run's budget and limits in its module, so each test loads it afresh. */
async function loadProvider(
  instance: FakeInstance,
  spendCapUsd: number,
  config: Record<string, unknown> = {},
) {
  process.env[LIVE_SETTINGS_ENV] = encodeLiveSettings({
    instances: { base: { url: instance.url, checkout: instance.checkout } },
    spendCapUsd,
  });
  const { default: LiveProvider } = await import('./live-provider.js');
  return new LiveProvider({ config: { instance: 'base', pollIntervalMs: 5, ...config } });
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  delete process.env[LIVE_SETTINGS_ENV];
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('LiveProvider', () => {
  it('plays a case over HTTP and returns the record of the task it created', async () => {
    const instance = await startFakeInstance();
    const provider = await loadProvider(instance, 1);

    const response = await provider.callApi('', { vars: CASE, repeatIndex: 1 });

    expect(instance.created).toEqual(['Set up a standup reminder.']);
    expect(response.error).toBeUndefined();
    expect(response.output).toContain('I proposed the reminder.');
    expect(response.cost).toBeCloseTo(0.12, 10);
    const metadata = expectDefined(response.metadata);
    expect(metadata.record).toMatchObject({
      source: 'eval',
      taskId: TASK_ID,
      complete: true,
      eval: { caseId: 'standup-reminder', ref: 'abc1234', trial: 1 },
    });
    expect(metadata.live).toMatchObject({
      instance: 'base',
      ref: 'abc1234',
      sdkVersion: '0.3.321',
      end: 'settled',
      turnsPlayed: 1,
      approvalsAnswered: 0,
      spend: { capUsd: 1 },
    });
    expect(metadata.live.spend.runSpentUsd).toBeCloseTo(0.12, 10);
    // The same assertions grade a live response and a replayed one.
    expect(
      terminalState('', { config: { state: 'completed' }, providerResponse: response }),
    ).toEqual({ pass: true, score: 1, reason: 'ended completed' });
  });

  it('does not start a trial the spend cap no longer covers', async () => {
    const instance = await startFakeInstance();
    const provider = await loadProvider(instance, 0.2, { trialReserveUsd: 0.1 });

    const first = await provider.callApi('', { vars: CASE });
    const second = await provider.callApi('', { vars: CASE });

    expect(first.error).toBeUndefined();
    expect(second).toEqual({
      error: 'spend cap reached: $0.12 of $0.20 spent, and the next trial may cost $0.12',
    });
    expect(instance.created).toHaveLength(1);
  });

  it('shares the spend cap between the providers of one run', async () => {
    const instance = await startFakeInstance();
    const base = await loadProvider(instance, 0.2, { trialReserveUsd: 0.1 });
    const { default: LiveProvider } = await import('./live-provider.js');
    const candidate = new LiveProvider({
      config: { instance: 'base', pollIntervalMs: 5, trialReserveUsd: 0.1 },
    });

    await base.callApi('', { vars: CASE });
    const second = await candidate.callApi('', { vars: CASE });

    expect(second.error).toContain('spend cap reached');
  });

  it('runs no more tasks at once than the instance limit', async () => {
    const instance = await startFakeInstance();
    const provider = await loadProvider(instance, 5, { maxConcurrency: 2 });
    // Until one task has been seen in the checkout, tasks are created one at a time.
    await provider.callApi('', { vars: CASE });
    instance.holdCreates = true;

    const trials = [1, 2, 3].map((repeatIndex) =>
      provider.callApi('', { vars: CASE, repeatIndex }),
    );
    await vi.waitFor(() => expect(instance.created).toHaveLength(3));
    // The third trial has had time to start and has not.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(instance.created).toHaveLength(3);

    instance.release();
    const responses = await Promise.all(trials);
    expect(instance.created).toHaveLength(4);
    expect(responses.map((response) => response.error)).toEqual([undefined, undefined, undefined]);
  });

  it('waits for the usage of the last turn, though earlier turns already recorded a cost', async () => {
    const instance = await startFakeInstance({ withholdLastUsage: true });
    const provider = await loadProvider(instance, 1, { recordSettleSeconds: 5 });

    const pending = provider.callApi('', { vars: CASE });
    // Many unchanged reads of the folder go by before the engine writes the last usage record.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await instance.landLastUsage();
    const response = await pending;

    expect(response.cost).toBeCloseTo(0.12, 10);
    const { live } = expectDefined(response.metadata);
    expect(live.costComplete).toBe(true);
    expect(live.spend.countedUsd).toBeCloseTo(0.12, 10);
  });

  it('counts the reservation and says so when the last usage never arrives', async () => {
    const instance = await startFakeInstance({ withholdLastUsage: true });
    const provider = await loadProvider(instance, 1, { recordSettleSeconds: 0.05 });

    const response = await provider.callApi('', { vars: CASE });

    expect(response.cost).toBeCloseTo(0.08, 10);
    const { live } = expectDefined(response.metadata);
    expect(live).toMatchObject({ end: 'settled', costComplete: false });
    expect(live.spend).toMatchObject({ countedUsd: 0.5, runSpentUsd: 0.5 });
  });

  it('stops after one task when the URL does not belong to the checkout', async () => {
    const instance = await startFakeInstance({ taskFolderInCheckout: false });
    const provider = await loadProvider(instance, 5, { taskFolderWaitSeconds: 0.05 });

    const trials = await Promise.allSettled(
      [0, 1, 2].map((repeatIndex) => provider.callApi('', { vars: CASE, repeatIndex })),
    );
    const later = await provider.callApi('', { vars: CASE }).catch((error: unknown) => error);

    const mismatch = `${instance.url} created ${TASK_ID}, but ${join(instance.checkout, 'eval-instance', 'workdir', 'sessions', TASK_ID)} does not exist`;
    for (const outcome of [...trials, { status: 'rejected', reason: later }]) {
      expect(outcome).toMatchObject({ status: 'rejected' });
      expect(String((outcome as PromiseRejectedResult).reason)).toContain(mismatch);
    }
    expect(instance.created).toHaveLength(1);
    // The one task that was created is paid for; the trials that never started are not.
    provider.cleanup();
    expect(vi.mocked(console.error).mock.lastCall?.[0]).toContain(
      'live[base]: 1 trial(s), $0.50; run total $0.50 of the $5.00 cap, 1 counted at their reservation',
    );
  });

  it('lets the next trial confirm the checkout when the first fails before creating a task', async () => {
    const instance = await startFakeInstance();
    instance.failCreates = 1;
    const provider = await loadProvider(instance, 1);

    const [first, second] = await Promise.allSettled(
      [0, 1].map((repeatIndex) => provider.callApi('', { vars: CASE, repeatIndex })),
    );

    expect(first?.status).toBe('rejected');
    expect(second?.status).toBe('fulfilled');
    expect(instance.created).toHaveLength(1);
    // The failed trial started no task, so only the second is paid for.
    provider.cleanup();
    expect(vi.mocked(console.error).mock.lastCall?.[0]).toContain('live[base]: 1 trial(s), $0.12;');
  });

  it('keeps a timed-out task in its slot while it is still running', async () => {
    const instance = await startFakeInstance();
    instance.taskRunning = true;
    const provider = await loadProvider(instance, 5, {
      maxConcurrency: 1,
      turnTimeoutSeconds: 0.01,
      timedOutHoldSeconds: 30,
    });

    const first = provider.callApi('', { vars: CASE, repeatIndex: 0 });
    const second = provider.callApi('', { vars: CASE, repeatIndex: 1 });
    await vi.waitFor(() => expect(instance.created).toHaveLength(1));
    // The first turn has timed out by now, but its task still runs, so the second trial waits.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(instance.created).toHaveLength(1);

    instance.taskRunning = false;
    const { live } = expectDefined((await first).metadata);
    expect(live).toMatchObject({ end: 'timed_out', stillRunning: false });
    // The recorded $0.12 is only what the task had spent when it was read.
    expect(live.spend.trialUsd).toBeCloseTo(0.12, 10);
    expect(live.spend.countedUsd).toBe(0.5);
    expect((await second).error).toBeUndefined();
    expect(instance.created).toHaveLength(2);
  });

  it('frees the slot of a task that outlasts its hold, and reports it as still running', async () => {
    const instance = await startFakeInstance();
    instance.taskRunning = true;
    const provider = await loadProvider(instance, 5, {
      maxConcurrency: 1,
      turnTimeoutSeconds: 0.01,
      timedOutHoldSeconds: 0.05,
    });

    const first = provider.callApi('', { vars: CASE, repeatIndex: 0 });
    const second = provider.callApi('', { vars: CASE, repeatIndex: 1 });
    const { live } = expectDefined((await first).metadata);

    expect(live).toMatchObject({ end: 'timed_out', stillRunning: true });
    expect(live.spend.countedUsd).toBe(0.5);
    await second;
    expect(instance.created).toHaveLength(2);
  });

  it('reports vars that are not a case without starting a task', async () => {
    const instance = await startFakeInstance();
    const provider = await loadProvider(instance, 1);

    const response = await provider.callApi('', { vars: { caseId: 'no-turns' } });

    expect(response.error).toContain("the test's vars are not a case");
    expect(instance.created).toEqual([]);
  });

  it('refuses an instance the run was not started with', async () => {
    const { default: LiveProvider } = await import('./live-provider.js');

    expect(() => new LiveProvider({ config: { instance: 'candidate' } })).toThrow(
      'no eval instance "candidate" in this run',
    );
  });
});
