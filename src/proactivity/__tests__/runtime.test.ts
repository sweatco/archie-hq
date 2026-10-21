// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ObservationStore } from '../../memory/observation-store.js';
import { hasObservationMemory } from '../../memory/observations.js';
import { ModelGateway } from '../model.js';
import type { InitiativeRuntime } from '../index.js';

const f = vi.hoisted(() => ({ root: `/tmp/archie-runtime-${process.pid}`, post: vi.fn(), slack: {
  inspect: vi.fn(), channels: vi.fn(), page: vi.fn(), ownerDm: vi.fn(), verifyDm: vi.fn(), send: vi.fn(), find: vi.fn(), active: vi.fn(), link: vi.fn(),
} }));
vi.mock('../../system/workdir.js', () => ({ WORKDIR: f.root }));
vi.mock('../../system/plugin-loader.js', () => ({ getArchieConfig: () => ({ repos: { 'owner/repo': {} } }) }));
vi.mock('../../connectors/slack/client.js', () => ({ postSlackMessage: f.post }));
vi.mock('../slack.js', () => ({
  PublicSlack: vi.fn(function () { return f.slack; }),
  normalizeSlackSource: async (raw: Record<string, unknown>, channel: string) => ({ channel, thread: raw.thread_ts ?? raw.ts, ts: raw.ts, version: raw.ts, author: raw.user, text: raw.text }),
}));
import { startInitiative } from '../runtime.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const OWNER = 'U000001';
let runtime: InitiativeRuntime | undefined;
const openStore = () => new ObservationStore(join(f.root, 'initiative/state.sqlite'), 'T1', NOW);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks();
  rmSync(f.root, { recursive: true, force: true });
  vi.stubEnv('ARCHIE_PROACTIVITY_OWNER', OWNER);
  f.slack.inspect.mockResolvedValue({ shared: false, ownerCanRead: true });
  f.slack.channels.mockResolvedValue(['C1']); f.slack.page.mockResolvedValue({ messages: [] });
  f.slack.ownerDm.mockResolvedValue('D_OWNER'); f.slack.verifyDm.mockImplementation(async (channel) => channel === 'D_OWNER');
  vi.spyOn(ModelGateway.prototype, 'verify').mockResolvedValue();
  vi.spyOn(ModelGateway.prototype, 'poll').mockResolvedValue();
  vi.spyOn(ModelGateway.prototype, 'cancel').mockResolvedValue();
});
afterEach(async () => {
  await runtime?.close(); runtime = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(f.root, { recursive: true, force: true });
});

describe('initiative runtime integration', () => {
  it('installs memory independently of knowledge flags and starts jobs only after recovery', async () => {
    vi.stubEnv('ARCHIE_MEMORY', 'false');
    runtime = await startInitiative('T1', 'shadow');
    expect(hasObservationMemory()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ModelGateway.prototype.poll).not.toHaveBeenCalled();
    runtime.start(); runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ModelGateway.prototype.poll).toHaveBeenCalledTimes(1);
  });

  it('rejects forged owner controls and consumes a verified owner command', async () => {
    runtime = await startInitiative('T1', 'shadow');
    expect(await runtime.capture({ channel: 'D_OWNER', user: 'U000002', text: 'initiative stop' })).toBe(false);
    expect(await runtime.capture({ channel: 'D_OTHER', user: OWNER, text: 'initiative stop' })).toBe(false);
    await runtime.action('U000002', 'delivery:handled');
    expect(f.post).not.toHaveBeenCalled();
    expect(await runtime.capture({ channel: 'D_OWNER', user: OWNER, text: 'initiative stop' })).toBe(true);
    const store = openStore();
    try { expect(store.setting('stop')).toBe('true'); expect(store.setting('analysis_epoch')).toBe('1'); }
    finally { store.close(); }
    expect(ModelGateway.prototype.cancel).toHaveBeenCalledTimes(1);
  });

  it('drains previously admitted intake during shutdown and rejects new intake', async () => {
    runtime = await startInitiative('T1', 'shadow');
    let allow!: (value: unknown) => void;
    f.slack.inspect.mockReturnValueOnce(new Promise((resolve) => { allow = resolve; }));
    const event = { channel: 'C1', user: OWNER, text: 'Release Friday', ts: (NOW / 1000 + 1).toFixed(6) };
    expect(await runtime.capture(event)).toBe(false);
    const closing = runtime.close();
    expect(await runtime.capture({ ...event, text: 'After close' })).toBe(false);
    allow({ shared: false, ownerCanRead: true });
    await closing; runtime = undefined;
    expect(hasObservationMemory()).toBe(false);
    const store = openStore();
    try { expect(store.row('SELECT text FROM revisions')?.text).toBe('Release Friday'); expect(store.rows('SELECT id FROM revisions')).toHaveLength(1); }
    finally { store.close(); }
  });

  it('waits for the real active reconciliation on close rather than a later no-op tick', async () => {
    runtime = await startInitiative('T1', 'shadow');
    let finish!: () => void;
    vi.mocked(ModelGateway.prototype.poll).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    runtime.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ModelGateway.prototype.poll).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    finish(); await closing; runtime = undefined;
    expect(closed).toBe(true);
  });

  it('preserves the watermark across restart and reports unknown old-thread coverage', async () => {
    runtime = await startInitiative('T1', 'shadow');
    await runtime.close(); runtime = undefined;
    vi.setSystemTime(NOW + 86_400_000);
    runtime = await startInitiative('T1', 'shadow');
    const store = openStore();
    try { expect(store.setting('watermark')).toBe(String(NOW / 1000)); expect(store.setting('intake_gap')).toContain('previously unknown'); }
    finally { store.close(); }
  });

  it('consumes rejected review commands without falling through to PM task creation', async () => {
    runtime = await startInitiative('T1', 'shadow');
    expect(await runtime.capture({ channel: 'D_OWNER', user: OWNER, text: 'initiative approve missing missing' })).toBe(true);
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D_OWNER', text: expect.stringContaining('could not be applied') }));
  });

  it('recognizes a proactive origin during lookup failures without exposing its cached context', async () => {
    runtime = await startInitiative('T1', 'shadow');
    const store = openStore();
    try { store.run("INSERT INTO deliveries VALUES ('delivery','C1','10.000001','Cached source text','[\"secret-matter\"]','[]','base',0,'sent','11.000001',?,NULL)", NOW); }
    finally { store.close(); }
    f.slack.inspect.mockRejectedValueOnce(new Error('Slack unavailable'));
    const origin = await runtime.origin('C1', '10.000001');
    expect(origin?.deliveryId).toBe('delivery');
    expect(origin?.matterIds).toEqual([]);
    expect(origin?.brief).not.toContain('Cached source text');
  });
});
