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
import { WORKDIR } from '../system/workdir.js';
import {
  createRecoverableInputGenerator,
} from './message-queue.js';
import { setupSharedClone, cloneExists, isWorktree, migrateWorktreeToClone, type CloneCheckout } from '../connectors/github/repo-clone.js';
import { configureGitIdentity } from '../connectors/github/client.js';
import { loadPrompt } from '../utils/prompt-loader.js';
import { processAgentEventForLogging, logger } from '../system/logger.js';
import { buildSandboxConfig, createFilesystemGuardHooks, type SandboxOptions } from './sandbox.js';

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

  // Mark active before any heavy work (clone setup, MCP init) to prevent
  // false idle detection — recovery fires at 3s, MCP connections can take longer
  task.updateAgentState(def.id, true);

  // ---- SDK config/tmp dirs (agent reads tool-results from here) ----
  // Only create for new tasks. Old tasks recovering won't have <taskId>/claude/
  // on disk — skip to avoid breaking their sandbox config during transition.

  const claudeBaseDir = join(getTaskPath(taskId), 'claude', def.key);
  const claudeConfigDir = join(claudeBaseDir, 'session');
  const claudeTmpDir = join(claudeBaseDir, 'tmp');
  const hasClaudeDirs = existsSync(claudeBaseDir);
  if (!agent.session.session_id) {
    // Fresh spawn — create dirs
    await mkdir(claudeConfigDir, { recursive: true });
    await mkdir(claudeTmpDir, { recursive: true });
  }
  const useClaudeDirs = hasClaudeDirs || !agent.session.session_id;

  // ---- Build track-specific config ----

  let systemPrompt: string;
  let cwd: string;
  let additionalDirectories: string[] | undefined;
  let mcpServers: Record<string, any>;
  let disallowedTools: string[] | undefined;
  let tools: string[] | undefined;
  let sandboxOpts: SandboxOptions;
  let model: string;

  if (def.track === 'pm') {
    // ---- PM track ----
    const pmWorkspace = await setupAgentWorkspace(taskId, agent);
    systemPrompt = await generatePMPrompt(task);
    model = (def.model || 'opus') as string;
    cwd = pmWorkspace;
    additionalDirectories = [sharedPath];
    if (def.pluginPath) {
      additionalDirectories.push(def.pluginPath);
    }

    const channelInfo = Object.entries(metadata.channels)
      .map(([id, ch]) => ch.type === 'slack' ? `#${ch.channel_name || ch.channel_id}` : id)
      .join(', ') || 'CLI (no Slack channel)';
    const contextLines = [
      `Task: ${taskId}`,
      `Status: ${metadata.status}`,
      `Channel(s): ${channelInfo}`,
      `Task Owner: ${metadata.task_owner || 'Not assigned'}`,
      `Participants: ${metadata.participants.join(', ') || 'None yet'}`,
    ];
    if (metadata.reminder) {
      contextLines.push(`Reminder: ${metadata.reminder.trigger_at} — ${metadata.reminder.reason}`);
    }
    const context = `
${contextLines.join('\n')}

Working directory (cwd): ${pmWorkspace} [READ-WRITE]

Shared folder: ${sharedPath} [READ-ONLY]
  - knowledge.log — conversation history and agent findings
  - metadata.json — task metadata
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

    tools = def.tools;
    disallowedTools = [
      'WebSearch', 'WebFetch',
      ...(def.disallowedTools || []),
    ];
    sandboxOpts = {
      cwd: pmWorkspace,
      denyReadPaths: [WORKDIR],
      allowReadPaths: [
        pmWorkspace, sharedPath, ...(useClaudeDirs ? [claudeConfigDir, claudeTmpDir] : []),
        ...(def.pluginPath ? [def.pluginPath] : []),
        ...(def.pluginDataPath ? [def.pluginDataPath] : []),
      ],
      allowWritePaths: [pmWorkspace, ...(useClaudeDirs ? [claudeTmpDir] : [])],
      denyWritePaths: [
        sharedPath,
        ...(def.pluginPath ? [def.pluginPath] : []),
        join(pmWorkspace, '.claude', 'settings.json'),
        join(pmWorkspace, '.claude', 'skills'),
        join(pmWorkspace, '.claude', 'hooks'),
        join(pmWorkspace, 'CLAUDE.md'),
      ],
    };
  } else if (def.track === 'repo') {
    // ---- Repo track ----
    const repoWorkspace = await setupAgentWorkspace(taskId, agent);
    const repoInfo = metadata.repositories[def.repo!.repoKey];
    const baseRepoPath = repoInfo?.path || def.repo!.defaultPath;
    const editAllowed = metadata.edit_allowed === true;
    const baseBranch = repoInfo?.base_branch || def.repo!.baseBranch || 'main';
    const baseObjectsPath = join(baseRepoPath, '.git', 'objects');

    // CWD: always a shared clone at task-local path
    const taskRepoPath = join(getReposPath(taskId), def.repo!.repoKey);
    let repoPath: string;

    // Step A: Migrate legacy worktree → shared clone if needed
    if (await isWorktree(taskRepoPath)) {
      logger.agent(def.id, `Migrating worktree to shared clone`);
      await migrateWorktreeToClone(
        def.repo!.repoKey, getReposPath(taskId), baseRepoPath,
        baseBranch, def.repo!.githubRepo, repoInfo, editAllowed,
      );
    }

    // Step B: Reuse existing clone or create new one
    if (await cloneExists(taskRepoPath)) {
      repoPath = taskRepoPath;
      logger.agent(def.id, `Reusing existing clone at ${repoPath}`, { editMode: editAllowed });
    } else {
      const previousBranch = repoInfo?.current_branch;
      const wasOnBaseBranch = !previousBranch || previousBranch === baseBranch;

      let checkout: CloneCheckout;
      if (editAllowed && wasOnBaseBranch) {
        // RW mode, was on base branch (or no branch) — create feature branch for new work
        checkout = { type: 'new_branch', name: `feature/${taskId}` };
      } else if (editAllowed && !wasOnBaseBranch) {
        // RW but was on a specific branch — restore it
        checkout = { type: 'branch', name: previousBranch! };
      } else {
        // RO default: clone on base branch
        checkout = { type: 'base' };
      }

      const result = await setupSharedClone(
        def.repo!.repoKey, getReposPath(taskId), baseRepoPath,
        checkout, baseBranch, def.repo!.githubRepo,
      );
      repoPath = result.clone_path;

      if (result.branch !== result.base_branch) {
        hydrateBranchState(repoInfo, result.branch, result.base_branch);
      } else {
        repoInfo.current_branch = result.branch;
      }
      logger.agent(def.id, `Created shared clone at ${repoPath} (${result.branch})`, { editMode: editAllowed });
    }

    // Configure git identity for the clone
    await configureGitIdentity(repoPath);

    // Update metadata
    repoInfo.clone_path = repoPath;
    metadata.repositories[def.repo!.repoKey] = { ...repoInfo, path: baseRepoPath };

    // Legacy hydration: old tasks with feature_branch but no branch_states
    if (repoInfo.feature_branch && !repoInfo.branch_states) {
      hydrateBranchState(repoInfo, repoInfo.feature_branch, repoInfo.base_branch);
      const state = repoInfo.branch_states![repoInfo.feature_branch];
      state.pr_number = repoInfo.pr_number;
      state.last_processed_comment_id = repoInfo.last_processed_comment_id;
    }

    systemPrompt = await generateRepoAgentPrompt(agent);
    const currentBranch = repoInfo.current_branch || baseBranch;
    const repoMode = editAllowed ? 'READ-WRITE' : 'READ-ONLY';
    const context = `
Task: ${taskId}

Working directory (cwd): ${repoWorkspace} [READ-WRITE]

Repository: ${repoPath} [${repoMode}]
  - Current branch: ${currentBranch}

Shared folder: ${sharedPath} [READ-ONLY]
  - knowledge.log — conversation history and agent findings (read ONCE per message, don't poll)
  - metadata.json — task metadata
`;
    systemPrompt = `${systemPrompt}\n\nCurrent Context:\n${context}`;

    cwd = repoWorkspace;
    model = (def.model || 'sonnet') as string;
    additionalDirectories = [repoPath, sharedPath];
    if (def.pluginPath) {
      additionalDirectories.push(def.pluginPath);
    }

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

    const denyWriteProtected = [
      // Protect SDK config in cwd (agent workspace)
      join(repoWorkspace, '.claude', 'settings.json'),
      join(repoWorkspace, '.claude', 'skills'),
      join(repoWorkspace, '.claude', 'hooks'),
      join(repoWorkspace, 'CLAUDE.md'),
      // Prevent agent from switching branches (git checkout/switch writes .git/HEAD)
      join(repoPath, '.git', 'HEAD'),
    ];

    tools = def.tools;
    disallowedTools = [
      'WebSearch', 'WebFetch',
      ...(editAllowed
        ? []
        : [
            // RO mode: block write MCP operations (Write/Edit enforced by sandbox hooks)
            'mcp__repo-tools__push_branch',
            'mcp__repo-tools__create_pull_request',
            'mcp__repo-tools__update_pr',
            'mcp__repo-tools__add_pr_comment',
            'mcp__repo-tools__add_review_comment',
            'mcp__repo-tools__reply_to_review_comment',
            'mcp__repo-tools__resolve_review_thread',
            'mcp__repo-tools__request_re_review',
            'mcp__repo-tools__merge_pull_request',
            'mcp__repo-tools__close_pull_request',
            'mcp__repo-tools__create_branch',
          ]),
      ...(def.disallowedTools || []),
    ];
    const readOnlyPaths = [
      sharedPath, baseObjectsPath,
      ...(def.pluginPath ? [def.pluginPath] : []),
      ...(def.pluginDataPath ? [def.pluginDataPath] : []),
    ];

    if (editAllowed) {
      sandboxOpts = {
        cwd,
        denyReadPaths: [WORKDIR],
        allowReadPaths: [repoWorkspace, repoPath, ...(useClaudeDirs ? [claudeConfigDir, claudeTmpDir] : []), ...readOnlyPaths],
        allowWritePaths: [repoWorkspace, repoPath, ...(useClaudeDirs ? [claudeTmpDir] : [])],
        denyWritePaths: [...readOnlyPaths, ...denyWriteProtected],
      };
    } else {
      sandboxOpts = {
        cwd,
        denyReadPaths: [WORKDIR],
        allowReadPaths: [repoWorkspace, repoPath, ...(useClaudeDirs ? [claudeConfigDir, claudeTmpDir] : []), ...readOnlyPaths],
        allowWritePaths: [repoWorkspace, ...(useClaudeDirs ? [claudeTmpDir] : [])],
        denyWritePaths: [repoPath, ...readOnlyPaths],
      };
    }
  } else {
    // ---- Plugin track ----
    const agentWorkspace = await setupAgentWorkspace(taskId, agent);

    systemPrompt = await generatePluginAgentPrompt(agent);
    const context = `
Task: ${taskId}
Plugin: ${def.pluginName}

Working directory (cwd): ${agentWorkspace} [READ-WRITE]

Shared folder: ${sharedPath} [READ-ONLY]
  - knowledge.log — conversation history and agent findings (read ONCE per message, don't poll)
  - metadata.json — task metadata
`;
    systemPrompt = `${systemPrompt}\n\nCurrent Context:\n${context}`;

    cwd = agentWorkspace;
    additionalDirectories = [sharedPath];
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

    tools = def.tools;
    disallowedTools = [
      'WebSearch', 'WebFetch',
      ...(def.disallowedTools || []),
    ];
    sandboxOpts = {
      cwd: agentWorkspace,
      denyReadPaths: [WORKDIR],
      allowReadPaths: [
        agentWorkspace, sharedPath, ...(useClaudeDirs ? [claudeConfigDir, claudeTmpDir] : []),
        ...(def.pluginPath ? [def.pluginPath] : []),
        ...(def.pluginDataPath ? [def.pluginDataPath] : []),
      ],
      allowWritePaths: [agentWorkspace, ...(useClaudeDirs ? [claudeTmpDir] : [])],
      denyWritePaths: [
        sharedPath,
        ...(def.pluginPath ? [def.pluginPath] : []),
        join(agentWorkspace, '.claude', 'settings.json'),
        join(agentWorkspace, '.claude', 'skills'),
        join(agentWorkspace, '.claude', 'hooks'),
        join(agentWorkspace, 'CLAUDE.md'),
      ],
    };
  }

  // ---- Build query options (session ID may change on retry) ----

  const buildQueryOptions = (sessionId?: string) => ({
    model: model as any,
    systemPrompt,
    cwd,
    ...(additionalDirectories ? { additionalDirectories: additionalDirectories as any } : {}),
    executable: 'node' as const,
    // pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude',
    settingSources: ['project'] as any,
    env: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      PATH: process.env.PATH,
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      ...(useClaudeDirs ? {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CLAUDE_CODE_TMPDIR: claudeTmpDir,
      } : {}),
    },
    resume: sessionId,
    maxTurns: def.maxTurns ?? 100,
    // thinking: { type: 'adaptive' } as const,
    ...(def.effort ? { effort: def.effort } : {}),
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    sandbox: buildSandboxConfig(sandboxOpts),
    ...(tools ? { tools } : {}),
    hooks: {
      PreToolUse: createFilesystemGuardHooks(sandboxOpts),
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
    disallowedTools,
    stderr: (data: string) => {
      logger.debug(def.id, `stderr: ${data.trim()}`);
    },
  });

  // ---- Session recovery (try → reset → retry → give up) ----

  const existingSessionId = agent.session.session_id;
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
              logger.agent(def.id, `Model: ${(event as any).model || 'unknown'}`);
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
