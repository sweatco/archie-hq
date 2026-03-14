/**
 * Unified Agent Spawner
 *
 * Single spawnAgent(agent, task) function replaces three separate spawners
 * (pm.ts, repo-agent.ts, plugin-agent.ts). Branches on agent.def.track for
 * model, CWD, prompt, tools, edit mode, and skills.
 *
 * Session recovery pattern (try with session → reset → retry → give up) written once.
 */

import { join } from 'path';
import { mkdir, symlink, readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent } from './agent.js';
import type { Task } from '../tasks/task.js';
import { createPMAgentMcpServer, createBaseAgentMcpServer, createRepoPRMcpServer } from './tools.js';
import { createResearchMcpServer, createResearchPostToolHook, createResearchDefenseTagHook } from '../mcp/research-tools.js';
import { buildPeerList } from './registry.js';
import {
  getSharedPath,
  getTaskPath,
  getReposPath,
} from '../tasks/persistence.js';
import {
  createRecoverableInputGenerator,
} from './message-queue.js';
import { setupWorktree, worktreeExists, fetchOrigin } from '../connectors/github/worktree.js';
import { loadPrompt } from '../utils/prompt-loader.js';
import { processAgentEventForLogging, logger } from '../system/logger.js';
import { PLUGINS_DIR } from '../system/workdir.js';

/**
 * Load and parse .mcp.json from the plugins directory.
 * Substitutes ${MCP_*} placeholders with matching environment variables.
 * Only MCP_-prefixed vars are eligible — others are left as-is.
 */
async function loadPluginMcpServers(): Promise<Record<string, any>> {
  const mcpPath = join(PLUGINS_DIR, '.mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const raw = await readFile(mcpPath, 'utf8');
      const substituted = raw.replace(/\$\{(MCP_[A-Z0-9_]+)\}/g, (_, name) => {
        const value = process.env[name];
        if (!value) logger.warn('system', `Plugin MCP: env var ${name} is not set`);
        return value ?? '';
      });
      const parsed = JSON.parse(substituted);
      return parsed.mcpServers ?? {};
    } catch (err) {
      logger.warn('system', `Plugin MCP: failed to load ${mcpPath}: ${err}`);
    }
  }
  return {};
}

// ---- Prompt generation (per track) ----

async function generatePMPrompt(task: Task): Promise<string> {
  const pmDef = task.team.find((d) => d.track === 'pm');
  return loadPrompt('pm-agent', {
    TEAM_LIST: pmDef?.pmConfig?.teamList ?? '',
    TEAM_EXPERTISE: pmDef?.pmConfig?.teamExpertise ?? '',
  });
}

async function generateRepoAgentPrompt(agent: Agent): Promise<string> {
  const def = agent.def;
  const peerList = buildPeerList(def.id);

  const corePrompt = await loadPrompt('agent-core', {
    AGENT_ID: def.id,
    AGENT_ROLE: def.role,
    EXPERTISE: def.expertise,
    PEER_LIST: peerList,
  });

  const repoPrompt = await loadPrompt('repo-agent', {
    REPO_KEY: def.repo!.repoKey,
    BASE_BRANCH: def.repo!.baseBranch || 'main',
  });

  const layers = [corePrompt, repoPrompt];
  if (def.agentPrompt) layers.push(def.agentPrompt);
  return layers.join('\n\n');
}

async function generatePluginAgentPrompt(agent: Agent): Promise<string> {
  const def = agent.def;
  const peerList = buildPeerList(def.id);

  const corePrompt = await loadPrompt('agent-core', {
    AGENT_ID: def.id,
    AGENT_ROLE: def.role,
    EXPERTISE: def.expertise,
    PEER_LIST: peerList,
  });

  const pluginPrompt = await loadPrompt('plugin-agent', {});

  const layers = [corePrompt, pluginPrompt];
  if (def.agentPrompt) layers.push(def.agentPrompt);
  return layers.join('\n\n');
}

// ---- Plugin agent workspace setup ----

async function setupAgentWorkspace(taskId: string, agent: Agent): Promise<string> {
  const agentWorkspace = join(getTaskPath(taskId), 'agents', agent.def.key);
  await mkdir(agentWorkspace, { recursive: true });

  if (agent.def.skillsPath && existsSync(agent.def.skillsPath)) {
    const agentSkillsDir = join(agentWorkspace, '.claude', 'skills');
    await mkdir(join(agentWorkspace, '.claude'), { recursive: true });

    for (const skillEntry of await readdir(agent.def.skillsPath, { withFileTypes: true })) {
      if (!skillEntry.isDirectory()) continue;
      const target = join(agentSkillsDir, skillEntry.name);
      if (!existsSync(target)) {
        await mkdir(agentSkillsDir, { recursive: true });
        await symlink(join(agent.def.skillsPath, skillEntry.name), target);
      }
    }
  }

  return agentWorkspace;
}

// ---- Main spawner ----

/**
 * Spawn an agent. Branches on agent.def.track for all track-specific behavior.
 * Sets agent.handle on success.
 */
export async function spawnAgent(agent: Agent, task: Task): Promise<void> {
  const { def } = agent;
  const taskId = task.taskId;
  const metadata = task.metadata;
  const sharedPath = getSharedPath(taskId);

  // ---- Build track-specific config ----

  let systemPrompt: string;
  let cwd: string;
  let additionalDirectories: string[] | undefined;
  let mcpServers: Record<string, any>;
  let allowedTools: string[];
  let model: string;
  let startFreshSession = false;

  if (def.track === 'pm') {
    // ---- PM track ----
    systemPrompt = await generatePMPrompt(task);
    cwd = sharedPath;
    model = 'opus';

    const channelInfo = Object.entries(metadata.channels)
      .map(([id, ch]) => ch.type === 'slack' ? `#${ch.channel_name || ch.channel_id}` : id)
      .join(', ') || 'CLI (no Slack channel)';
    const context = `
Task: ${taskId}
Status: ${metadata.status}
Channel(s): ${channelInfo}
Task Owner: ${metadata.task_owner || 'Not assigned'}
Participants: ${metadata.participants.join(', ') || 'None yet'}

Your working directory: ${sharedPath}

Files available to read (in your working directory):
- knowledge.log (conversation history and agent findings)
- metadata.json (task metadata)
`;
    systemPrompt = `${systemPrompt}\n\nCurrent Task Context:\n${context}`;

    const pluginMcpServers = await loadPluginMcpServers();

    mcpServers = {
      ...pluginMcpServers,
      'pm-agent-tools': createPMAgentMcpServer(agent, task),
      'research-tools': createResearchMcpServer({
        getTaskId: () => taskId,
        getResearchesDir: () => join(getTaskPath(taskId), 'researches'),
        getCallerAgentId: () => 'pm-agent',
        checkResearchBudget: () => task.checkResearchBudget(),
        incrementResearchCount: () => task.incrementResearchCount(),
        onResearchBudgetExceeded: () => task.onResearchBudgetExceeded(),
      }),
    };

    allowedTools = [
      'Skill',
      'Read',
      'Glob',
      'Grep',
      'mcp__research-tools__web_research',
      'mcp__pm-agent-tools__send_message_to_agent',
      'mcp__pm-agent-tools__post_to_slack',
      'mcp__pm-agent-tools__assign_task_owner',
      'mcp__pm-agent-tools__report_completion',
      'mcp__pm-agent-tools__request_edit_mode',
      'mcp__pm-agent-tools__get_agents_status',
      ...Object.keys(pluginMcpServers).map((name) => `mcp__${name}__*`),
    ];
  } else if (def.track === 'repo') {
    // ---- Repo track ----
    const repoInfo = metadata.repositories[def.repo!.repoKey];
    const baseRepoPath = repoInfo?.path || def.repo!.defaultPath;
    const editAllowed = metadata.edit_allowed === true;
    let repoPath: string;

    if (editAllowed) {
      if (repoInfo?.worktree_path && (await worktreeExists(repoInfo.worktree_path))) {
        repoPath = repoInfo.worktree_path;
        logger.agent(def.id, `Reusing existing worktree at ${repoPath}`, { editMode: true });
        const baseBranch = repoInfo.base_branch || def.repo!.baseBranch || 'main';
        await fetchOrigin(repoPath, baseBranch);
      } else {
        startFreshSession = true;
        const reposPath = getReposPath(taskId);
        const { worktree_path, feature_branch, base_branch } = await setupWorktree(
          taskId,
          def.repo!.repoKey,
          reposPath,
          baseRepoPath,
          def.repo!.baseBranch,
        );
        metadata.repositories[def.repo!.repoKey] = {
          ...repoInfo,
          path: baseRepoPath,
          worktree_path,
          feature_branch,
          base_branch,
        };
        repoPath = worktree_path;
      }
    } else {
      repoPath = baseRepoPath;
    }

    systemPrompt = await generateRepoAgentPrompt(agent);
    const context = `
Task: ${taskId}
Repository: ${repoPath}
Shared folder: ${sharedPath}

Live task files (these update as work progresses):
- ${sharedPath}/knowledge.log (conversation history and agent findings)
- ${sharedPath}/metadata.json (task metadata - PM agent only)

IMPORTANT: The knowledge.log file is continuously updated by other agents and user messages.
Read it ONCE when you receive a new message, then proceed with your work. Don't poll it repeatedly.
`;
    systemPrompt = `${systemPrompt}\n\nCurrent Context:\n${context}`;

    cwd = repoPath;
    additionalDirectories = [repoPath, sharedPath];
    model = 'sonnet';

    mcpServers = {
      'repo-agent-tools': createBaseAgentMcpServer(agent, task),
      ...(editAllowed ? { 'pr-tools': createRepoPRMcpServer(agent, task) } : {}),
      'research-tools': createResearchMcpServer({
        getTaskId: () => taskId,
        getResearchesDir: () => join(getTaskPath(taskId), 'researches'),
        getCallerAgentId: () => def.id,
        checkResearchBudget: () => task.checkResearchBudget(),
        incrementResearchCount: () => task.incrementResearchCount(),
        onResearchBudgetExceeded: () => task.onResearchBudgetExceeded(),
      }),
    };

    allowedTools = [
      'mcp__repo-agent-tools__send_message_to_agent',
      'mcp__repo-agent-tools__log_finding',
      'mcp__research-tools__web_research',
      'Read',
      'Glob',
      'Grep',
      ...(editAllowed
        ? [
            'Write',
            'Edit',
            'Bash(git add:*)',
            'Bash(git rm:*)',
            'Bash(git commit:*)',
            'Bash(git status:*)',
            'Bash(git diff:*)',
            'Bash(git log:*)',
            'Bash(git merge:*)',
            'Bash(git restore:*)',
            'mcp__pr-tools__push_branch',
            'mcp__pr-tools__create_pull_request',
            'mcp__pr-tools__get_pr_status',
            'mcp__pr-tools__get_pr_reviews',
            'mcp__pr-tools__update_pr',
            'mcp__pr-tools__add_pr_comment',
            'mcp__pr-tools__add_review_comment',
            'mcp__pr-tools__resolve_review_thread',
            'mcp__pr-tools__request_re_review',
            'mcp__pr-tools__merge_pull_request',
            'mcp__pr-tools__close_pull_request',
          ]
        : []),
    ];
  } else {
    // ---- Plugin track ----
    const agentWorkspace = await setupAgentWorkspace(taskId, agent);

    systemPrompt = await generatePluginAgentPrompt(agent);
    const context = `
Task: ${taskId}
Plugin: ${def.pluginName}
Shared folder: ${sharedPath}

Live task files (these update as work progresses):
- ${sharedPath}/knowledge.log (conversation history and agent findings)
- ${sharedPath}/metadata.json (task metadata - PM agent only)

IMPORTANT: The knowledge.log file is continuously updated by other agents and user messages.
Read it ONCE when you receive a new message, then proceed with your work. Don't poll it repeatedly.
`;
    systemPrompt = `${systemPrompt}\n\nCurrent Context:\n${context}`;

    cwd = agentWorkspace;
    additionalDirectories = [agentWorkspace, sharedPath];
    model = (def.model || 'sonnet') as string;

    mcpServers = {
      'repo-agent-tools': createBaseAgentMcpServer(agent, task),
      'research-tools': createResearchMcpServer({
        getTaskId: () => taskId,
        getResearchesDir: () => join(getTaskPath(taskId), 'researches'),
        getCallerAgentId: () => def.id,
        checkResearchBudget: () => task.checkResearchBudget(),
        incrementResearchCount: () => task.incrementResearchCount(),
        onResearchBudgetExceeded: () => task.onResearchBudgetExceeded(),
      }),
    };

    allowedTools = [
      'mcp__repo-agent-tools__send_message_to_agent',
      'mcp__repo-agent-tools__log_finding',
      'mcp__research-tools__web_research',
      'Read',
      'Glob',
      'Grep',
      'Skill',
    ];
  }

  // ---- Build query options (session ID may change on retry) ----

  const buildQueryOptions = (sessionId?: string) => ({
    model: model as any,
    betas: ['context-1m-2025-08-07'] as any,
    systemPrompt,
    cwd,
    ...(additionalDirectories ? { additionalDirectories: additionalDirectories as any } : {}),
    executable: 'node' as const,
    pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude',
    settingSources: ['project'] as any,
    env: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      PATH: process.env.PATH,
    },
    resume: sessionId,
    maxTurns: 100,
    permissionMode: 'dontAsk' as const,
    hooks: {
      PostToolUse: [
        createResearchPostToolHook({
          getSharedDir: () => getSharedPath(taskId),
          getTaskId: () => taskId,
          getAgentId: () => def.id,
        }),
        createResearchDefenseTagHook(),
      ],
      Stop: [{
        hooks: [async () => {
          task.updateAgentState(def.id, false);
          return { continue: true };
        }],
      }],
    },
    mcpServers,
    allowedTools,
  });

  // ---- Session recovery (try → reset → retry → give up) ----

  const existingSessionId = startFreshSession ? undefined : agent.session.session_id;
  const recoverable = createRecoverableInputGenerator(agent.queue);

  const handle = {
    running: Promise.resolve() as Promise<void>,
    isRunning: true,
  };

  handle.running = (async () => {
    let sessionId = existingSessionId;
    let hasRetried = false;

    try {
      while (true) {
        try {
          const agentQuery = query({
            prompt: recoverable.generator() as any,
            options: buildQueryOptions(sessionId),
          });

          for await (const event of agentQuery) {
            if (event.type === 'system' && event.subtype === 'init') {
              task.updateAgentState(def.id, true, event.session_id);
            }
            processAgentEventForLogging(
              event,
              def.id,
              additionalDirectories || [cwd],
              def.track === 'repo' && metadata.edit_allowed === true,
            );
          }

          return;
        } catch (error) {
          if (sessionId && !hasRetried) {
            logger.warn(def.id, `Agent failed with session ${sessionId}, retrying fresh`);
            try {
              recoverable.reset();
            } catch {
              // Queue was stopped (task completed/stopped) — bail out
              return;
            }
            // Clear bad session from both agent and metadata so nuclear recovery
            // doesn't reload and retry it after a stop/restart cycle
            agent.session.session_id = undefined;
            task.metadata.agent_sessions[def.id] = { active: false };
            sessionId = undefined;
            hasRetried = true;
            continue;
          }

          if (!agent.queue.isStopped()) {
            logger.error(def.id, 'Error', error);
          }
          return;
        }
      }
    } finally {
      handle.isRunning = false;
    }
  })();

  agent.handle = handle;
}
