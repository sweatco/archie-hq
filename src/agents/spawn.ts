/**
 * Unified Agent Spawner
 *
 * Single spawnAgent(agent, task) function replaces three separate spawners
 * (pm.ts, repo-agent.ts, plugin-agent.ts). One agent model: a plain plugin
 * agent gains repo access when it has `repo` attached, and the PM coordinator
 * is the one agent with `isPm`. Branches on those capabilities for model, CWD,
 * prompt, tools, edit mode, and skills.
 *
 * Session recovery pattern (try with session → reset → retry → give up) written once.
 */

import { join } from 'path';
import { mkdir, symlink, readdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent } from './agent.js';
import type { Task } from '../tasks/task.js';
import { isRepoAgent, isPmAgent } from '../types/agent.js';
import {
  createBaseAgentMcpServer,
  createRepoToolsMcpServer,
  createPmCommsMcpServer,
  createPmOrchestrationMcpServer,
  createPmSchedulingMcpServer,
} from './tools.js';
import { hydrateBranchState } from '../connectors/github/branch-state.js';
import { createResearchMcpServer, createResearchPostToolHook, createResearchDefenseTagHook } from '../mcp/research-tools.js';
import { buildPeerListForSender } from './registry.js';
import {
  getSharedPath,
  getTaskPath,
  getReposPath,
} from '../tasks/persistence.js';
import { WORKDIR, getPluginsHeadInfo } from '../system/workdir.js';
import {
  createRecoverableInputGenerator,
} from './message-queue.js';
import { setupSharedClone, cloneExists, isWorktree, migrateWorktreeToClone, type CloneCheckout } from '../connectors/github/repo-clone.js';
import { configureGitIdentity } from '../connectors/github/client.js';
import { loadPrompt } from '../utils/prompt-loader.js';
import { processAgentEventForLogging, logger } from '../system/logger.js';
import { buildSandboxConfig, createFilesystemGuardHooks, type SandboxOptions } from './sandbox.js';
import { applyOAuthBindings } from '../system/oauth/inject.js';

// ---- Prompt generation (per agent kind) ----

async function generatePMPrompt(task: Task): Promise<string> {
  const pmDef = task.team.find(isPmAgent);
  return loadPrompt('pm-agent', {
    TEAM_LIST: pmDef?.pmConfig?.teamList ?? '',
    TEAM_EXPERTISE: pmDef?.pmConfig?.teamExpertise ?? '',
  });
}

async function generateRepoAgentPrompt(agent: Agent): Promise<string> {
  const def = agent.def;
  const peerList = buildPeerListForSender(def);

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
  const peerList = buildPeerListForSender(def);

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

  // Symlink skills — plugin skills first (so plugins can shadow core skills by name),
  // then archie-hq built-in skills fill in the rest. coreSkillsPath is only set on the PM.
  const skillSources = [agent.def.skillsPath, agent.def.coreSkillsPath].filter(
    (p): p is string => !!p && existsSync(p)
  );
  if (skillSources.length > 0) {
    const agentSkillsDir = join(claudeDir, 'skills');

    for (const skillsPath of skillSources) {
      for (const skillEntry of await readdir(skillsPath, { withFileTypes: true })) {
        if (!skillEntry.isDirectory()) continue;
        const target = join(agentSkillsDir, skillEntry.name);
        if (!existsSync(target)) {
          await mkdir(agentSkillsDir, { recursive: true });
          await symlink(join(skillsPath, skillEntry.name), target);
        }
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

// ---- Repo clone setup ----

interface RepoCloneSetup {
  /** Path to the task-local shared clone the agent works in */
  repoPath: string;
  /** Whether the agent may write/push (edit mode) */
  editAllowed: boolean;
  /** Path to the base repo's .git/objects (shared, read-only) */
  baseObjectsPath: string;
  /** Branch the clone is currently checked out on */
  currentBranch: string;
}

/**
 * Ensure a task-local shared clone exists for the agent's repo, migrating any
 * legacy worktree and hydrating branch state. Mutates the task's repo metadata
 * by reference. Returns the paths/flags the spawner needs to build its config.
 */
async function prepareRepoClone(agent: Agent, task: Task): Promise<RepoCloneSetup> {
  const { def } = agent;
  const taskId = task.taskId;
  const metadata = task.metadata;

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

  return {
    repoPath,
    editAllowed,
    baseObjectsPath,
    currentBranch: repoInfo.current_branch || baseBranch,
  };
}

// ---- Main spawner ----

/**
 * Spawn an agent. Branches on the agent's capabilities (PM coordinator vs. repo
 * access vs. plain plugin) for all behavior. Sets agent.handle on success.
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

  // ---- Shared scaffolding (all agents) ----
  //
  // Every agent gets a workspace, the same research-tools server, the same base
  // tool set, and the same base filesystem boundaries. Repo access and the PM
  // coordinator role are layered on top of this.

  const workspace = await setupAgentWorkspace(taskId, agent);
  const cwd = workspace;
  const model = def.model || (isPmAgent(def) ? 'opus' : 'sonnet');
  const tools = def.tools;
  const baseDisallowedTools = ['WebSearch', 'WebFetch', ...(def.disallowedTools || [])];

  const pluginPaths = def.pluginPath ? [def.pluginPath] : [];
  const pluginReadPaths = [...pluginPaths, ...(def.pluginDataPath ? [def.pluginDataPath] : [])];
  const claudeReadDirs = useClaudeDirs ? [claudeConfigDir, claudeTmpDir] : [];
  const claudeWriteDirs = useClaudeDirs ? [claudeTmpDir] : [];
  const protectedWorkspaceFiles = [
    join(workspace, '.claude', 'settings.json'),
    join(workspace, '.claude', 'skills'),
    join(workspace, '.claude', 'hooks'),
    join(workspace, 'CLAUDE.md'),
  ];

  const researchServer = createResearchMcpServer({
    getTaskId: () => taskId,
    getResearchesDir: () => join(getTaskPath(taskId), 'researches'),
    getCallerAgentId: () => def.id,
    checkResearchBudget: () => task.checkResearchBudget(),
    incrementResearchCount: () => task.incrementResearchCount(),
    onResearchBudgetExceeded: () => task.onResearchBudgetExceeded(),
  });

  // ---- Per-agent config ----
  //
  // Defaults describe the plain plugin agent. The PM coordinator and repo
  // agents deviate from these in their branches below; anything they don't
  // touch keeps the default.

  let systemPrompt: string;
  let additionalDirectories: string[] = [sharedPath, ...pluginPaths];
  let disallowedTools: string[] = baseDisallowedTools;
  let sandboxOpts: SandboxOptions = {
    cwd,
    denyReadPaths: [WORKDIR],
    allowReadPaths: [workspace, sharedPath, ...claudeReadDirs, ...pluginReadPaths],
    allowWritePaths: [workspace, ...claudeWriteDirs],
    denyWritePaths: [sharedPath, ...pluginPaths, ...protectedWorkspaceFiles],
    allowedNetworkDomains: def.allowedNetworkDomains,
  };
  // Common to all agents; each branch adds its own agent-tools server.
  const mcpServers: Record<string, any> = {
    ...(def.mcpServers || {}),
    'research-tools': researchServer,
  };

  if (isPmAgent(def)) {
    // ---- PM coordinator ----
    systemPrompt = await generatePMPrompt(task);

    const channelEntries = Object.entries(metadata.channels);
    const renderChannel = (id: string, ch: typeof metadata.channels[string]): string => {
      if (ch.type === 'slack') {
        const name = ch.channel_name || ch.channel_id;
        return name.startsWith('DM with ') ? name : `#${name}`;
      }
      if (ch.type === 'cli') return 'CLI session';
      if (ch.type === 'github') return `PR ${ch.repo}#${ch.pr_number}`;
      return id;
    };
    const contextLines = [
      `Task: ${taskId}`,
      `Status: ${metadata.status}`,
    ];
    if (channelEntries.length === 0) {
      contextLines.push(
        'Channel(s): none — to reply you must first open a destination via ' +
        'post_to_user(target.new_dm <userId>) or post_to_user(target.new_thread <channelId>)'
      );
    } else {
      contextLines.push(`Channel(s): ${channelEntries.map(([id, ch]) => renderChannel(id, ch)).join(', ')}`);
      if (metadata.default_channel && metadata.channels[metadata.default_channel]) {
        contextLines.push(`Default channel: ${renderChannel(metadata.default_channel, metadata.channels[metadata.default_channel])}`);
      }
    }
    contextLines.push(
      `Task Owner: ${metadata.task_owner || 'Not assigned'}`,
      `Participants: ${metadata.participants.join(', ') || 'None yet'}`,
    );
    if (metadata.reminder) {
      contextLines.push(`Reminder: ${metadata.reminder.trigger_at} — ${metadata.reminder.reason}`);
    }
    // Surface the live plugins-repo version so the PM can tell users when the
    // plugins/agents were last updated. Refreshed on every task start/load.
    const pluginsHead = await getPluginsHeadInfo();
    if (pluginsHead) {
      contextLines.push(
        `Plugins repo last updated: ${pluginsHead.committedAt} (commit ${pluginsHead.shortSha}` +
        `${pluginsHead.subject ? ` "${pluginsHead.subject}"` : ''})`
      );
    }
    const inSharedChannel = Object.values(metadata.channels).some(
      (ch) => ch.type === 'slack' && ch.isShared === true,
    );
    const context = `
${contextLines.join('\n')}

Working directory (cwd): ${workspace} [READ-WRITE]

Shared folder: ${sharedPath} [READ-ONLY]
  - knowledge.log — conversation history and agent findings
  - metadata.json — task metadata
`;
    systemPrompt = `${systemPrompt}\n\nCurrent Task Context:\n${context}`;
    if (inSharedChannel) {
      systemPrompt = `${systemPrompt}\n\nNOTE: This task is active in a Slack channel shared with an external organisation. Messages from external participants are filtered before they reach you. Be mindful that anything you post will be visible to the external org. Do not share repository contents, credentials, internal URLs, or task history with external parties.`;
    }

    // Append PM overlay prompt from the pm plugin (business context, etc.)
    if (def.pmOverlayPrompt) {
      systemPrompt = `${systemPrompt}\n\n${def.pmOverlayPrompt}`;
    }

    mcpServers['agent-tools'] = createBaseAgentMcpServer(agent, task);
    mcpServers['pm-comms'] = createPmCommsMcpServer(agent, task);
    mcpServers['pm-orchestration'] = createPmOrchestrationMcpServer(agent, task);
    mcpServers['pm-scheduling'] = createPmSchedulingMcpServer(agent, task);
  } else if (isRepoAgent(def)) {
    // ---- Repo access attached ----
    const { repoPath, editAllowed, baseObjectsPath, currentBranch } = await prepareRepoClone(agent, task);

    systemPrompt = await generateRepoAgentPrompt(agent);
    const repoMode = editAllowed ? 'READ-WRITE' : 'READ-ONLY';
    const context = `
Task: ${taskId}

Working directory (cwd): ${workspace} [READ-WRITE]

Repository: ${repoPath} [${repoMode}]
  - Current branch: ${currentBranch}

Shared folder: ${sharedPath} [READ-ONLY]
  - knowledge.log — conversation history and agent findings (read ONCE per message, don't poll)
  - metadata.json — task metadata
`;
    systemPrompt = `${systemPrompt}\n\nCurrent Context:\n${context}`;

    additionalDirectories = [repoPath, ...additionalDirectories];

    mcpServers['agent-tools'] = createBaseAgentMcpServer(agent, task);
    mcpServers['repo-tools'] = createRepoToolsMcpServer(agent, task);

    disallowedTools = [
      ...baseDisallowedTools,
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
    ];

    // Repo agents extend the base sandbox with the clone (RW in edit mode) and
    // a few repo-specific read-only/protected paths.
    const readOnlyPaths = [sharedPath, baseObjectsPath, ...pluginReadPaths];
    sandboxOpts = {
      cwd,
      denyReadPaths: [WORKDIR],
      allowReadPaths: [workspace, repoPath, ...claudeReadDirs, ...readOnlyPaths],
      allowWritePaths: editAllowed
        ? [workspace, repoPath, ...claudeWriteDirs]
        : [workspace, ...claudeWriteDirs],
      denyWritePaths: editAllowed
        ? [...readOnlyPaths, ...protectedWorkspaceFiles, join(repoPath, '.git', 'HEAD')]
        : [repoPath, ...readOnlyPaths],
      allowedNetworkDomains: def.allowedNetworkDomains,
    };
  } else {
    // ---- Plain plugin agent ----
    systemPrompt = await generatePluginAgentPrompt(agent);
    const context = `
Task: ${taskId}
Plugin: ${def.pluginName}

Working directory (cwd): ${workspace} [READ-WRITE]

Shared folder: ${sharedPath} [READ-ONLY]
  - knowledge.log — conversation history and agent findings (read ONCE per message, don't poll)
  - metadata.json — task metadata
`;
    systemPrompt = `${systemPrompt}\n\nCurrent Context:\n${context}`;

    mcpServers['agent-tools'] = createBaseAgentMcpServer(agent, task);
  }

  // Expose the sandbox config on the agent so in-process tools (e.g.
  // `share_artifact`, `post_to_user` artifact_paths) can validate paths against
  // the same boundaries the OS sandbox + filesystem-guard hooks enforce.
  agent.sandbox = sandboxOpts;

  // Inject OAuth Bearer tokens into any HTTP/SSE MCP servers that have
  // a vault record. Drops entries whose tokens can't be refreshed.
  await applyOAuthBindings(mcpServers);

  // ---- Build query options (session ID may change on retry) ----

  const buildQueryOptions = (sessionId?: string) => ({
    model: model as any,
    systemPrompt,
    cwd,
    additionalDirectories: additionalDirectories as any,
    executable: 'node' as const,
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
      ...(def.pluginPath ? { CLAUDE_PLUGIN_ROOT: def.pluginPath } : {}),
      ...(def.pluginDataPath ? { CLAUDE_PLUGIN_DATA: def.pluginDataPath } : {}),
    },
    resume: sessionId,
    maxTurns: def.maxTurns ?? 100,
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
              additionalDirectories,
              isRepoAgent(def) && metadata.edit_allowed === true,
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
