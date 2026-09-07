import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Agent } from '../agents/agent.js';
import type { Task } from '../tasks/task.js';
import { getRunnerManager } from './index.js';
import { runnerMcpArgv } from './mcp.js';

export const RUNNER_TOOL_NAMES = [
  'mcp__runner-tools__runner_list_profiles',
  'mcp__runner-tools__runner_sync',
  'mcp__runner-tools__runner_exec',
  'mcp__runner-tools__runner_mcp',
  'mcp__runner-tools__runner_exec_poll',
  'mcp__runner-tools__runner_exec_cancel',
  'mcp__runner-tools__runner_collect',
  'mcp__runner-tools__runner_open_debug',
  'mcp__runner-tools__runner_release',
] as const;

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }] });

function manager() {
  const current = getRunnerManager();
  if (!current) throw new Error('Runner support is disabled');
  return current;
}

function attachedRepository(agent: Agent, task: Task, requested?: string): { github: string; clonePath: string } {
  const repo = agent.def.repo;
  if (!repo) throw new Error('Runner tools require a repository agent');
  const github = requested ?? repo.primary;
  if (!repo.repos.some((entry) => entry.github === github)) throw new Error(`Repository ${github} is not declared for ${agent.def.id}`);
  const attached = task.metadata.repositories[agent.def.id];
  const match = Array.isArray(attached) ? attached.find((entry) => entry.github === github) : undefined;
  if (!match?.clone_path) throw new Error(`Repository ${github} has no local clone`);
  return { github, clonePath: match.clone_path };
}

async function runTool(fn: () => Promise<string>) {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

export function shouldAttachRunnerTools(agentId: string): boolean {
  return (getRunnerManager()?.profilesForAgent(agentId).length ?? 0) > 0;
}

export function createRunnerToolsMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'runner-tools',
    version: '1.0.0',
    tools: [
      tool(
        'runner_list_profiles',
        'List the operator-defined remote VM profiles this repository agent may use.',
        {},
        async () => runTool(async () => JSON.stringify({ profiles: manager().profilesForAgent(agent.def.id) })),
      ),
      tool(
        'runner_sync',
        'Provision or reuse a task-scoped VM, then copy tracked and unignored repository files into it. Ignored files and .git are excluded.',
        { profile: z.string().min(1), github: z.string().optional() },
        async ({ profile, github }) => runTool(async () => {
          const attached = attachedRepository(agent, task, github);
          const result = await manager().sync(task.taskId, agent.def.id, profile, attached.github, attached.clonePath);
          return JSON.stringify({ leaseId: result.lease.id, github: attached.github, remotePath: result.remotePath, bytes: result.bytes, files: result.files });
        }),
      ),
      tool(
        'runner_exec',
        'Start a generic argv-based command in the synced primary repository. Reuse the same request_id if the result is lost; long commands detach and can be polled.',
        {
          profile: z.string().min(1),
          request_id: z.string().uuid(),
          argv: z.array(z.string()).min(1).max(256),
          cwd: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
          wait_seconds: z.number().int().min(0).max(120).optional(),
        },
        async ({ profile, request_id, argv, cwd, env, wait_seconds }) => runTool(async () => {
          const attached = attachedRepository(agent, task);
          return JSON.stringify(await manager().exec(task.taskId, agent.def.id, profile, attached.github, argv, cwd, env, wait_seconds, request_id));
        }),
      ),
      tool(
        'runner_mcp',
        'Discover or call a stdio MCP server declared in the synced repository .mcp.json, inside the task VM. Omit tool to list tools and schemas. Uses the guest Node.js and repository MCP SDK. Reuse request_id after an uncertain result; poll execId with runner_exec_poll. stdout contains the MCP result or a result_path for runner_collect when larger than 64 KiB. Check isError and the tool-specific verdict. Images are saved beside the result JSON for collection and viewing. Each call opens a new MCP session; backend services may persist until VM release.',
        {
          profile: z.string().min(1),
          request_id: z.string().uuid(),
          server: z.string().min(1).max(128),
          tool: z.string().min(1).max(256).optional(),
          arguments: z.record(z.string(), z.unknown()).optional(),
          timeout_seconds: z.number().int().min(1).max(600).optional(),
        },
        async ({ profile, request_id, ...request }) => runTool(async () => {
          const attached = attachedRepository(agent, task);
          return JSON.stringify(await manager().exec(task.taskId, agent.def.id, profile, attached.github, runnerMcpArgv(request_id, request), '.', {}, 5, request_id));
        }),
      ),
      tool(
        'runner_exec_poll',
        'Reconnect to a command and replay output after the last delivery cursor the caller received. Reuse after_cursor when a poll result is lost.',
        {
          profile: z.string().min(1),
          exec_id: z.string().uuid(),
          after_cursor: z.number().int().nonnegative(),
          wait_seconds: z.number().int().min(0).max(120).optional(),
        },
        async ({ profile, exec_id, after_cursor, wait_seconds }) => runTool(async () => JSON.stringify(
          await manager().poll(task.taskId, agent.def.id, profile, exec_id, after_cursor, wait_seconds),
        )),
      ),
      tool(
        'runner_exec_cancel',
        'Terminate a detached runner command.',
        { profile: z.string().min(1), exec_id: z.string().uuid() },
        async ({ profile, exec_id }) => runTool(async () => {
          await manager().cancel(task.taskId, agent.def.id, profile, exec_id);
          return `Cancelled runner command ${exec_id}.`;
        }),
      ),
      tool(
        'runner_collect',
        'Download relative paths from the synced primary repository into the task shared artifacts directory.',
        { profile: z.string().min(1), paths: z.array(z.string()).min(1).max(100) },
        async ({ profile, paths }) => runTool(async () => {
          const attached = attachedRepository(agent, task);
          const destination = await manager().collect(task.taskId, agent.def.id, profile, attached.github, paths);
          return JSON.stringify({ artifactPath: destination });
        }),
      ),
      tool(
        'runner_open_debug',
        'Extend the VM lease for bounded human debugging and return credential-free Orchard VNC and requested TCP port-forward commands.',
        {
          profile: z.string().min(1),
          ttl_minutes: z.number().int().min(1).max(1440).optional(),
          ports: z.array(z.number().int().min(1024).max(65535)).max(8).optional(),
        },
        async ({ profile, ttl_minutes, ports }) => runTool(async () => JSON.stringify(
          await manager().openDebug(task.taskId, agent.def.id, profile, ttl_minutes, ports),
        )),
      ),
      tool(
        'runner_release',
        'Delete the task-scoped VM lease for a runner profile.',
        { profile: z.string().min(1) },
        async ({ profile }) => runTool(async () => {
          await manager().release(task.taskId, agent.def.id, profile);
          return `Released runner profile ${profile}.`;
        }),
      ),
    ],
  });
}
