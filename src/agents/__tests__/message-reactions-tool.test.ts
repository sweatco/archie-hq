/**
 * Handler-level tests for `get_message_reactions`. The tool has to keep three
 * outcomes apart: reactions, genuinely none, and a read that failed. Rendering a
 * failed read as "has no reactions" is what let the PM tell a user a visibly
 * reacted message carried nothing — and invent a reason for it — while the token
 * was simply missing `reactions:read`.
 *
 * Mock shape and handler extraction follow explore-tools.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

// Heavy deps tools.ts pulls in — mock to import-safe stubs (same as explore-tools.test.ts).
vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../connectors/github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  setupSharedClone: vi.fn().mockResolvedValue({ clone_path: '/wt', branch: 'feat/x', base_branch: 'main' }),
  cloneExists: vi.fn().mockResolvedValue(false),
  isWorktree: vi.fn().mockResolvedValue(false),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  getReposPath: vi.fn().mockReturnValue('/sessions/task-123/repos'),
  isThreadMuted: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../system/logger.js', () => ({
  logger: { agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(), system: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../connectors/slack/channel-canvas.js', () => ({
  ensureChannelCanvas: vi.fn().mockResolvedValue(undefined),
  buildOtherChannelContextSection: vi.fn().mockResolvedValue(''),
  collectCanvasFileAllowlist: vi.fn(),
}));
vi.mock('../../connectors/slack/channel-pins.js', () => ({
  collectPinnedFileAllowlist: vi.fn(),
}));

import { createCommsMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { SlackReactionsResult } from '../../connectors/slack/client.js';

function makeAgent(): Agent {
  return { def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true }, queue: {} as any, session: { active: false } } as unknown as Agent;
}

/** A task whose reactions read returns exactly `outcome` (null = no channel resolved). */
function makeTask(outcome: SlackReactionsResult | null): Task {
  const key = 'slack:C1:1.0';
  return {
    taskId: 'task-1',
    metadata: {
      channels: { [key]: { type: 'slack', channel_id: 'C1', thread_id: '1.0', channel_name: 'origin' } },
      default_channel: key,
    },
    touch: vi.fn(), debouncedSave: vi.fn(), save: vi.fn().mockResolvedValue(undefined),
    readMessageReactions: vi.fn().mockResolvedValue(outcome),
  } as unknown as Task;
}

function getHandler(task: Task): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const server = createCommsMcpServer(makeAgent(), task);
  const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
  const entry = raw['get_message_reactions'];
  const fn = entry.callback ?? entry.handler ?? entry.cb;
  return (args) => fn(args, {});
}

async function textOf(result: { content: { text: string }[] }): Promise<string> {
  return result.content[0].text;
}

describe('get_message_reactions renders failure, emptiness and reactions differently', () => {
  it('names the missing scope when Slack refused for missing_scope', async () => {
    const read = getHandler(makeTask({ ok: false, error: 'missing_scope' }));

    const out = await textOf(await read({ message_id: '100.0' }));

    expect(out).toMatch(/could not read reactions/i);
    expect(out).toContain('missing_scope');
    expect(out).toContain('reactions:read');
    expect(out).not.toMatch(/no reactions/i);
  });

  it('reports any other Slack error code without claiming the message is unreacted', async () => {
    const read = getHandler(makeTask({ ok: false, error: 'message_not_found' }));

    const out = await textOf(await read({ message_id: '100.0' }));

    expect(out).toMatch(/could not read reactions/i);
    expect(out).toContain('message_not_found');
    expect(out).not.toContain('reactions:read');
    expect(out).not.toMatch(/has no reactions/i);
  });

  it('says "no reactions" only for a successful empty read', async () => {
    const read = getHandler(makeTask({ ok: true, reactions: [] }));

    expect(await textOf(await read({ message_id: '100.0' }))).toBe('Message 100.0 has no reactions.');
  });

  it('renders a non-empty read unchanged — emoji, count and who reacted', async () => {
    const read = getHandler(makeTask({ ok: true, reactions: [
      { name: 'eyes', count: 2, users: ['Sergei P', 'Egor K'] },
      { name: 'thumbsup', count: 1 },
    ] }));

    const out = await textOf(await read({ message_id: '100.0' }));

    expect(out).toBe('Reactions on 100.0:\n:eyes: (2) — Sergei P, Egor K\n:thumbsup: (1)');
  });

  it('still reports an unresolvable channel separately from a failed read', async () => {
    const read = getHandler(makeTask(null));

    const out = await textOf(await read({ message_id: '100.0', channel: 'slack:C9:2.0' }));

    expect(out).toContain('is not a linked Slack thread');
  });
});
