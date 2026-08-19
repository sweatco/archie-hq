/**
 * A trigger-fired task's home channel counts as standing context.
 *
 * A schedule-fired task has no thread when its first agent — the one that actually does the work — spawns, so `metadata.channels` is empty and only `home_channel` says which channel it is homed in. These tests pin that the shared label derivation covers it, and that both prompt blocks built from that derivation (the canvas brief and the pinned-message index) therefore reach that first agent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskMetadata } from '../../../types/task.js';

let storesByChannel: Record<string, unknown> = {};

vi.mock('../client.js', () => ({
  // channel-canvas.ts
  getChannelCanvasTabs: vi.fn(async () => []),
  getSlackFileInfo: async () => null,
  getUserInfo: async (id: string) => ({ name: id, realName: id, teamId: 'T_HOME' }),
  isExternalUser: (u: { teamId?: string }) => u?.teamId === 'T_OTHER',
  postSlackMessage: vi.fn(async () => {}),
  // channel-pins.ts
  listChannelPins: vi.fn(async () => []),
}));

vi.mock('../canvas-read.js', () => ({
  readCanvas: async () => ({ title: 'Archie Context', markdown: '# standing context', fileIds: [] }),
}));

vi.mock('../pin-summary.js', async () => {
  // Only the model call is faked; normalisePinText / digestOf / truncateTo stay real, since the rendered block runs every attribute through them.
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
  updateChannelStore: async () => undefined,
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { taskSlackChannelLabels } from '../channel-ids.js';
import { buildChannelCanvasPromptSection } from '../channel-canvas.js';
import { buildChannelPinsPromptSection } from '../channel-pins.js';
import { digestOf, normalisePinText } from '../pin-summary.js';

const HOME = 'C_HOME';

const canvasEntry = () => ({
  file_id: 'F_CANVAS',
  title: 'Archie — home brief',
  creator: 'U_INTERNAL',
  external: false,
  updatedTs: 5,
  markdown: '# standing context',
  fileIds: [],
});

const nowSeconds = Math.floor(Date.now() / 1000);

const pinEntry = () => ({
  kind: 'message',
  key: '1699990000.000100',
  pinnedAt: nowSeconds - 2 * 86400,
  pinnedBy: 'U_PINNER',
  pinnedByName: 'Grace Hopper',
  authorName: 'Ada',
  postedAt: nowSeconds - 10 * 86400,
  summary: 'home channel runbook',
  summarySource: 'verbatim',
  digest: digestOf(normalisePinText('home channel runbook')),
  permalink: 'https://slack.example/archives/C_HOME/p1699990000000100',
});

const homeStore = () => ({
  canvases: [canvasEntry()],
  announced: {},
  checkedAt: 0,
  pins: [pinEntry()],
  pinsCheckedAt: 0,
  pinsEligible: 1,
});

beforeEach(() => {
  storesByChannel = { [HOME]: homeStore() };
});

describe('taskSlackChannelLabels', () => {
  it('covers a home channel on a task with no linked channels yet', () => {
    const labels = taskSlackChannelLabels({
      channels: {},
      home_channel: { channel_id: HOME, channel_name: 'home' },
    } as unknown as TaskMetadata);

    expect([...labels]).toEqual([[HOME, '#home']]);
  });

  // Once the task opens its own thread the home channel is ALSO linked, and the link is what carries the name people actually see. Listing it twice would attribute every brief and every pin in that channel to it twice over.
  it('lists linked channels first and never duplicates a linked home channel', () => {
    const labels = taskSlackChannelLabels({
      channels: {
        a: { type: 'slack', channel_id: 'C1', channel_name: 'bot-test' },
        b: { type: 'slack', channel_id: HOME, channel_name: 'home-linked' },
      },
      home_channel: { channel_id: HOME, channel_name: 'home' },
    } as unknown as TaskMetadata);

    expect([...labels]).toEqual([
      ['C1', '#bot-test'],
      [HOME, '#home-linked'],
    ]);
  });
});

describe('standing context reaches a trigger-fired task before it has a thread', () => {
  const triggerMetadata = {
    channels: {},
    home_channel: { channel_id: HOME, channel_name: 'home' },
  } as unknown as TaskMetadata;

  it('injects the home channel canvas brief', async () => {
    const section = await buildChannelCanvasPromptSection(triggerMetadata);

    expect(section).toContain('<channel_project_context');
    expect(section).toContain('title="Archie — home brief"');
    expect(section).toContain('channel="#home"');
    expect(section).toContain('# standing context');
  });

  it('injects the home channel pin index', async () => {
    const section = await buildChannelPinsPromptSection(triggerMetadata);

    expect(section).toContain('<channel_pinned_messages ');
    expect(section).toContain('channel="#home"');
    expect(section).toContain(`channel_id="${HOME}"`);
    expect(section).toContain('>home channel runbook</pin>');
  });

  it('both blocks stay empty with no slack channels and no home channel', async () => {
    const cliOnly = { channels: { a: { type: 'cli', id: 'cli:local' } } } as unknown as TaskMetadata;

    expect(await buildChannelCanvasPromptSection(cliOnly)).toBe('');
    expect(await buildChannelPinsPromptSection(cliOnly)).toBe('');
  });
});
