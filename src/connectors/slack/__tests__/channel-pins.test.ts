/**
 * Channel pins — two-principal trust gate and summary reuse.
 *
 * Regression tests: an external author OR an external pinner drops the item, an
 * unclassifiable principal never adopts a new pin (while an already-vetted one
 * survives), a failed `pins.list` never reads as "everything was unpinned", and the
 * digest keeps a steady-state scan free of model calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type PinnedItemLike = {
  kind: 'message' | 'file';
  pinnedAt: number;
  pinnedBy: string;
  messageTs?: string;
  author?: string;
  text?: string;
  permalink?: string;
  fileId?: string;
  fileName?: string;
  fileUser?: string;
  fileCreated?: number;
};

let pins: PinnedItemLike[] | null = [];
let userInfoImpl: (id: string) => Promise<{ external?: boolean; realName?: string }>;
let storesByChannel: Record<string, unknown> = {};
let savedStore: { pins: unknown[]; pinsCheckedAt: number; pinsTotal: number } | null = null;

vi.mock('../client.js', () => ({
  listChannelPins: vi.fn(async () => pins),
  getUserInfo: async (id: string) => {
    const u = await userInfoImpl(id);
    return { name: id, realName: u.realName ?? id, teamId: u.external ? 'T_OTHER' : 'T_HOME' };
  },
  isExternalUser: (u: { teamId?: string }) => u?.teamId === 'T_OTHER',
  // Not imported by channel-pins.ts — mocked purely so "never posts" is assertable
  // rather than assumed.
  postSlackMessage: vi.fn(async () => {}),
}));

vi.mock('../pin-summary.js', async () => {
  // The digest comparison has to exercise the real hash, so only the model call is
  // faked; normalisePinText / digestOf / truncateTo stay real.
  const actual = await vi.importActual<typeof import('../pin-summary.js')>('../pin-summary.js');
  return {
    normalisePinText: actual.normalisePinText,
    digestOf: actual.digestOf,
    truncateTo: actual.truncateTo,
    VERBATIM_MAX: actual.VERBATIM_MAX,
    summarisePinText: vi.fn(async (raw: string) => ({
      summary: `summary:${actual.normalisePinText(raw)}`,
      source: 'model' as const,
    })),
  };
});

vi.mock('../../../system/channel-store.js', () => ({
  loadChannelStore: async (channelId: string) => storesByChannel[channelId] ?? null,
  updateChannelStore: async (channelId: string, updater: (s: never) => never) => {
    const base = (storesByChannel[channelId] as object | undefined) ?? {
      canvases: [],
      announced: {},
      checkedAt: 0,
      pins: [],
      pinsCheckedAt: 0,
      pinsTotal: 0,
    };
    savedStore = updater(JSON.parse(JSON.stringify(base)) as never);
    // Write back, so a second ensureChannelPins in the same test sees the TTL the
    // first one stamped.
    storesByChannel[channelId] = savedStore;
    return savedStore;
  },
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { ensureChannelPins } from '../channel-pins.js';
import { listChannelPins, postSlackMessage } from '../client.js';
import { summarisePinText, digestOf, normalisePinText } from '../pin-summary.js';
import { logger } from '../../../system/logger.js';

const CHANNEL = 'C0123456789';

const messagePin = (over: Partial<PinnedItemLike> = {}): PinnedItemLike => ({
  kind: 'message',
  pinnedAt: 1_700_000_000,
  pinnedBy: 'U_PINNER',
  messageTs: '1699990000.000100',
  author: 'U_AUTHOR',
  text: 'deploy runbook lives here',
  permalink: 'https://slack.example/archives/C1/p1699990000000100',
  ...over,
});

const filePin = (over: Partial<PinnedItemLike> = {}): PinnedItemLike => ({
  kind: 'file',
  pinnedAt: 1_690_000_000,
  pinnedBy: 'U_PINNER',
  fileId: 'F_PINNED',
  fileName: 'architecture.pdf',
  fileUser: 'U_AUTHOR',
  fileCreated: 1_689_000_000,
  ...over,
});

const storedEntry = (over: Record<string, unknown> = {}) => ({
  kind: 'message',
  key: '1699990000.000100',
  pinnedAt: 1_700_000_000,
  pinnedBy: 'U_PINNER',
  authorName: 'Ada',
  postedAt: 1_699_990_000,
  summary: 'stored one-liner',
  summarySource: 'verbatim',
  digest: digestOf(normalisePinText('deploy runbook lives here')),
  permalink: 'https://slack.example/archives/C1/p1699990000000100',
  ...over,
});

const storeWith = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
  canvases: [],
  announced: {},
  checkedAt: 0,
  pins: entries,
  pinsCheckedAt: 0,
  pinsTotal: entries.length,
  ...extra,
});

describe('ensureChannelPins', () => {
  beforeEach(() => {
    pins = [messagePin(), filePin()];
    userInfoImpl = async (id: string) => ({ external: false, realName: `Name ${id}` });
    storesByChannel = {};
    savedStore = null;
    vi.mocked(listChannelPins).mockClear();
    vi.mocked(postSlackMessage).mockClear();
    vi.mocked(summarisePinText).mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  it('stores pins newest-pinned-first with the pre-cap total and a fresh check time', async () => {
    const before = Date.now();

    await ensureChannelPins(CHANNEL);

    expect(savedStore?.pins).toHaveLength(2);
    expect((savedStore?.pins as Array<{ key: string }>).map((p) => p.key)).toEqual([
      '1699990000.000100',
      'F_PINNED',
    ]);
    expect(savedStore?.pinsTotal).toBe(2);
    expect(savedStore?.pinsCheckedAt).toBeGreaterThanOrEqual(before);
  });

  // A shared channel lets an outsider author content that a member then elevates into
  // standing context — and lets an outsider elevate a member's.
  it('drops an item whose AUTHOR is external', async () => {
    pins = [messagePin()];
    userInfoImpl = async (id: string) => ({ external: id === 'U_AUTHOR', realName: id });

    await ensureChannelPins(CHANNEL);

    expect(savedStore?.pins).toEqual([]);
  });

  it('drops an item whose PINNER is external', async () => {
    pins = [messagePin()];
    userInfoImpl = async (id: string) => ({ external: id === 'U_PINNER', realName: id });

    await ensureChannelPins(CHANNEL);

    expect(savedStore?.pins).toEqual([]);
  });

  it('keeps a matching prior entry unchanged when the pinner lookup throws', async () => {
    pins = [messagePin()];
    const prior = storedEntry();
    storesByChannel[CHANNEL] = storeWith([prior]);
    userInfoImpl = async (id: string) => {
      if (id === 'U_PINNER') throw new Error('rate limited');
      return { external: false, realName: id };
    };

    await ensureChannelPins(CHANNEL);

    expect(savedStore?.pins).toHaveLength(1);
    expect(savedStore?.pins[0]).toEqual(prior);
  });

  it('skips and warns when the pinner lookup throws and there is no prior entry', async () => {
    pins = [messagePin()];
    userInfoImpl = async (id: string) => {
      if (id === 'U_PINNER') throw new Error('rate limited');
      return { external: false, realName: id };
    };

    await ensureChannelPins(CHANNEL);

    expect(savedStore?.pins).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('channel-pins', expect.stringContaining('not adopting yet'));
  });

  // listChannelPins returns null on failure, [] for "genuinely nothing pinned".
  // Conflating them would let one API error look like "every pin was removed".
  it('leaves the store completely untouched when the pins lookup fails', async () => {
    storesByChannel[CHANNEL] = storeWith([storedEntry()]);
    pins = null;

    await ensureChannelPins(CHANNEL);

    expect(savedStore).toBeNull(); // no write at all
  });

  it('does not call pins.list again inside the TTL', async () => {
    await ensureChannelPins(CHANNEL);
    expect(listChannelPins).toHaveBeenCalledTimes(1);

    await ensureChannelPins(CHANNEL);
    expect(listChannelPins).toHaveBeenCalledTimes(1);
  });

  it('caps the index at 25 pins while disclosing the true total', async () => {
    pins = Array.from({ length: 30 }, (_, i) =>
      messagePin({ messageTs: `169999${String(i).padStart(4, '0')}.000100`, pinnedAt: 1_700_000_000 + i }),
    );

    await ensureChannelPins(CHANNEL);

    expect(savedStore?.pins).toHaveLength(25);
    expect(savedStore?.pinsTotal).toBe(30);
  });

  // The digest is what keeps a steady-state scan at one pins.list and nothing else.
  it('reuses a prior summary when the digest matches, with no model call', async () => {
    pins = [messagePin()];
    storesByChannel[CHANNEL] = storeWith([storedEntry()]);

    await ensureChannelPins(CHANNEL);

    expect(summarisePinText).not.toHaveBeenCalled();
    expect((savedStore?.pins[0] as { summary: string }).summary).toBe('stored one-liner');
    expect((savedStore?.pins[0] as { summarySource: string }).summarySource).toBe('verbatim');
  });

  it('re-summarises exactly once when the pinned text changed', async () => {
    pins = [messagePin({ text: 'the runbook moved to the wiki' })];
    storesByChannel[CHANNEL] = storeWith([storedEntry()]);

    await ensureChannelPins(CHANNEL);

    expect(summarisePinText).toHaveBeenCalledTimes(1);
    expect((savedStore?.pins[0] as { summary: string }).summary).toBe('summary:the runbook moved to the wiki');
  });

  // A pin index is passive — nothing about it is a state change worth a channel post.
  it('never posts to the channel on any path', async () => {
    await ensureChannelPins(CHANNEL);

    storesByChannel = {};
    pins = null;
    await ensureChannelPins(CHANNEL);

    storesByChannel = {};
    pins = [];
    await ensureChannelPins(CHANNEL);

    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  // Unpinning is handled by wholesale replacement: an item Slack no longer reports is
  // simply absent from the derived list.
  it('forgets a pin that is no longer reported', async () => {
    const kept = storedEntry();
    const removed = storedEntry({ key: 'F_OLD', kind: 'file', fileId: 'F_OLD' });
    storesByChannel[CHANNEL] = storeWith([kept, removed]);
    pins = [messagePin()];

    await ensureChannelPins(CHANNEL);

    expect(savedStore?.pins).toHaveLength(1);
    expect((savedStore?.pins[0] as { key: string }).key).toBe('1699990000.000100');
  });

  it('keeps both pins when the lookup fails instead of reading as an unpin', async () => {
    const entries = [storedEntry(), storedEntry({ key: 'F_OLD', kind: 'file', fileId: 'F_OLD' })];
    storesByChannel[CHANNEL] = storeWith(entries);
    pins = null;

    await ensureChannelPins(CHANNEL);

    expect(savedStore).toBeNull();
    expect((storesByChannel[CHANNEL] as { pins: unknown[] }).pins).toHaveLength(2);
  });
});

