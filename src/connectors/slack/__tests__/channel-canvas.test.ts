/**
 * Channel canvas — creator classification fail-closed + fetch allowlist.
 *
 * Regression tests: an unclassifiable creator (lookup failure or missing id)
 * must never adopt a canvas into PM context, previously classified entries
 * survive transient failures, and fetch_slack_reference's allowlist covers
 * exactly the adopted canvases and their referenced files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskMetadata } from '../../../types/task.js';

let tabs: Array<{ file_id: string }> = [];
let fileInfos: Record<string, { title?: string; user?: string; updated?: number; filetype?: string }> = {};
let userInfoImpl: (id: string) => Promise<{ external?: boolean }>;
let storesByChannel: Record<string, unknown> = {};
let savedStore: { canvases: unknown[]; announced: Record<string, boolean>; checkedAt: number } | null = null;

vi.mock('../client.js', () => ({
  getChannelCanvasTabs: async () => tabs,
  getSlackFileInfo: async (id: string) => fileInfos[id] ?? null,
  getUserInfo: async (id: string) => userInfoImpl(id),
  isExternalUser: (u: { external?: boolean }) => !!u?.external,
  postSlackMessage: vi.fn(async () => {}),
}));

vi.mock('../canvas-read.js', () => ({
  readCanvas: async () => ({ title: 'Archie Context', markdown: '# standing context', fileIds: ['F_REF1'] }),
}));

vi.mock('../../../system/channel-store.js', () => ({
  loadChannelStore: async (channelId: string) => storesByChannel[channelId] ?? null,
  updateChannelStore: async (channelId: string, updater: (s: never) => never) => {
    const base = (storesByChannel[channelId] as object | undefined) ?? { canvases: [], announced: {}, checkedAt: 0 };
    savedStore = updater(JSON.parse(JSON.stringify(base)) as never);
    return savedStore;
  },
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { ensureChannelCanvas, collectCanvasFileAllowlist } from '../channel-canvas.js';
import { postSlackMessage } from '../client.js';
import { logger } from '../../../system/logger.js';

const CHANNEL = 'C0123456789';

const adoptedEntry = (fileId: string, fileIds: string[] = []) => ({
  file_id: fileId,
  title: 'Archie Context',
  creator: 'U_INTERNAL',
  external: false,
  updatedTs: 5,
  markdown: '# standing context',
  fileIds,
});

describe('ensureChannelCanvas — creator classification fails closed', () => {
  beforeEach(() => {
    tabs = [{ file_id: 'F_CANVAS' }];
    fileInfos = { F_CANVAS: { title: 'Archie Context', user: 'U_X', updated: 5 } };
    userInfoImpl = async () => ({ external: false });
    storesByChannel = {};
    savedStore = null;
    vi.mocked(postSlackMessage).mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  it('a new canvas with a failed creator lookup is neither adopted nor announced', async () => {
    userInfoImpl = async () => {
      throw new Error('rate limited');
    };

    await ensureChannelCanvas(CHANNEL);

    expect(savedStore?.canvases).toEqual([]);
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('channel-canvas', expect.stringContaining('not adopting yet'));
  });

  it('a previously adopted canvas survives a transient lookup failure', async () => {
    storesByChannel[CHANNEL] = { canvases: [adoptedEntry('F_CANVAS')], announced: { F_CANVAS: true }, checkedAt: 0 };
    userInfoImpl = async () => {
      throw new Error('rate limited');
    };

    await ensureChannelCanvas(CHANNEL);

    expect(savedStore?.canvases).toHaveLength(1);
    expect((savedStore?.canvases[0] as { file_id: string }).file_id).toBe('F_CANVAS');
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('a canvas without a creator id is not adopted', async () => {
    fileInfos.F_CANVAS = { title: 'Archie Context', updated: 5 };

    await ensureChannelCanvas(CHANNEL);

    expect(savedStore?.canvases).toEqual([]);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('control: an internal creator is adopted and announced once', async () => {
    await ensureChannelCanvas(CHANNEL);

    expect(savedStore?.canvases).toHaveLength(1);
    expect(savedStore?.announced['F_CANVAS']).toBe(true);
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postSlackMessage).mock.calls[0][0]).toMatchObject({ channel: CHANNEL });
  });

  it('control: an external creator is announced as ignored and not stored', async () => {
    userInfoImpl = async () => ({ external: true });

    await ensureChannelCanvas(CHANNEL);

    expect(savedStore?.canvases).toEqual([]);
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    expect((vi.mocked(postSlackMessage).mock.calls[0][0] as { text: string }).text).toContain("I'm not using it");
  });
});

describe('ensureChannelCanvas — per-scan diagnostic logging', () => {
  const scanLines = (): string[] =>
    vi
      .mocked(logger.debug)
      .mock.calls.filter((c) => c[0] === 'channel-canvas' && String(c[1]).includes('evt=canvas_scan'))
      .map((c) => String(c[1]));

  beforeEach(() => {
    tabs = [{ file_id: 'F_CANVAS' }];
    fileInfos = { F_CANVAS: { title: 'Archie Context', user: 'U_X', updated: 5 } };
    userInfoImpl = async () => ({ external: false });
    storesByChannel = {};
    savedStore = null;
    vi.mocked(logger.debug).mockClear();
  });

  it('logs an adopt line carrying the channel id, file id and reason', async () => {
    await ensureChannelCanvas(CHANNEL);

    const line = scanLines().find((l) => l.includes('decision=adopt'));
    expect(line).toBeDefined();
    expect(line).toContain(`channel=${CHANNEL}`);
    expect(line).toContain('file=F_CANVAS');
    expect(line).toContain('reason=read_ok');
    expect(line).toContain('creator_class=internal');
  });

  it('logs a title_mismatch reject with the raw title the gate actually saw', async () => {
    fileInfos.F_CANVAS = { title: 'Weekly Notes', user: 'U_X', updated: 5 };

    await ensureChannelCanvas(CHANNEL);

    const line = scanLines().find((l) => l.includes('decision=reject'));
    expect(line).toContain('reason=title_mismatch');
    expect(line).toContain('file=F_CANVAS');
    expect(line).toContain('title="Weekly Notes"');
  });

  it('logs an external_creator reject classification', async () => {
    userInfoImpl = async () => ({ external: true });

    await ensureChannelCanvas(CHANNEL);

    const line = scanLines().find((l) => l.includes('decision=reject'));
    expect(line).toContain('reason=external_creator');
    expect(line).toContain('creator_class=external');
  });

  it('collapses newlines so the record stays a single physical line', async () => {
    fileInfos.F_CANVAS = { title: 'Not Archie\nsecond line', user: 'U_X', updated: 5 };

    await ensureChannelCanvas(CHANNEL);

    const line = scanLines().find((l) => l.includes('title_mismatch'));
    expect(line).toBeDefined();
    expect(line).not.toContain('\n');
    expect(line).toContain('title="Not Archie second line"');
  });

  it('logs a ttl skip when the store was checked within the TTL window', async () => {
    storesByChannel[CHANNEL] = { canvases: [], announced: {}, checkedAt: Date.now() };

    await ensureChannelCanvas(CHANNEL);

    expect(scanLines().some((l) => l.includes('decision=skip') && l.includes('reason=ttl'))).toBe(true);
  });
});

describe('collectCanvasFileAllowlist', () => {
  beforeEach(() => {
    storesByChannel = {};
  });

  it('unions adopted canvas ids with their referenced file ids across linked slack channels, skipping external', async () => {
    storesByChannel['C1'] = { canvases: [adoptedEntry('F1', ['FA', 'FB'])], announced: {}, checkedAt: 0 };
    storesByChannel['C2'] = { canvases: [{ ...adoptedEntry('F2', ['FC']), external: true }], announced: {}, checkedAt: 0 };

    const metadata = {
      channels: {
        a: { type: 'slack', channel_id: 'C1' },
        b: { type: 'slack', channel_id: 'C2' },
        c: { type: 'cli', id: 'cli:local' },
      },
    } as unknown as TaskMetadata;

    const allowed = await collectCanvasFileAllowlist(metadata);

    expect([...allowed].sort()).toEqual(['F1', 'FA', 'FB']);
  });

  it('is empty when no channel has an adopted canvas', async () => {
    const metadata = { channels: { a: { type: 'slack', channel_id: 'C9' } } } as unknown as TaskMetadata;

    expect((await collectCanvasFileAllowlist(metadata)).size).toBe(0);
  });
});
