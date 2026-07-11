/**
 * Unit tests for Task.linkGitHubChannel / Task.isGitHubBorn and the github
 * branch of postToUser / postFilesToUser.
 *
 * Uses real Task.create() against a temp SESSIONS_DIR (via ARCHIE_WORKDIR) so
 * channel entries land in real on-disk metadata; GitHub client and Slack are
 * mocked.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { rm } from 'fs/promises';

const WORKDIR_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'archie-github-channel-test-'));
  process.env.ARCHIE_WORKDIR = dir;
  return dir;
});

vi.mock('../../system/plugin-sync.js', () => ({
  syncPlugins: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../agents/registry.js', () => ({
  scanAgentDefs: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  synthesizeDynamicAgentDef: vi.fn(),
}));

vi.mock('../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), slack: vi.fn(), agentAction: vi.fn(), agentFinding: vi.fn(),
    agentToSlack: vi.fn(), agentMessage: vi.fn(),
  },
}));

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn(),
}));

vi.mock('../../connectors/slack/client.js', () => ({
  postSlackMessage: vi.fn().mockResolvedValue(undefined),
  postSlackFiles: vi.fn().mockResolvedValue(undefined),
  postInteractiveToThread: vi.fn(),
  postInteractiveToThreads: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  buildPrCardBlocks: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getMessageReactions: vi.fn(),
  buildThreadUrl: vi.fn().mockReturnValue(null),
  isExternalUser: vi.fn().mockReturnValue(false),
  formatSlackChannelRef: vi.fn().mockReturnValue('slack:#<C1:general>:1'),
  formatSlackChannelDisplay: vi.fn().mockReturnValue('#general'),
}));

import { Task } from '../task.js';
import { loadMetadata } from '../persistence.js';

afterAll(async () => {
  await rm(WORKDIR_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Task.linkGitHubChannel', () => {
  it('writes the channel entry under github:{repo}#{n} with the reshaped fields', async () => {
    const task = await Task.create();
    const key = task.linkGitHubChannel('acme/backend', 42, true);

    expect(key).toBe('github:acme/backend#42');
    expect(task.metadata.channels[key]).toEqual({
      type: 'github',
      repo: 'acme/backend',
      issue_number: 42,
      is_pr: true,
    });
  });

  it('promotes default_channel only when unset', async () => {
    const task = await Task.create();
    const key = task.linkGitHubChannel('acme/backend', 7, false);
    expect(task.metadata.default_channel).toBe(key);

    const other = task.linkGitHubChannel('acme/backend', 8, false);
    expect(other).toBe('github:acme/backend#8');
    expect(task.metadata.default_channel).toBe(key);
  });

  it('does not steal default_channel from an existing channel', async () => {
    const task = await Task.create();
    task.linkCliChannel();
    const cliDefault = task.metadata.default_channel;

    task.linkGitHubChannel('acme/backend', 9, false);
    expect(task.metadata.default_channel).toBe(cliDefault);
  });

  it('is idempotent on re-link, preserving the entry and its watermark', async () => {
    const task = await Task.create();
    const key = task.linkGitHubChannel('acme/backend', 42, false);
    const entry = task.metadata.channels[key] as { last_processed_comment_id?: number };
    entry.last_processed_comment_id = 555;

    const again = task.linkGitHubChannel('acme/backend', 42, false);
    expect(again).toBe(key);
    expect(task.metadata.channels[key]).toBe(entry);
    expect((task.metadata.channels[key] as { last_processed_comment_id?: number }).last_processed_comment_id).toBe(555);
    expect(Object.keys(task.metadata.channels)).toEqual([key]);
  });

  it('persists to on-disk metadata via save(true)', async () => {
    const task = await Task.create();
    task.linkGitHubChannel('acme/backend', 42, true);
    await task.save(true);

    const onDisk = await loadMetadata(task.taskId);
    expect(onDisk?.channels['github:acme/backend#42']).toEqual({
      type: 'github',
      repo: 'acme/backend',
      issue_number: 42,
      is_pr: true,
    });
    expect(onDisk?.default_channel).toBe('github:acme/backend#42');
  });
});

describe('Task.isGitHubBorn', () => {
  it('is true when any channel is a github channel', async () => {
    const task = await Task.create();
    task.linkCliChannel();
    task.linkGitHubChannel('acme/backend', 42, false);
    expect(task.isGitHubBorn()).toBe(true);
  });

  it('is false without a github channel', async () => {
    const task = await Task.create();
    expect(task.isGitHubBorn()).toBe(false);
    task.linkCliChannel();
    expect(task.isGitHubBorn()).toBe(false);
  });
});
