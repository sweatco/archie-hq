import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const workdir = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtemp(join(tmpdir(), 'archie-slack-ingress-'));
});

vi.mock('../../../system/workdir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../system/workdir.js')>()),
  WORKDIR: workdir,
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { system: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  enqueueSlackIngress,
  startSlackIngress,
  stopSlackIngress,
  waitForSlackIngressIdle,
  type SlackIngressRef,
} from '../ingress.js';

const ingressDir = join(workdir, 'slack', 'ingress');
const ref: SlackIngressRef = {
  type: 'app_mention', channel: 'C123', user: 'U123', ts: '1700000000.000100',
};

async function records(): Promise<string[]> {
  try {
    return (await readdir(ingressDir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

async function deadRecords(): Promise<string[]> {
  try {
    return (await readdir(ingressDir)).filter((name) => name.endsWith('.json.dead')).sort();
  } catch {
    return [];
  }
}

async function invalidRecords(): Promise<string[]> {
  try {
    return (await readdir(ingressDir)).filter((name) => name.endsWith('.invalid')).sort();
  } catch {
    return [];
  }
}

beforeEach(async () => {
  await stopSlackIngress();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
  await rm(ingressDir, { recursive: true, force: true });
});

afterEach(async () => {
  await stopSlackIngress();
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('durable Slack ingress', () => {
  it('persists one private content-free record for duplicate delivery', async () => {
    const eventWithPayload = { ...ref, text: 'do not persist me', files: [{ name: 'secret.txt' }] };

    await Promise.all([
      enqueueSlackIngress(eventWithPayload),
      enqueueSlackIngress(eventWithPayload),
    ]);

    const names = await records();
    expect(names).toHaveLength(1);
    const path = join(ingressDir, names[0]);
    const raw = await readFile(path, 'utf-8');
    expect(raw).not.toContain('do not persist me');
    expect(raw).not.toContain('secret.txt');
    expect(JSON.parse(raw)).toMatchObject({
      attempts: 0,
      ref: { type: ref.type, channel: ref.channel, user: ref.user, ts: ref.ts },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('replays a pending record after startup and removes it on success', async () => {
    await enqueueSlackIngress(ref);
    const process = vi.fn().mockResolvedValue({ status: 'complete' });

    await startSlackIngress(process);
    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();

    expect(process).toHaveBeenCalledOnce();
    expect(process).toHaveBeenCalledWith(ref, expect.objectContaining({ checkpoint: expect.any(Function) }));
    expect(await records()).toEqual([]);
  });

  it('retries a checkpointed wake without another Slack event', async () => {
    const process = vi.fn()
      .mockImplementationOnce(async (_ref, recovery) => {
        await recovery.checkpoint('existing');
        throw Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error' });
      })
      .mockImplementationOnce(async (_ref, recovery) => {
        expect(recovery.wake).toBe('existing');
        return { status: 'complete' };
      });
    await startSlackIngress(process);
    await enqueueSlackIngress(ref);

    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();
    expect(process).toHaveBeenCalledTimes(1);
    const pending = await records();
    expect(pending).toHaveLength(1);
    expect(JSON.parse(await readFile(join(ingressDir, pending[0]), 'utf-8'))).toMatchObject({
      attempts: 1,
      wake: 'existing',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await waitForSlackIngressIdle();
    expect(process).toHaveBeenCalledTimes(2);
    expect(await records()).toEqual([]);
  });

  it('discards a deterministic terminal outcome', async () => {
    const process = vi.fn().mockResolvedValue({ status: 'terminal', reason: 'external_author' });
    await startSlackIngress(process);
    await enqueueSlackIngress({ ...ref, text: 'external payload' } as SlackIngressRef);

    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();

    expect(await records()).toEqual([]);
    expect(await deadRecords()).toEqual([]);

    await enqueueSlackIngress(ref);
    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('retains only exhausted retries as metadata-only dead records', async () => {
    await startSlackIngress(vi.fn().mockRejectedValue(new Error('still unavailable')));
    await enqueueSlackIngress({ ...ref, text: 'external payload' } as SlackIngressRef);

    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();
    for (const delay of [60_000, 120_000, 240_000, 480_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await waitForSlackIngressIdle();
    }

    expect(await records()).toEqual([]);
    const names = await deadRecords();
    expect(names).toHaveLength(1);
    const raw = await readFile(join(ingressDir, names[0]), 'utf-8');
    expect(raw).not.toContain('external payload');
    expect(JSON.parse(raw)).toMatchObject({ state: 'dead', reason: 'retry_exhausted', attempts: 5 });
  });

  it('quarantines an invalid active record so it cannot suppress redelivery', async () => {
    await enqueueSlackIngress(ref);
    const [name] = await records();
    await writeFile(join(ingressDir, name), '{invalid', 'utf-8');
    const process = vi.fn().mockResolvedValue({ status: 'complete' });

    await startSlackIngress(process);
    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();

    expect(await records()).toEqual([]);
    expect(await invalidRecords()).toHaveLength(1);

    await enqueueSlackIngress(ref);
    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();
    expect(process).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight record during shutdown', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const processing = new Promise<{ status: 'complete' }>((resolve) => {
      release = () => resolve({ status: 'complete' });
    });
    await startSlackIngress(vi.fn().mockImplementation(() => {
      markStarted();
      return processing;
    }));
    await enqueueSlackIngress(ref);
    await vi.runOnlyPendingTimersAsync();
    await started;

    let stopped = false;
    const stopping = stopSlackIngress().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(await records()).toEqual([]);
  });

  it('bounds shutdown waiting and leaves unfinished work durable', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const processing = new Promise<{ status: 'complete' }>((resolve) => {
      release = () => resolve({ status: 'complete' });
    });
    await startSlackIngress(vi.fn().mockImplementation(() => {
      markStarted();
      return processing;
    }));
    await enqueueSlackIngress(ref);
    await vi.runOnlyPendingTimersAsync();
    await started;

    const stopping = stopSlackIngress();
    await vi.advanceTimersByTimeAsync(30_000);
    await stopping;
    expect(await records()).toHaveLength(1);

    release();
    await waitForSlackIngressIdle();
  });

  it('drains more than one concurrency batch without repeated scans', async () => {
    const process = vi.fn().mockResolvedValue({ status: 'complete' });
    await startSlackIngress(process);
    await Promise.all(Array.from({ length: 6 }, (_, index) => enqueueSlackIngress({
      ...ref,
      channel: `C${index}`,
    })));

    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();

    expect(process).toHaveBeenCalledTimes(6);
    expect(await records()).toEqual([]);
  });

  it('keeps draining other threads when one processor remains active', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const stalled = new Promise<{ status: 'complete' }>((resolve) => {
      release = () => resolve({ status: 'complete' });
    });
    const process = vi.fn().mockImplementation((input: SlackIngressRef) => {
      if (input.channel === 'C0') {
        markStarted();
        return stalled;
      }
      return Promise.resolve({ status: 'complete' });
    });
    await startSlackIngress(process);
    await Promise.all(Array.from({ length: 5 }, (_, index) => enqueueSlackIngress({
      ...ref,
      channel: `C${index}`,
    })));

    await vi.advanceTimersByTimeAsync(0);
    await started;
    let pending = await records();
    for (let attempt = 0; attempt < 200 && pending.length > 2; attempt += 1) {
      await readdir(ingressDir);
      pending = await records();
    }
    expect(pending).toHaveLength(2);
    await vi.runOnlyPendingTimersAsync();
    for (let attempt = 0; attempt < 200 && process.mock.calls.length < 5; attempt += 1) {
      await readdir(ingressDir);
    }

    try {
      expect(process.mock.calls.map(([input]) => input.channel)).toContain('C4');
      expect(await records()).toContain('C0-1700000000.000100.json');
    } finally {
      release();
    }
    await waitForSlackIngressIdle();
    expect(await records()).toEqual([]);
  });

  it('fills a freed slot while an infrastructure-failed record cools down', async () => {
    let release!: () => void;
    const stalled = new Promise<{ status: 'complete' }>((resolve) => {
      release = () => resolve({ status: 'complete' });
    });
    const failedTemporaryPath = `${join(ingressDir, 'C0-1700000000.000100.json')}.${process.pid}.tmp`;
    const processor = vi.fn().mockImplementation(async (input: SlackIngressRef) => {
      if (input.channel === 'C0') {
        await mkdir(failedTemporaryPath, { recursive: true });
        throw new Error('processor failure before persistence failure');
      }
      if (input.channel !== 'C4') return stalled;
      return { status: 'complete' };
    });
    await startSlackIngress(processor);
    await Promise.all(Array.from({ length: 5 }, (_, index) => enqueueSlackIngress({
      ...ref,
      channel: `C${index}`,
    })));

    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 200 && processor.mock.calls.length < 5; attempt += 1) {
      await readdir(ingressDir);
    }

    try {
      expect(processor.mock.calls.map(([input]) => input.channel)).toContain('C4');
      expect(processor.mock.calls.filter(([input]) => input.channel === 'C0')).toHaveLength(1);
      expect(Date.now()).toBe(new Date('2026-08-19T12:00:00.000Z').getTime());
      expect(await records()).toContain('C0-1700000000.000100.json');
    } finally {
      await rm(failedTemporaryPath, { recursive: true, force: true });
      release();
    }
    await waitForSlackIngressIdle();
  });

  it('does not spin or exceed the cap when every processor is still active', async () => {
    let release!: () => void;
    const stalled = new Promise<{ status: 'complete' }>((resolve) => {
      release = () => resolve({ status: 'complete' });
    });
    const process = vi.fn().mockReturnValue(stalled);
    await startSlackIngress(process);
    await Promise.all(Array.from({ length: 5 }, (_, index) => enqueueSlackIngress({
      ...ref,
      channel: `C${index}`,
    })));

    await vi.runOnlyPendingTimersAsync();
    for (let attempt = 0; attempt < 200 && process.mock.calls.length < 4; attempt += 1) {
      await readdir(ingressDir);
    }
    expect(process).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);

    release();
    await waitForSlackIngressIdle();
    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();
    expect(process).toHaveBeenCalledTimes(5);
    expect(await records()).toEqual([]);
  });

  it('continues past an unreadable record and retries its scan sparsely', async () => {
    await mkdir(join(ingressDir, 'broken.json'), { recursive: true });
    const process = vi.fn().mockResolvedValue({ status: 'complete' });
    await startSlackIngress(process);
    await enqueueSlackIngress(ref);

    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();

    expect(process).toHaveBeenCalledOnce();
    expect(await records()).toEqual(['broken.json']);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not let a later thread message overtake a retrying predecessor', async () => {
    const later = { ...ref, type: 'message' as const, ts: '1700000001.000100', threadTs: ref.ts };
    const process = vi.fn()
      .mockRejectedValueOnce(new Error('transient identity lookup'))
      .mockResolvedValue({ status: 'complete' });
    await startSlackIngress(process);
    await Promise.all([enqueueSlackIngress(ref), enqueueSlackIngress(later)]);

    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();

    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0][0]).toEqual(ref);

    await vi.advanceTimersByTimeAsync(60_000);
    await waitForSlackIngressIdle();
    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();

    expect(process.mock.calls.map(([event]) => event)).toEqual([ref, ref, later]);
    expect(await records()).toEqual([]);
  });

  it('processes a concurrently duplicated event once', async () => {
    const process = vi.fn().mockResolvedValue({ status: 'complete' });
    await startSlackIngress(process);

    await Promise.all([enqueueSlackIngress(ref), enqueueSlackIngress(ref)]);
    await vi.runOnlyPendingTimersAsync();
    await waitForSlackIngressIdle();

    expect(process).toHaveBeenCalledOnce();
  });
});
