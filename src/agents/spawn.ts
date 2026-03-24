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
import { mkdir, symlink, readdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent } from './agent.js';
import type { Task } from '../tasks/task.js';
import {
  createPMAgentMcpServer,
  createBaseAgentMcpServer,
  createRepoToolsMcpServer,
} from './tools.js';
import { hydrateBranchState } from '../connectors/github/branch-state.js';
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
// getRootMcpConfig now used only by registry.ts for resolving agent MCP servers

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

  const claudeDir = join(agentWorkspace, '.claude');
  await mkdir(claudeDir, { recursive: true });

  // Symlink skills from plugin
  if (agent.def.skillsPath && existsSync(agent.def.skillsPath)) {
    const agentSkillsDir = join(claudeDir, 'skills');

    for (const skillEntry of await readdir(agent.def.skillsPath, { withFileTypes: true })) {
      if (!skillEntry.isDirectory()) continue;
      const target = join(agentSkillsDir, skillEntry.name);
      if (!existsSync(target)) {
        await mkdir(agentSkillsDir, { recursive: true });
        await symlink(join(agent.def.skillsPath, skillEntry.name), target);
      }
    }
  }

  // Write .claude/settings.json with plugin hooks (picked up by SDK via settingSources)
  if (agent.def.pluginHooks) {
    const settingsPath = join(claudeDir, 'settings.json');
    const settings = { hooks: agent.def.pluginHooks };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
    logger.agent(agent.def.id, `Mounted plugin hooks to ${settingsPath}`);
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

  // Mark active before any heavy work (worktree setup, MCP init) to prevent
  // false idle detection — recovery fires at 3s, MCP connections can take longer
  task.updateAgentState(def.id, true);

  // ---- Build track-specific config ----

  let systemPrompt: string;
  let cwd: string;
  let additionalDirectories: string[] | undefined;
  let mcpServers: Record<string, any>;
  let allowedTools: string[];
  let disallowedTools: string[] | undefined;
  let model: string;
  let startFreshSession = false;

  if (def.track === 'pm') {
    // ---- PM track ----
    const pmWorkspace = await setupAgentWorkspace(taskId, agent);
    systemPrompt = await generatePMPrompt(task);
    cwd = pmWorkspace;
    additionalDirectories = [pmWorkspace, sharedPath];
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

Shared folder: ${sharedPath}

Files available to read (in shared folder):
- knowledge.log (conversation history and agent findings)
- metadata.json (task metadata)
`;
    systemPrompt = `${systemPrompt}\n\nCurrent Task Context:\n${context}`;

    // Append PM overlay prompt from the pm plugin (business context, etc.)
    if (def.pmOverlayPrompt) {
      systemPrompt = `${systemPrompt}\n\n${def.pmOverlayPrompt}`;
    }

    mcpServers = {
      ...(def.mcpServers || {}),
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
      'mcp__research-tools__*',
      'mcp__pm-agent-tools__*',
      ...(def.tools || []),
    ];
    disallowedTools = [
      'Bash',
      'Edit',
      'Write',
      'WebSearch',
      'WebFetch',
      ...(def.disallowedTools || []),
    ];
  } else if (def.track === 'repo') {
    // ---- Repo track ----
    const repoInfo = metadata.repositories[def.repo!.repoKey];
    const baseRepoPath = repoInfo?.path || def.repo!.defaultPath;
    const editAllowed = metadata.edit_allowed === true;
    const baseBranch = repoInfo?.base_branch || def.repo!.baseBranch || 'main';

    // CWD: always a worktree at task-local path
    const taskRepoPath = join(getReposPath(taskId), def.repo!.repoKey);
    let repoPath: string;

    if (await worktreeExists(taskRepoPath)) {
      // Worktree already set up (resumed task or reactivated after completion)
      repoPath = taskRepoPath;
      logger.agent(def.id, `Reusing existing worktree at ${repoPath}`, { editMode: editAllowed });
      await fetchOrigin(baseRepoPath, baseBranch);
    } else {
      // Create worktree — determine checkout target from previous state + edit mode
      const previousBranch = repoInfo?.current_branch;
      const prevState = previousBranch ? repoInfo?.branch_states?.[previousBranch] : undefined;
      const wasOnBaseBranch = !previousBranch || previousBranch === baseBranch;

      let checkout: import('../connectors/github/worktree.js').WorktreeCheckout;

      if (editAllowed && wasOnBaseBranch) {
        // RW mode, was on base branch (or no branch) — create feature branch for new work
        checkout = { type: 'new_branch', name: `feature/${taskId}` };
      } else if (prevState?.owned) {
        // Had an owned branch — restore it (normal checkout)
        checkout = { type: 'branch', name: previousBranch! };
      } else if (prevState && !wasOnBaseBranch) {
        // Was visiting a non-base existing branch — restore at recorded position
        checkout = { type: 'detached', sha: prevState.head_sha };
      } else {
        // Default: detached HEAD at base branch
        checkout = { type: 'detached' };
      }

      const result = await setupWorktree(
        def.repo!.repoKey, getReposPath(taskId), baseRepoPath, checkout, def.repo!.baseBranch,
      );

      repoInfo.worktree_path = taskRepoPath;
      if (result.feature_branch) {
        hydrateBranchState(repoInfo, result.feature_branch, result.base_branch);
      } else {
        repoInfo.current_branch = previousBranch || baseBranch;
      }
      metadata.repositories[def.repo!.repoKey] = { ...repoInfo, path: baseRepoPath };
      repoPath = taskRepoPath;
      startFreshSession = true;
      logger.agent(def.id, `Created worktree at ${taskRepoPath} (${result.feature_branch || checkout.type})`, { editMode: editAllowed });
    }

    // Legacy hydration: old tasks with feature_branch but no branch_states
    if (repoInfo.feature_branch && !repoInfo.branch_states) {
      hydrateBranchState(repoInfo, repoInfo.feature_branch, repoInfo.base_branch);
      const state = repoInfo.branch_states![repoInfo.feature_branch];
      state.pr_number = repoInfo.pr_number;
      state.last_processed_comment_id = repoInfo.last_processed_comment_id;
    }

    systemPrompt = await generateRepoAgentPrompt(agent);
    const currentBranch = repoInfo.current_branch || baseBranch;
    const context = `
Task: ${taskId}
Repository: ${repoPath}
Current branch: ${currentBranch}
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
      ...(def.mcpServers || {}),
      'repo-agent-tools': createBaseAgentMcpServer(agent, task),
      'repo-tools': createRepoToolsMcpServer(agent, task),
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
      // Git + PR read tools (RO + RW)
      'mcp__repo-tools__fetch',
      'mcp__repo-tools__switch_branch',
      'mcp__repo-tools__list_prs',
      'mcp__repo-tools__get_pr',
      'mcp__repo-tools__get_pr_status',
      'mcp__repo-tools__get_pr_reviews',
      // RO git bash commands (no-space glob to match bare commands like `git log`)
      'Bash(git log*)',
      'Bash(git diff*)',
      'Bash(git show *)',
      'Bash(git blame *)',
      'Bash(git branch -r*)',
      'Bash(git branch --show-current)',
      'Bash(git ls-files*)',
      'Bash(git ls-tree *)',
      'Read',
      'Glob',
      'Grep',
      ...(def.tools || []),
      ...(editAllowed
        ? [
            'Write',
            'Edit',
            'Bash(rm *)',
            'Bash(git add *)',
            'Bash(git rm *)',
            'Bash(git commit *)',
            'Bash(git status*)',
            'Bash(git merge *)',
            'Bash(git restore *)',
            'mcp__repo-tools__push_branch',
            'mcp__repo-tools__create_pull_request',
            'mcp__repo-tools__update_pr',
            'mcp__repo-tools__add_pr_comment',
            'mcp__repo-tools__add_review_comment',
            'mcp__repo-tools__resolve_review_thread',
            'mcp__repo-tools__request_re_review',
            'mcp__repo-tools__merge_pull_request',
            'mcp__repo-tools__close_pull_request',
            'mcp__repo-tools__create_branch',
            'mcp__repo-tools__list_branches',
          ]
        : []),
    ];
    disallowedTools = [
      'WebSearch',
      'WebFetch',
      ...(def.disallowedTools || []),
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
    if (def.pluginPath) {
      additionalDirectories.push(def.pluginPath);
    }
    model = (def.model || 'sonnet') as string;

    mcpServers = {
      ...(def.mcpServers || {}),
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
      ...(def.tools || []),
    ];
    disallowedTools = def.disallowedTools;
  }

  // ---- Build query options (session ID may change on retry) ----

  const buildQueryOptions = (sessionId?: string) => ({
    model: model as any,
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
    disallowedTools,
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
              if (Array.isArray(event.mcp_servers)) {
                for (const mcp of event.mcp_servers) {
                  const status = mcp.status === 'connected' ? 'connected' : `FAILED`;
                  logger.agent(def.id, `MCP ${mcp.name}: ${status}`);
                }
              }
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
