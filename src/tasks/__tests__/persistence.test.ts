/**
 * Unit tests for the persistence-side rendering helpers, plus metadata round-trip persistence.
 *
 * Body rendering itself now lives in `src/connectors/slack/message-body.ts` and is tested there; what remains here is `renderAttachmentsSuffix` (the OUTBOUND suffix, which has no Slack input) and `renderEditForContext`. The suffix cases below pin how far outbound agreement with the inbound renderer goes — and where it deliberately stops.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
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

import { renderAttachmentsSuffix, renderEditForContext, loadMetadata, getMetadataPath, writeTaskMetadata } from '../persistence.js';
import { renderMessageBody } from '../../connectors/slack/message-body.js';
import type { SlackFile } from '../../types/index.js';
import type { TaskMetadata } from '../../types/task.js';

afterAll(async () => {
  await rm(SESSIONS_ROOT, { recursive: true, force: true });
});

/**
 * `renderAttachmentsSuffix` serves the OUTBOUND side (agent → Slack), where every artifact is a real local path, while the inbound suffix serves messages whose files may or may not have been downloaded yet. The two are expected to agree only in the case where that difference vanishes.
 */
describe('renderAttachmentsSuffix — agreement with the inbound [Attachments: …] suffix', () => {
  it('matches the inbound suffix exactly when every file has a localPath', () => {
    const paths = ['/tmp/artifacts/report.pdf', '/tmp/artifacts/chart.png'];
    // Same files, expressed as the inbound shape: name is the basename, localPath the full path — the one case where both renderers have identical information.
    const files: SlackFile[] = paths.map((p, i) => ({
      id: `F${i}`,
      name: p.slice(p.lastIndexOf('/') + 1),
      mimetype: 'application/octet-stream',
      url_private: '',
      localPath: p,
    }));

    const inbound = renderMessageBody({ ownText: 'here you go', files }, { redacted: false });
    const suffix = renderAttachmentsSuffix(paths);

    expect(suffix).toBe('\n  [Attachments: report.pdf (/tmp/artifacts/report.pdf), chart.png (/tmp/artifacts/chart.png)]');
    expect(inbound).toBe(`here you go${suffix}`);
    expect(inbound.endsWith(suffix)).toBe(true);
  });

  it('deliberately diverges from the inbound suffix for a file with no localPath', () => {
    // `SlackFile.localPath` is optional: a message whose files were never downloaded (a redaction-adjacent path, or a download failure) renders the bare name. `renderAttachmentsSuffix` cannot reach this state — it is always given real paths — so the two forms differ by design and neither should be "fixed" to match the other.
    const files: SlackFile[] = [
      { id: 'F1', name: 'report.pdf', mimetype: 'application/pdf', url_private: '' },
    ];

    const inbound = renderMessageBody({ ownText: 'here you go', files }, { redacted: false });

    expect(inbound).toBe('here you go\n  [Attachments: report.pdf]');
    expect(inbound).not.toBe(`here you go${renderAttachmentsSuffix(['report.pdf'])}`);
    expect(renderAttachmentsSuffix(['report.pdf'])).toBe('\n  [Attachments: report.pdf (report.pdf)]');
  });
});

describe('writeTaskMetadata', () => {
  it('prevents a concurrent stale public writer from restoring persisted public visibility', async () => {
    const taskId = 'task-20260817-1200-visrace';
    const path = getMetadataPath(taskId);
    await mkdir(dirname(path), { recursive: true });
    const base: TaskMetadata = {
      task_id: taskId,
      visibility: 'public',
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
    await writeFile(path, JSON.stringify(base, null, 2));
    const downgrade = { ...base, visibility: 'private' as const };
    const stalePublic = { ...base, status: 'stopped' as const };

    await Promise.all([
      writeTaskMetadata(taskId, downgrade),
      writeTaskMetadata(taskId, stalePublic),
    ]);

    const persisted = JSON.parse(await readFile(path, 'utf-8')) as TaskMetadata;
    expect(persisted.visibility).toBe('private');
    expect(stalePublic.visibility).toBe('private');
  });

  it('rejects malformed task IDs before constructing metadata paths', async () => {
    await expect(
      writeTaskMetadata('../escape', { task_id: '../escape', visibility: 'public' } as TaskMetadata),
    ).rejects.toThrow('Invalid task ID');
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
      visibility: 'public',
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
      visibility: 'public',
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
