/**
 * Handler-level tests for the `post_to_channel` explore tool — the success path
 * (returns the posted ts, message not linked to the task) plus the DM-rejection
 * and not_in_channel wiring. Reads/search are covered at the client layer in
 * connectors/slack/__tests__/client.test.ts; this exercises the tool itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Heavy deps tools.ts pulls in — mock to import-safe stubs (same as tool-contract.test.ts).
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
}));
vi.mock('../../system/logger.js', () => ({
  logger: { agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(), system: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
}));

// Partial-mock the Slack client: keep the REAL error classes (format-errors uses
// `instanceof`) and just stub the network call. `vi.hoisted` makes the mock fn
// available to the hoisted vi.mock factory.
const { postSlackMessage } = vi.hoisted(() => ({ postSlackMessage: vi.fn() }));
vi.mock('../../connectors/slack/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, postSlackMessage };
});

import { createCommsMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';

function makeAgent(): Agent {
  return { def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true }, queue: {} as any, session: { active: false } } as unknown as Agent;
}
function makeTask(): Task {
  return { taskId: 'task-1', metadata: { channels: {} }, touch: vi.fn(), debouncedSave: vi.fn() } as unknown as Task;
}

/** Build the comms server and pull a tool's invokable handler out of the MCP registry. */
function getHandler(name: string): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const server = createCommsMcpServer(makeAgent(), makeTask());
  const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
  const entry = raw[name];
  const fn = entry.callback ?? entry.handler ?? entry.cb;
  return (args) => fn(args, {});
}

async function textOf(result: { content: { text: string }[] }): Promise<string> {
  return result.content[0].text;
}

describe('post_to_channel handler', () => {
  beforeEach(() => {
    postSlackMessage.mockReset();
  });

  it('posts a new top-level message and reports the ts, not linked to the task', async () => {
    postSlackMessage.mockResolvedValue('1716998400.123456');
    const post = getHandler('post_to_channel');

    const out = await textOf(await post({ channel: 'C123', message: 'heads up' }));

    expect(postSlackMessage).toHaveBeenCalledWith({ channel: 'C123', text: 'heads up', threadTs: undefined });
    expect(out).toContain('1716998400.123456');
    expect(out).toMatch(/not linked to this task/i);
  });

  it('rejects a DM / user-id target without calling Slack', async () => {
    const post = getHandler('post_to_channel');

    const dm = await textOf(await post({ channel: 'D999', message: 'hi' }));
    const user = await textOf(await post({ channel: 'U999', message: 'hi' }));

    expect(dm).toMatch(/channel-only|never touches DMs/i);
    expect(user).toMatch(/channel-only|never touches DMs/i);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('maps not_in_channel to invite guidance', async () => {
    postSlackMessage.mockRejectedValue({ data: { error: 'not_in_channel' } });
    const post = getHandler('post_to_channel');

    const out = await textOf(await post({ channel: 'C123', message: 'hi' }));

    expect(out).toContain('/invite @Archie');
  });
});
