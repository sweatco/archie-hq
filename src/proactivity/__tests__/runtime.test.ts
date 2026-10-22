// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { InitiativeStore } from '../store.js';
import { hasObservationAPI, searchObservations } from '../api.js';
import { ModelGateway } from '../model.js';
import type { InitiativeRuntime } from '../index.js';

const f = vi.hoisted(() => ({ root: `/tmp/archie-runtime-${process.pid}`, post: vi.fn(), slack: {
  inspect: vi.fn(), channels: vi.fn(), page: vi.fn(), ownerDm: vi.fn(), verifyDm: vi.fn(), send: vi.fn(), find: vi.fn(), active: vi.fn(), link: vi.fn(), updateProposal: vi.fn(),
} }));
vi.mock('../../system/workdir.js', () => ({ WORKDIR: f.root }));
vi.mock('../../system/plugin-loader.js', () => ({ getArchieConfig: () => ({ repos: { 'owner/repo': {} } }) }));
vi.mock('../../connectors/slack/client.js', () => ({ postSlackMessage: f.post }));
vi.mock('../slack.js', () => ({
  PublicSlack: vi.fn(function () { return f.slack; }),
  normalizeSlackSource: async (raw: Record<string, unknown>, channel: string) => ({ channel, thread: raw.thread_ts ?? raw.ts, ts: raw.ts, version: raw.ts, author: raw.user, text: raw.text }),
}));
import { startInitiative } from '../runtime.js';
import { ordinaryTasks } from '../task-adapter.js';
import { proposalVersion } from '../proposals.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const OWNER = 'U000001';
let runtime: InitiativeRuntime | undefined;
const openStore = () => new InitiativeStore(join(f.root, 'initiative/state.sqlite'), 'T1', NOW);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks();
  rmSync(f.root, { recursive: true, force: true });
  vi.stubEnv('ARCHIE_PROACTIVITY_OWNER', OWNER);
  f.slack.inspect.mockResolvedValue({ shared: false, ownerCanRead: true });
  f.slack.channels.mockResolvedValue(['C1']); f.slack.page.mockResolvedValue({ messages: [] });
  f.slack.ownerDm.mockResolvedValue('D_OWNER'); f.slack.verifyDm.mockImplementation(async (channel) => channel === 'D_OWNER');
  f.slack.updateProposal.mockResolvedValue(undefined); f.slack.link.mockImplementation((channel, ts) => `https://slack.test/${channel}/${ts}`);
  vi.spyOn(ModelGateway.prototype, 'verify').mockResolvedValue();
  vi.spyOn(ModelGateway.prototype, 'poll').mockResolvedValue();
  vi.spyOn(ModelGateway.prototype, 'cancel').mockResolvedValue();
});
afterEach(async () => {
  await runtime?.close(); runtime = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(f.root, { recursive: true, force: true });
});

describe('initiative runtime integration', () => {
  it('updates the original card instead of posting a confirmation for every valid callback', async () => {
    runtime = await startInitiative('T1', 'live');
    const store = openStore();
    try {
      const ts = `${NOW / 1000}.000001`;
      store.channel('C1', true, false);
      const evidence = store.record({ channel: 'C1', thread: ts, ts, version: ts, author: OWNER, text: 'Read-only test' }, NOW)!;
      f.slack.page.mockImplementation(async () => ({ messages: store.snapshot('C1', ts)?.evidence ?? [] }));
      store.proposeCapability('test', { repository: 'owner/repo', outcome: 'Read-only test', evidence: [evidence] });
      const version = proposalVersion(store.proposal('test')!);
      store.enqueueDelivery({ id: 'card', channel: 'D_OWNER', thread: null, text: 'Proposal and budget context', matters: [], evidence: [evidence], policy: 'base', digest: false, state: 'sent', ts: '1792490401.000001', created: NOW, proposal: { id: 'test', version } });
      store.attention.finishDelivery('sent', '1792490401.000001', 'card');
      let metadata: any;
      vi.spyOn(ordinaryTasks, 'prepare').mockImplementation(async input => { metadata = { approved_start: { ...input, phase: 'prepared' } }; });
      const start = vi.spyOn(ordinaryTasks, 'start').mockImplementation(async () => { metadata.approved_start.phase = 'ready'; });
      vi.spyOn(ordinaryTasks, 'read').mockImplementation(async () => metadata ?? null);
      await Promise.all([runtime.action(OWNER, `card:start:${version}`), runtime.action(OWNER, `card:start:${version}`)]);
      await runtime.action(OWNER, `card:start:${version}`);
      await runtime.close(); runtime = undefined;
      expect(start).toHaveBeenCalledTimes(1);
      expect(f.post).not.toHaveBeenCalled();
      expect(f.slack.updateProposal.mock.calls.at(-1)?.[1]).toContain('Task started');
    } finally { store.close(); }
  });

  it('installs observation tools independently of knowledge flags and starts jobs only after recovery', async () => {
    vi.stubEnv('ARCHIE_MEMORY', 'false');
    runtime = await startInitiative('T1', 'shadow');
    expect(hasObservationAPI()).toBe(true);
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

  it('does not accept a bot-authored message as an owner control', async () => {
    runtime = await startInitiative('T1', 'shadow');
    expect(await runtime.capture({ channel: 'D_OWNER', user: OWNER, bot_id: 'B1', text: 'initiative stop' })).toBe(false);
    const store = openStore();
    try { expect(store.setting('stop')).toBeUndefined(); } finally { store.close(); }
  });

  it('drains authenticated owner operations before closing their database', async () => {
    runtime = await startInitiative('T1', 'shadow');
    let open!: (channel: string) => void;
    f.slack.ownerDm.mockReturnValueOnce(new Promise(resolve => { open = resolve; }));
    const control = runtime.capture({ channel: 'D_OWNER', user: OWNER, text: 'initiative status' });
    await Promise.resolve(); await Promise.resolve();
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    open('D_OWNER');
    await control; await closing; runtime = undefined;
    expect(f.post.mock.calls[0][0].text).toContain('Initiative: shadow');
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
    expect(hasObservationAPI()).toBe(false);
    const store = openStore();
    try { expect(store['row']('SELECT text FROM revisions')?.text).toBe('Release Friday'); expect(store['rows']('SELECT id FROM revisions')).toHaveLength(1); }
    finally { store.close(); }
  });

  it('drains observation reads waiting for live authorization before closing SQLite', async () => {
    runtime = await startInitiative('T1', 'shadow');
    let verify!: (value: boolean) => void;
    f.slack.verifyDm.mockReturnValueOnce(new Promise(resolve => { verify = resolve; }));
    const read = searchObservations({ memory_destination: { channel_id: 'D_OWNER' } } as never, 'release', 10);
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(await searchObservations({} as never, 'release', 10)).toEqual([]);
    verify(true);
    expect(await read).toEqual([]);
    await closing; runtime = undefined;
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

  it('consumes deferred learning commands without falling through to PM task creation', async () => {
    runtime = await startInitiative('T1', 'shadow');
    expect(await runtime.capture({ channel: 'D_OWNER', user: OWNER, text: 'initiative approve missing missing' })).toBe(true);
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D_OWNER', text: expect.stringContaining('delivery on/off') }));
  });

  it('requires an authenticated owner DM to enable delivery and leaves shadow analysis separate', async () => {
    runtime = await startInitiative('T1', 'shadow');
    await runtime.capture({ channel: 'D_OWNER', user: 'U000002', text: 'initiative delivery on' });
    await runtime.capture({ channel: 'D_OTHER', user: OWNER, text: 'initiative delivery on' });
    const store = openStore();
    try {
      expect(store.setting('delivery_enabled')).toBe('false');
      expect(await runtime.capture({ channel: 'D_OWNER', user: OWNER, text: 'initiative delivery on' })).toBe(true);
      expect(store.setting('delivery_enabled')).toBe('true');
      await runtime.capture({ channel: 'D_OWNER', user: OWNER, text: 'initiative delivery off' });
      expect(store.setting('delivery_enabled')).toBe('false');
    } finally { store.close(); }
  });

  it('recognizes a proactive origin during lookup failures without exposing its cached context', async () => {
    runtime = await startInitiative('T1', 'shadow');
    const store = openStore();
    try { store['run']("INSERT INTO deliveries VALUES ('delivery','C1','10.000001','Cached source text','[\"secret-matter\"]','[]','base',0,'sent','11.000001',?,NULL,NULL)", NOW); }
    finally { store.close(); }
    f.slack.inspect.mockRejectedValueOnce(new Error('Slack unavailable'));
    const origin = await runtime.origin('C1', '10.000001');
    expect(origin?.deliveryId).toBe('delivery');
    expect(origin?.matterIds).toEqual([]);
    expect(origin?.brief).not.toContain('Cached source text');
  });
});
