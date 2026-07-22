import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Agent } from '../agents/agent.js';
import type { Task } from '../tasks/task.js';
import { getRunnerManager } from './index.js';

export const RUNNER_TOOL_NAMES = [
  'mcp__runner-tools__runner_list_profiles',
  'mcp__runner-tools__runner_ensure',
  'mcp__runner-tools__runner_sync',
  'mcp__runner-tools__runner_exec',
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
        'runner_ensure',
        'Provision or reuse the task-scoped VM lease for a runner profile.',
        { profile: z.string().min(1) },
        async ({ profile }) => runTool(async () => {
          const lease = await manager().ensure(task.taskId, agent.def.id, profile);
          return JSON.stringify({ leaseId: lease.id, profile, state: lease.state, expiresAt: lease.expiresAt });
        }),
      ),
      tool(
        'runner_sync',
        'Copy tracked and unignored repository files into the task-scoped VM. Ignored files and .git are excluded.',
        { profile: z.string().min(1), github: z.string().optional() },
        async ({ profile, github }) => runTool(async () => {
          const attached = attachedRepository(agent, task, github);
          const result = await manager().sync(task.taskId, agent.def.id, profile, attached.github, attached.clonePath);
          return JSON.stringify({ leaseId: result.lease.id, github: attached.github, remotePath: result.remotePath, bytes: result.bytes, files: result.files });
        }),
      ),
      tool(
        'runner_exec',
        'Start a generic argv-based command in the synced primary repository. Long commands detach and can be polled.',
        {
          profile: z.string().min(1),
          argv: z.array(z.string()).min(1).max(256),
          cwd: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
          wait_seconds: z.number().int().min(0).max(120).optional(),
        },
        async ({ profile, argv, cwd, env, wait_seconds }) => runTool(async () => {
          const attached = attachedRepository(agent, task);
          return JSON.stringify(await manager().exec(task.taskId, agent.def.id, profile, attached.github, argv, cwd, env, wait_seconds));
        }),
      ),
      tool(
        'runner_exec_poll',
        'Reconnect to a detached runner command and return output newer than its durable watermark.',
        {
          profile: z.string().min(1),
          exec_id: z.string().uuid(),
          wait_seconds: z.number().int().min(0).max(120).optional(),
        },
        async ({ profile, exec_id, wait_seconds }) => runTool(async () => JSON.stringify(
          await manager().poll(task.taskId, agent.def.id, profile, exec_id, wait_seconds),
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
        'Extend the VM lease for bounded human VNC debugging and return credential-free Orchard CLI commands.',
        { profile: z.string().min(1), ttl_minutes: z.number().int().min(1).max(1440).optional() },
        async ({ profile, ttl_minutes }) => runTool(async () => JSON.stringify(
          await manager().openDebug(task.taskId, agent.def.id, profile, ttl_minutes),
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
