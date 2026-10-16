import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../agents/agent.js';
import type { Task } from '../../tasks/task.js';
import { createRunnerToolsMcpServer } from '../tools.js';

const manager = vi.hoisted(() => ({
  exec: vi.fn(),
  collect: vi.fn(),
}));
vi.mock('../index.js', () => ({ getRunnerManager: () => manager }));

const requestId = 'a810e1a0-3099-4b5d-8cc1-1094e92b40c6';
const agent = { def: { id: 'pm-agent' } } as Agent;
const repositories = [
  { github: 'org/mobile', clone_path: '/clones/mobile' },
  { github: 'org/backend', clone_path: '/clones/backend' },
];

function toolHandler(name: string, repos = repositories) {
  const task = { taskId: 'task-123', metadata: { repositories: repos } } as unknown as Task;
  const server = createRunnerToolsMcpServer(agent, task);
  const tools = (server.instance as any)._registeredTools;
  return tools[name].callback ?? tools[name].handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  manager.exec.mockResolvedValue({ execId: requestId, state: 'completed' });
  manager.collect.mockResolvedValue('/artifacts/results');
});

const cases = [
  { name: 'runner_exec', args: { profile: 'ios', request_id: requestId, argv: ['pwd'] }, method: 'exec' },
  { name: 'runner_mcp', args: { profile: 'ios', request_id: requestId, server: 'argent', tool: 'list-devices' }, method: 'exec' },
  { name: 'runner_collect', args: { profile: 'ios', paths: ['results'] }, method: 'collect' },
] as const;

describe('runner tool repository selection', () => {
  it.each(cases)('$name selects the requested mounted repository', async ({ name, args, method }) => {
    const result = await toolHandler(name)({ ...args, github: 'ORG/BACKEND' });
    expect(result.content[0].text).not.toMatch(/^Error:/);
    expect(manager[method]).toHaveBeenCalledOnce();
    expect(manager[method].mock.calls[0].slice(0, 4)).toEqual(['task-123', 'pm-agent', 'ios', 'org/backend']);
    if (name === 'runner_mcp') {
      const argv = manager.exec.mock.calls[0][4] as string[];
      expect(JSON.parse(argv.at(-1)!)).toEqual({ server: 'argent', tool: 'list-devices' });
    }
  });

  it.each(cases)('$name rejects ambiguity without running against an arbitrary repository', async ({ name, args, method }) => {
    const result = await toolHandler(name)(args);
    expect(result.content[0].text).toContain('pass github explicitly');
    expect(manager[method]).not.toHaveBeenCalled();
  });

  it.each(cases)('$name retains the single-repository default', async ({ name, args, method }) => {
    const result = await toolHandler(name, [repositories[0]!])(args);
    expect(result.content[0].text).not.toMatch(/^Error:/);
    expect(manager[method].mock.calls[0].slice(0, 4)).toEqual(['task-123', 'pm-agent', 'ios', 'org/mobile']);
  });
});
