/**
 * `Task.append` render-ordering regression test.
 *
 * The knowledge-log body is rendered from `downloadedFiles`, not from `msg.files`, and it must be
 * rendered AFTER the `downloadMessageFiles` await. Only the downloaded copies carry `localPath`, and
 * the inbound `[Attachments: …]` suffix prints the parenthetical path only when `localPath` is set —
 * so hoisting the render above the await silently strips every local path an agent needs to open the
 * file, while leaving the log looking plausible.
 *
 * That invariant previously existed only as a comment: hoisting the render passed the entire suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn() },
}));

vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));

// Without this the case below is a dead branch: `isExternalUser` fails open to false when the Slack
// client was never initialised, so `shouldRedact` would return false and the redacted case would be a
// byte-for-byte duplicate of the first one.
vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return {
    ...actual,
    isExternalUser: (user: { teamId?: string }) => user.teamId === 'T_OTHER',
  };
});

// The two persistence seams this test is about. `downloadMessageFiles` stands in for the real
// download: it returns the same files with `localPath` populated, which is exactly what production
// does and exactly what the render must wait for.
const { downloadMock, appendMock } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  appendMock: vi.fn(),
}));

vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, downloadMessageFiles: downloadMock, appendSlackMessage: appendMock };
});

import { Task } from '../task.js';
import type { TaskMetadata, SlackThread } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

const LOCAL_PATH = '/sessions/t1/attachments/runbook.pdf';

function threadWithFile(): SlackThread {
  return {
    threadId: '100.000',
    channel: { id: 'C1', name: 'ops' },
    shared: false,
    currentMessageTs: '100.000',
    rootAuthorWasBot: false,
    messages: [{
      user: { id: 'U1', username: 'ramin', realName: 'Ramin M' },
      ownText: 'runbook attached',
      ts: '100.000',
      files: [{ id: 'F1', name: 'runbook.pdf', mimetype: 'application/pdf', url_private: 'https://x/y' }],
    }],
  };
}

describe('Task.append renders after the file download', () => {
  beforeEach(() => {
    downloadMock.mockReset();
    appendMock.mockReset();
    appendMock.mockResolvedValue(undefined);
    // The download returns the file with `localPath` filled in — the only source of that value.
    downloadMock.mockImplementation(async (_taskId: string, files: Array<Record<string, unknown>>) =>
      files.map((f) => ({ ...f, localPath: LOCAL_PATH })));
  });

  function newTask(): Task {
    const metadata = { channels: {}, agent_sessions: {} } as unknown as TaskMetadata;
    const task = new TaskCtor('t1', metadata, []);
    // The debounced save writes to disk; this test is about the rendered body, not persistence.
    (task as unknown as { debouncedSave: () => void }).debouncedSave = () => {};
    return task;
  }

  it('puts the downloaded localPath into the logged body, which only holds if the render follows the await', async () => {
    await newTask().append(threadWithFile());

    expect(appendMock).toHaveBeenCalledTimes(1);
    const body = appendMock.mock.calls[0]![4] as string;

    expect(body).toContain('runbook attached');
    // The whole point: the path is present, so the render saw the DOWNLOADED files.
    expect(body).toContain(`runbook.pdf (${LOCAL_PATH})`);
  });

  it('waits for the download to resolve before rendering', async () => {
    let downloadResolved = false;
    downloadMock.mockImplementation(async (_taskId: string, files: Array<Record<string, unknown>>) => {
      await new Promise((r) => setTimeout(r, 0));
      downloadResolved = true;
      return files.map((f) => ({ ...f, localPath: LOCAL_PATH }));
    });
    appendMock.mockImplementation(async () => {
      // If the render were hoisted above the await, the body would be built while this is still false.
      expect(downloadResolved).toBe(true);
    });

    await newTask().append(threadWithFile());
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('skips the download entirely for a redacted message and logs the placeholder', async () => {
    const thread = threadWithFile();
    thread.shared = true;
    thread.messages[0]!.user = { id: 'UEXT', username: 'ext', realName: 'Ext', teamId: 'T_OTHER' };

    await newTask().append(thread);

    // Both halves matter and neither held before: the download must not run for a redacted message (its
    // files must never reach the task's attachments folder, since the body referencing them is a
    // placeholder), and the body must be exactly the placeholder.
    expect(downloadMock).not.toHaveBeenCalled();
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock.mock.calls[0]![4]).toBe('[redacted: external participant in shared channel]');
  });
});
