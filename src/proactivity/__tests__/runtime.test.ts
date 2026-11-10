// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { InitiativeStore } from '../store.js';
import { hasObservationAPI, searchObservations } from '../api.js';
import { ModelGateway } from '../model.js';
import { InitiativeService } from '../service.js';
import type { InitiativeRuntime } from '../index.js';

const f = vi.hoisted(() => ({
  root: `/tmp/archie-runtime-${process.pid}`,
  post: vi.fn<typeof import('../../connectors/slack/client.js').postSlackMessage>(),
  slack: {
    inspect: vi.fn(),
    channels: vi.fn(),
    page: vi.fn(),
    dm: vi.fn(),
    recipient: vi.fn(),
    verifyDm: vi.fn(),
    send: vi.fn(),
    find: vi.fn(),
    active: vi.fn(),
    link: vi.fn(),
    updateProposal: vi.fn(),
  },
}));
vi.mock('../../system/workdir.js', () => ({ WORKDIR: f.root }));
vi.mock('../../system/plugin-loader.js', () => ({
  getArchieConfig: () => ({ repos: { 'owner/repo': {} } }),
}));
vi.mock('../../connectors/slack/client.js', () => ({ postSlackMessage: f.post }));
vi.mock('../slack.js', () => ({
  PublicSlack: vi.fn(function () {
    return f.slack;
  }),
  normalizeSlackSource: async (raw: Record<string, unknown>, channel: string) => ({
    channel,
    thread: raw.thread_ts ?? raw.ts,
    ts: raw.ts,
    version: raw.ts,
    author: raw.user,
    text: raw.text,
  }),
}));
import { startInitiative } from '../runtime.js';
import { ordinaryTasks } from '../task-adapter.js';
import { proposalVersion } from '../proposals.js';
import { expectDefined } from '../../test-support/assertions.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const OWNER = 'U000001';
let runtime: InitiativeRuntime | undefined;
const openStore = () => new InitiativeStore(join(f.root, 'initiative/state.sqlite'), 'T1', NOW);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  rmSync(f.root, { recursive: true, force: true });
  f.slack.inspect.mockResolvedValue({ shared: false, recipientCanRead: true });
  f.slack.channels.mockResolvedValue(['C1']);
  f.slack.page.mockResolvedValue({ messages: [] });
  f.slack.dm.mockResolvedValue('D_OWNER');
  f.slack.verifyDm.mockImplementation(
    async (channel, user) => channel === 'D_OWNER' && user === OWNER,
  );
  f.slack.recipient.mockImplementation(async (channel) => (channel === 'D_OWNER' ? OWNER : null));
  f.slack.updateProposal.mockResolvedValue(undefined);
  f.slack.link.mockImplementation((channel, ts) => `https://slack.test/${channel}/${ts}`);
  vi.spyOn(ModelGateway.prototype, 'verify').mockResolvedValue();
  vi.spyOn(InitiativeService.prototype, 'tick').mockResolvedValue();
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(f.root, { recursive: true, force: true });
});

describe('initiative runtime integration', () => {
  it('authorizes employee feedback per matter without global controls', async () => {
    const employee = 'U000002';
    f.slack.dm.mockImplementation(async (user) => (user === OWNER ? 'D_OWNER' : 'D_EMPLOYEE'));
    f.slack.verifyDm.mockImplementation(
      async (channel, user) => channel === (user === OWNER ? 'D_OWNER' : 'D_EMPLOYEE'),
    );
    runtime = await startInitiative('T1', 'live');
    const store = openStore();
    try {
      const ts = `${NOW / 1000}.000001`;
      store.channel('C1', true, false);
      const evidence = expectDefined(
        store.record(
          {
            channel: 'C1',
            thread: ts,
            ts,
            version: ts,
            author: employee,
            text: 'Separate commitments in the same discussion.',
          },
          NOW,
        ),
      );
      const base = {
        channel: 'C1',
        thread: ts,
        title: 'Read-only test',
        detail: 'Read-only test',
        evidence: [evidence],
        state: 'open' as const,
        deadline: null,
        explicit: true,
        nextCheck: NOW,
        valid: true,
      };
      store.apply(
        [expectDefined(store.snapshot('C1', ts))],
        [],
        [
          { ...base, id: 'employee', owner: employee },
          { ...base, id: 'admin', owner: OWNER },
        ],
      );
      store.enqueueDelivery({
        id: 'employee-card',
        recipient: employee,
        channel: 'D_EMPLOYEE',
        thread: null,
        text: 'Employee matter',
        matters: ['employee'],
        evidence: [evidence],
        digest: false,
        state: 'sent',
        ts: null,
        created: NOW,
      });
      store.enqueueDelivery({
        id: 'public',
        recipient: null,
        channel: 'C1',
        thread: ts,
        text: 'Public matter',
        matters: ['employee'],
        evidence: [evidence],
        digest: false,
        state: 'sent',
        ts: null,
        created: NOW,
      });
      await runtime.action(employee, 'public:handled');
      expect(store.matter('employee')?.state).toBe('open');
      await runtime.action(OWNER, 'employee-card:handled');
      expect(store.matter('employee')?.state).toBe('open');
      f.slack.inspect.mockResolvedValueOnce({ shared: false, recipientCanRead: false });
      await runtime.action(employee, 'employee-card:handled');
      expect(store.matter('employee')?.state).toBe('open');
      await runtime.action(employee, 'employee-card:stop following');
      expect(store.matter('employee')?.state).toBe('dismissed');
      expect(store.matter('admin')?.state).toBe('open');
      const proposal = store.proposeCapability({
        repository: 'owner/repo',
        outcome: 'Other employee task',
        evidence: [evidence],
        matter: 'admin',
      });
      expect(store.proposalCurrent(expectDefined(store.proposal(proposal)), NOW)).toBe(true);
      await runtime.capture({
        channel: 'D_EMPLOYEE',
        user: employee,
        text: 'initiative handled admin',
      });
      expect(store.matter('admin')?.state).toBe('open');
    } finally {
      store.close();
    }
  });

  it('starts in shadow mode without opening a private conversation', async () => {
    runtime = await startInitiative('T1', 'shadow');
    expect(ModelGateway.prototype.verify).toHaveBeenCalled();
    expect(f.slack.dm).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
    const store = openStore();
    try {
      expect(store.setting('activated')).toBe('true');
    } finally {
      store.close();
    }
  });

  it.each([
    { mode: 'shadow', recovery: undefined },
    { mode: 'live', recovery: undefined },
    { mode: 'shadow', recovery: 'approved' },
    { mode: 'shadow', recovery: 'prepared' },
  ] as const)(
    'continues private-card approvals and card updates in $mode, recovery=$recovery',
    async ({ mode, recovery }) => {
      runtime = await startInitiative('T1', mode);
      const store = openStore();
      try {
        const ts = `${NOW / 1000}.000001`;
        store.channel('C1', true, false);
        const evidence = expectDefined(
          store.record(
            { channel: 'C1', thread: ts, ts, version: ts, author: OWNER, text: 'Read-only test' },
            NOW,
          ),
        );
        f.slack.page.mockImplementation(async () => ({
          messages: store.snapshot('C1', ts)?.evidence ?? [],
        }));
        store.apply(
          [expectDefined(store.snapshot('C1', ts))],
          [],
          [
            {
              id: 'test',
              channel: 'C1',
              thread: ts,
              title: 'Read-only test',
              detail: 'Read-only test',
              evidence: [evidence],
              state: 'open',
              owner: OWNER,
              deadline: null,
              explicit: true,
              nextCheck: NOW,
              valid: true,
            },
          ],
        );
        const proposal = store.proposeCapability({
          repository: 'owner/repo',
          outcome: 'Read-only test',
          evidence: [evidence],
          matter: 'test',
        });
        const version = proposalVersion(expectDefined(store.proposal(proposal)));
        store.enqueueDelivery({
          id: 'card',
          recipient: OWNER,
          channel: 'D_OWNER',
          thread: null,
          text: 'Proposal and budget context',
          matters: [],
          evidence: [evidence],
          digest: false,
          state: 'sent',
          ts: '1792490401.000001',
          created: NOW,
          proposal: { id: proposal, version },
        });
        store.attention.finishDelivery('sent', '1792490401.000001', 'card');
        let metadata: Awaited<ReturnType<typeof ordinaryTasks.read>>;
        vi.spyOn(ordinaryTasks, 'prepare').mockImplementation(async (input) => {
          metadata = {
            task_id: input.taskId,
            channels: {},
            default_channel: null,
            agent_sessions: {},
            repositories: [],
            status: 'preparing',
            created_at: new Date(NOW).toISOString(),
            updated_at: new Date(NOW).toISOString(),
            approved_start: { ...input, budget: 'task', phase: 'prepared' },
          };
        });
        const start = vi.spyOn(ordinaryTasks, 'start').mockImplementation(async () => {
          expectDefined(expectDefined(metadata).approved_start).phase = 'ready';
        });
        vi.spyOn(ordinaryTasks, 'read').mockImplementation(async () => metadata ?? null);
        if (recovery) {
          store.approveHandoff({
            proposal,
            version,
            actor: OWNER,
            approved: NOW,
            task: 'saved-task',
            state: recovery,
            budget: 'task',
            delivery: 'card',
          });
          runtime.start();
          await vi.advanceTimersByTimeAsync(60_000);
          expect(store.handoff(proposal)?.task).toBe('saved-task');
        } else {
          await Promise.all([
            runtime.action(OWNER, `card:start:${version}`),
            runtime.action(OWNER, `card:start:${version}`),
          ]);
          await runtime.action(OWNER, `card:start:${version}`);
        }
        await runtime.close();
        runtime = undefined;
        expect(start).toHaveBeenCalledTimes(1);
        expect(f.post).not.toHaveBeenCalled();
        expect(f.slack.updateProposal.mock.calls.at(-1)?.[1]).toContain('Task started');
      } finally {
        store.close();
      }
    },
  );

  it('installs observation tools independently of knowledge flags and starts jobs only after recovery', async () => {
    vi.stubEnv('ARCHIE_MEMORY', 'false');
    runtime = await startInitiative('T1', 'shadow');
    expect(hasObservationAPI()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(InitiativeService.prototype.tick).not.toHaveBeenCalled();
    runtime.start();
    runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(InitiativeService.prototype.tick).toHaveBeenCalledTimes(1);
  });

  it('rejects forged employee controls and consumes a verified employee command', async () => {
    runtime = await startInitiative('T1', 'shadow');
    expect(
      await runtime.capture({ channel: 'D_OWNER', user: 'U000002', text: 'initiative stop' }),
    ).toBe(false);
    expect(
      await runtime.capture({ channel: 'D_OTHER', user: OWNER, text: 'initiative stop' }),
    ).toBe(false);
    await runtime.action('U000002', 'delivery:handled');
    expect(f.post).not.toHaveBeenCalled();
    expect(
      await runtime.capture({ channel: 'D_OWNER', user: OWNER, text: 'initiative stop' }),
    ).toBe(true);
    const store = openStore();
    try {
      expect(store.setting('stop')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('does not accept a bot-authored message as an employee control', async () => {
    runtime = await startInitiative('T1', 'shadow');
    expect(
      await runtime.capture({
        channel: 'D_OWNER',
        user: OWNER,
        bot_id: 'B1',
        text: 'initiative stop',
      }),
    ).toBe(false);
    const store = openStore();
    try {
      expect(store.setting('stop')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('drains authenticated employee operations before closing their database', async () => {
    runtime = await startInitiative('T1', 'shadow');
    let open!: (channel: string) => void;
    f.slack.dm.mockReturnValueOnce(
      new Promise((resolve) => {
        open = resolve;
      }),
    );
    const control = runtime.capture({ channel: 'D_OWNER', user: OWNER, text: 'initiative help' });
    await Promise.resolve();
    await Promise.resolve();
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    open('D_OWNER');
    await control;
    await closing;
    runtime = undefined;
    expect(f.post.mock.calls[0][0].text).toContain('your own matters');
  });

  it('drains previously admitted intake during shutdown and rejects new intake', async () => {
    runtime = await startInitiative('T1', 'shadow');
    let allow!: (value: unknown) => void;
    f.slack.inspect.mockReturnValueOnce(
      new Promise((resolve) => {
        allow = resolve;
      }),
    );
    const event = {
      channel: 'C1',
      user: OWNER,
      text: 'Release Friday',
      ts: (NOW / 1000 + 1).toFixed(6),
    };
    expect(await runtime.capture(event)).toBe(false);
    const closing = runtime.close();
    expect(await runtime.capture({ ...event, text: 'After close' })).toBe(false);
    allow({ shared: false, recipientCanRead: true });
    await closing;
    runtime = undefined;
    expect(hasObservationAPI()).toBe(false);
    const store = openStore();
    try {
      expect(store['row']('SELECT text FROM revisions')?.text).toBe('Release Friday');
      expect(store['rows']('SELECT id FROM revisions')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('drains observation reads waiting for live authorization before closing SQLite', async () => {
    runtime = await startInitiative('T1', 'shadow');
    let verify!: (value: boolean) => void;
    f.slack.recipient.mockReturnValueOnce(
      new Promise((resolve) => {
        verify = (value) => resolve(value ? OWNER : null);
      }),
    );
    const read = searchObservations(
      { memory_destination: { channel_id: 'D_OWNER' } } as never,
      'release',
      10,
    );
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(await searchObservations({} as never, 'release', 10)).toEqual([]);
    verify(true);
    expect(await read).toEqual([]);
    await closing;
    runtime = undefined;
  });

  it('waits for the active service tick on close rather than a later no-op tick', async () => {
    runtime = await startInitiative('T1', 'shadow');
    let finish!: () => void;
    vi.mocked(InitiativeService.prototype.tick).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    runtime.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(InitiativeService.prototype.tick).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await closing;
    runtime = undefined;
    expect(closed).toBe(true);
  });

  it('preserves the watermark across restart and reports unknown old-thread coverage', async () => {
    runtime = await startInitiative('T1', 'shadow');
    await runtime.close();
    runtime = undefined;
    vi.setSystemTime(NOW + 86_400_000);
    runtime = await startInitiative('T1', 'shadow');
    const store = openStore();
    try {
      expect(store.setting('watermark')).toBe(String(NOW / 1000));
      expect(store.setting('intake_gap')).toContain('previously unknown');
    } finally {
      store.close();
    }
  });

  it('provides employee-command help for an unknown initiative command', async () => {
    runtime = await startInitiative('T1', 'shadow');
    expect(
      await runtime.capture({ channel: 'D_OWNER', user: OWNER, text: 'initiative unknown' }),
    ).toBe(true);
    expect(f.post).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D_OWNER',
        text: expect.stringContaining('ARCHIE_PROACTIVITY_MODE') as unknown,
      }),
    );
  });

  it('recognizes a proactive origin during lookup failures without exposing its cached context', async () => {
    runtime = await startInitiative('T1', 'shadow');
    const store = openStore();
    try {
      store['run'](
        "INSERT INTO deliveries(id,channel,thread,text,matters,evidence,digest,state,ts,created,slot_day,proposal) VALUES ('delivery','C1','10.000001','Cached source text','[\"secret-matter\"]','[]',0,'sent','11.000001',?,NULL,NULL)",
        NOW,
      );
    } finally {
      store.close();
    }
    f.slack.inspect.mockRejectedValueOnce(new Error('Slack unavailable'));
    const origin = await runtime.origin('C1', '10.000001');
    expect(origin?.deliveryId).toBe('delivery');
    expect(origin?.matterIds).toEqual([]);
    expect(origin?.brief).not.toContain('Cached source text');
  });
});
