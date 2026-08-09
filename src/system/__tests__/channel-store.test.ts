/**
 * Tests for the channel store's pins fields and its load-time normalisation.
 *
 * `SLACK_CHANNELS_DIR` is computed at module-import time from `WORKDIR`, which
 * itself reads `process.env.ARCHIE_WORKDIR` at import time — so the env var is set
 * to a temp dir BEFORE the store module is imported, and the module is pulled in
 * dynamically rather than with a static import.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const loggerWarn = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { warn: loggerWarn, system: vi.fn(), error: vi.fn() },
}));

const WORK = mkdtempSync(join(tmpdir(), 'archie-channel-store-'));
process.env.ARCHIE_WORKDIR = WORK;

const store = await import('../channel-store.js');
const CHANNELS_DIR = store.SLACK_CHANNELS_DIR;

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

beforeEach(() => {
  loggerWarn.mockClear();
});

/** Write a raw store file for `channelId` with whatever JSON text is given. */
async function writeRaw(channelId: string, body: string): Promise<void> {
  await mkdir(CHANNELS_DIR, { recursive: true });
  await writeFile(join(CHANNELS_DIR, `${channelId}.json`), body);
}

function samplePin(): import('../channel-store.js').ChannelPinEntry {
  return {
    kind: 'message',
    key: '1700000000.000100',
    pinnedAt: 1700000000,
    pinnedBy: 'UPINNER',
    authorName: 'Dana',
    postedAt: 1699999000,
    summary: 'Deploy runbook for the release train',
    summarySource: 'verbatim',
    digest: 'abc123def4567890',
    permalink: 'https://acme.slack.com/archives/C1/p1700000000000100',
  };
}

describe('loadChannelStore — pins normalisation', () => {
  it('fills in the pins fields for a legacy store that predates them', async () => {
    await writeRaw('C_legacy', JSON.stringify({ canvases: [], announced: { F1: true }, checkedAt: 42 }));

    const loaded = await store.loadChannelStore('C_legacy');

    expect(loaded).not.toBeNull();
    expect(loaded!.pins).toEqual([]);
    expect(loaded!.pinsCheckedAt).toBe(0);
    expect(loaded!.pinsTotal).toBe(0);
    // Existing fields survive untouched.
    expect(loaded!.announced).toEqual({ F1: true });
    expect(loaded!.checkedAt).toBe(42);
  });

  it('round-trips pins that are already present on disk', async () => {
    const pin = samplePin();
    await writeRaw(
      'C_pins',
      JSON.stringify({ canvases: [], announced: {}, checkedAt: 0, pins: [pin], pinsCheckedAt: 999, pinsTotal: 7 }),
    );

    const loaded = await store.loadChannelStore('C_pins');

    expect(loaded!.pins).toEqual([pin]);
    expect(loaded!.pinsCheckedAt).toBe(999);
    expect(loaded!.pinsTotal).toBe(7);
  });

  it('reloads pins written through updateChannelStore', async () => {
    const pin = samplePin();

    await store.updateChannelStore('C_write', (s) => {
      s.pins = [pin];
      s.pinsCheckedAt = 1234;
      s.pinsTotal = 1;
    });

    const loaded = await store.loadChannelStore('C_write');
    expect(loaded!.pins).toEqual([pin]);
    expect(loaded!.pinsCheckedAt).toBe(1234);
    expect(loaded!.pinsTotal).toBe(1);
    // And it really went to disk in that shape.
    const onDisk = JSON.parse(await readFile(join(CHANNELS_DIR, 'C_write.json'), 'utf-8'));
    expect(onDisk.pins).toEqual([pin]);
  });

  it('still returns null and warns on unparseable JSON', async () => {
    await writeRaw('C_broken', '{ not json at all');

    const loaded = await store.loadChannelStore('C_broken');

    expect(loaded).toBeNull();
    expect(loggerWarn).toHaveBeenCalled();
  });
});
