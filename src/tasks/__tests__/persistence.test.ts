/**
 * Unit tests for renderMessageForContext, plus metadata round-trip persistence.
 *
 * Direct tests on the pure rendering helper extracted from appendSlackMessage.
 * Covers redaction, forwarded-attachment labels, file lists, edge cases.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { dirname } from 'path';

const SESSIONS_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(join(tmpdir(), 'archie-persistence-test-'));
});

vi.mock('../../connectors/slack/client.js', () => ({
  isExternalUser: (user: { teamId?: string; isRestricted?: boolean; isUltraRestricted?: boolean }) => {
    if (user.isRestricted || user.isUltraRestricted) return true;
    if (user.teamId && user.teamId !== 'T_HOME') return true;
    return false;
  },
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));

vi.mock('../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('../../system/workdir.js', () => ({
  SESSIONS_DIR: SESSIONS_ROOT,
  // WORKDIR is consumed transitively (channel-store derives SLACK_CHANNELS_DIR
  // from it); provide it so the mock is complete for the module graph.
  WORKDIR: SESSIONS_ROOT,
}));

vi.mock('./task.js', () => ({
  activeTasks: new Map(),
}));

import { renderMessageForContext, renderEditForContext, loadMetadata, getMetadataPath, findTaskByIssueChannel } from '../persistence.js';
import type { TaskMetadata } from '../../types/task.js';

afterAll(async () => {
  await rm(SESSIONS_ROOT, { recursive: true, force: true });
});

describe('renderMessageForContext', () => {
  it('renders plain message text with no attachments', () => {
    const out = renderMessageForContext({ text: 'hello world' }, { redacted: false });
    expect(out).toBe('hello world');
  });

  it('appends file list as trailing [Attachments] line', () => {
    const out = renderMessageForContext(
      {
        text: 'see file',
        files: [
          { id: 'F1', name: 'a.txt', mimetype: 'text/plain', url_private: '', localPath: '/p/a.txt' },
        ],
      },
      { redacted: false },
    );
    expect(out).toBe('see file\n  [Attachments: a.txt (/p/a.txt)]');
  });

  it('appends reactions as a trailing [Reactions] line, with counts only above 1', () => {
    const out = renderMessageForContext(
      {
        text: 'nice',
        reactions: [
          { name: 'thumbsup', count: 3 },
          { name: 'eyes', count: 1 },
        ],
      },
      { redacted: false },
    );
    expect(out).toBe('nice\n  [Reactions: :thumbsup: ×3, :eyes:]');
  });

  it('renders both attachments and reactions lines together', () => {
    const out = renderMessageForContext(
      {
        text: 'see file',
        files: [
          { id: 'F1', name: 'a.txt', mimetype: 'text/plain', url_private: '', localPath: '/p/a.txt' },
        ],
        reactions: [{ name: 'tada', count: 1 }],
      },
      { redacted: false },
    );
    expect(out).toBe('see file\n  [Attachments: a.txt (/p/a.txt)]\n  [Reactions: :tada:]');
  });

  it('returns the redaction placeholder when redacted is true', () => {
    const out = renderMessageForContext(
      {
        text: 'should not appear',
        attachments: [{ text: 'also hidden' }],
      },
      { redacted: true },
    );
    expect(out).toBe('[redacted: external participant in shared channel]');
  });

  it('renders externally-authored attachment under a forwarded-from label', () => {
    const out = renderMessageForContext(
      {
        text: 'check this out',
        attachments: [
          {
            text: 'external content body',
            author: {
              id: 'UEXT',
              username: 'ext',
              realName: 'External Person',
              teamId: 'T_OTHER',
            },
          },
        ],
      },
      { redacted: false },
    );
    expect(out).toBe(
      'check this out\n[forwarded from @<UEXT:External Person> — external, team T_OTHER]\nexternal content body',
    );
  });

  it('only labels first external attachment; later externals fold inline', () => {
    const out = renderMessageForContext(
      {
        text: 'top',
        attachments: [
          {
            text: 'first ext',
            author: { id: 'U1', username: 'a', realName: 'A', teamId: 'T_OTHER' },
          },
          {
            text: 'second ext',
            author: { id: 'U2', username: 'b', realName: 'B', teamId: 'T_OTHER' },
          },
        ],
      },
      { redacted: false },
    );
    // top, second ext (folded inline), then forwarded block for first
    expect(out).toBe(
      'top\nsecond ext\n[forwarded from @<U1:A> — external, team T_OTHER]\nfirst ext',
    );
  });

  it('renders empty text + only attachments without leading newline', () => {
    const out = renderMessageForContext(
      {
        text: '',
        attachments: [{ text: 'inline body' }],
      },
      { redacted: false },
    );
    expect(out).toBe('inline body');
  });

  it('omits team suffix when external author has no teamId', () => {
    const out = renderMessageForContext(
      {
        text: 'top',
        attachments: [
          {
            text: 'guest content',
            author: { id: 'UG', username: 'g', realName: 'G', isRestricted: true },
          },
        ],
      },
      { redacted: false },
    );
    expect(out).toBe('top\n[forwarded from @<UG:G> — external]\nguest content');
  });
});

describe('metadata round-trip — pending_merge_approval', () => {
  it('persists and reloads the pending merge-approval slot', async () => {
    const taskId = 'task-merge-approval-rt';
    const slot = {
      github: 'org/backend',
      pr_number: 42,
      requested_by: 'backend-agent',
      requested_at: '2026-07-06T00:00:00.000Z',
    };
    const metadata: TaskMetadata = {
      task_id: taskId,
      task_owner: null,
      participants: [],
      channels: {},
      default_channel: null,
      agent_sessions: {},
      repositories: {},
      status: 'in_progress',
      pending_merge_approval: slot,
      created_at: '2026-07-06T00:00:00.000Z',
      updated_at: '2026-07-06T00:00:00.000Z',
    };

    const path = getMetadataPath(taskId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(metadata, null, 2));

    const loaded = await loadMetadata(taskId);
    expect(loaded).not.toBeNull();
    expect(loaded!.pending_merge_approval).toEqual(slot);
  });

  it('is absent after a reload when never set', async () => {
    const taskId = 'task-no-merge-approval';
    const metadata: TaskMetadata = {
      task_id: taskId,
      task_owner: null,
      participants: [],
      channels: {},
      default_channel: null,
      agent_sessions: {},
      repositories: {},
      status: 'in_progress',
      created_at: '2026-07-06T00:00:00.000Z',
      updated_at: '2026-07-06T00:00:00.000Z',
    };

    const path = getMetadataPath(taskId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(metadata, null, 2));

    const loaded = await loadMetadata(taskId);
    expect(loaded!.pending_merge_approval).toBeUndefined();
  });
});

describe('findTaskByIssueChannel', () => {
  async function writeTask(taskId: string, channels: TaskMetadata['channels']): Promise<void> {
    const metadata: TaskMetadata = {
      task_id: taskId,
      task_owner: null,
      participants: [],
      channels,
      default_channel: Object.keys(channels)[0] ?? null,
      agent_sessions: {},
      repositories: {},
      status: 'in_progress',
      created_at: '2026-07-11T00:00:00.000Z',
      updated_at: '2026-07-11T00:00:00.000Z',
    };
    const path = getMetadataPath(taskId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(metadata, null, 2));
  }

  it('finds a task via its github channel entry', async () => {
    await writeTask('task-github-born-1', {
      'github:acme/backend#55': { type: 'github', repo: 'acme/backend', issue_number: 55, is_pr: false },
    });

    await expect(findTaskByIssueChannel('acme/backend', 55)).resolves.toBe('task-github-born-1');
  });

  it('returns null when the repo does not match', async () => {
    await writeTask('task-github-born-2', {
      'github:acme/mobile#61': { type: 'github', repo: 'acme/mobile', issue_number: 61, is_pr: false },
    });

    await expect(findTaskByIssueChannel('acme/backend', 61)).resolves.toBeNull();
  });

  it('rejects a substring hit without a structurally matching channel', async () => {
    // "issue_number": 63 is a substring prefix of "issue_number": 630 — the
    // scan hits, the structural check must reject it.
    await writeTask('task-github-born-3', {
      'github:acme/backend#630': { type: 'github', repo: 'acme/backend', issue_number: 630, is_pr: false },
    });

    await expect(findTaskByIssueChannel('acme/backend', 63)).resolves.toBeNull();
  });
});

describe('renderEditForContext', () => {
  it('tags the new text as an edit and omits the previous text', () => {
    const out = renderEditForContext('deploy to prod');
    expect(out).toBe('[edited] deploy to prod');
  });

  it('preserves multi-line new text verbatim', () => {
    const out = renderEditForContext('line one\nline two');
    expect(out).toBe('[edited] line one\nline two');
  });
});
