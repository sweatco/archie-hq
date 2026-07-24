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
import { mkdir, symlink, readdir, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent } from './agent.js';
import type { Task } from '../tasks/task.js';
import { isRepoAgent, isPmAgent } from '../types/agent.js';
import { buildCommitAuthorEnv } from './commit-author.js';
import { resolveAgentModel, resolveAgentEffort } from './model-label.js';
import {
  createBaseAgentMcpServer,
  createRepoToolsMcpServer,
  createCommsMcpServer,
  createOrchestrationMcpServer,
  createSchedulingMcpServer,
} from './tools.js';
import { createFileBridgeMcpServer, shouldAttachFileBridge } from './mcp-file-bridge.js';
import { hydrateBranchState } from '../connectors/github/branch-state.js';
import { taskBranchName } from '../connectors/github/branch-naming.js';
import { createResearchMcpServer, createResearchPostToolHook, createResearchDefenseTagHook } from '../mcp/research-tools.js';
import { buildPeerListForSender } from './registry.js';
import {
  getSharedPath,
  getTaskPath,
  getAgentClonePath,
} from '../tasks/persistence.js';
import { WORKDIR, getBaseCachePath, getPluginsHeadInfo } from '../system/workdir.js';
import {
  createRecoverableInputGenerator,
} from './message-queue.js';
import { setupSharedClone, cloneExists, type CloneCheckout } from '../connectors/github/repo-clone.js';
import { configureGitIdentity, getGitHubAppIdentity } from '../connectors/github/client.js';
import { buildChannelCanvasPromptSection } from '../connectors/slack/channel-canvas.js';
import { loadPrompt } from '../utils/prompt-loader.js';
import { processAgentEventForLogging, logger } from '../system/logger.js';
import { emitEvent } from '../system/event-bus.js';
import { getProbeBaseUrl } from '../system/context-probe.js';
import { buildSandboxConfig, createFilesystemGuardHooks, TRUSTED_PACKAGE_REGISTRY_DOMAINS, type SandboxOptions } from './sandbox.js';
import { applyOAuthBindings } from '../system/oauth/inject.js';
import { enrichPromptWithMemory, isMemoryEnabled, isInjectionEnabled } from '../memory/index.js';

// ---- Prompt generation (per agent kind) ----

async function generatePMPrompt(task: Task): Promise<string> {
  const pmDef = task.team.find(isPmAgent);
  return loadPrompt('pm-agent', {
    TEAM_LIST: pmDef?.pmConfig?.teamList ?? '',
    TEAM_EXPERTISE: pmDef?.pmConfig?.teamExpertise ?? '',
    PM_INTEGRATIONS: pmDef?.pmConfig?.pmIntegrations ?? '',
  });
}

async function generateRepoAgentPrompt(agent: Agent, task: Task): Promise<string> {
  const def = agent.def;
  const peerList = buildPeerListForSender(def, task.team);

  const corePrompt = await loadPrompt('agent-core', {
    AGENT_ID: def.id,
    AGENT_ROLE: def.role,
    EXPERTISE: def.expertise,
    PEER_LIST: peerList,
  });

  // Per-repo data — github, base branch, current branch, clone path, mode — is
  // surfaced through the dynamic Current Context block (built per spawn in the
  // repo-agent branch of spawnAgent), not via static template variables here.
  // The repo-agent prompt is generic; instances differ only in what their
  // Current Context lists.
  const repoPrompt = await loadPrompt('repo-agent', {});

  const layers = [corePrompt, repoPrompt];
  if (def.agentPrompt) layers.push(def.agentPrompt);
  return layers.join('\n\n');
}

async function generatePluginAgentPrompt(agent: Agent, task: Task): Promise<string> {
  const def = agent.def;
  const peerList = buildPeerListForSender(def, task.team);

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
        const entryPath = join(skillsPath, skillEntry.name);
        // Mount real skill dirs AND symlinks that resolve to a dir. A skill can
        // be vendored as a git submodule and exposed via a symlink (e.g. the
        // data-analytics data-context); readdir's Dirent.isDirectory() is false
        // for a symlink, so stat-follow to classify it. A dangling link is skipped.
        let isDir = skillEntry.isDirectory();
        if (!isDir && skillEntry.isSymbolicLink()) {
          isDir = await stat(entryPath).then((s) => s.isDirectory()).catch(() => false);
        }
        if (!isDir) continue;
        const target = join(agentSkillsDir, skillEntry.name);
        if (!existsSync(target)) {
          await mkdir(agentSkillsDir, { recursive: true });
          await symlink(entryPath, target);
        }
      }
    }
  }

  // Write .claude/settings.json (picked up by the SDK via settingSources: ['project']).
  //
  // attribution.commit replaces Claude Code's default commit trailer: we swap the
  // harness-default "Co-Authored-By: Claude <model>" line for Archie (the GitHub
  // App bot) so commits credit Archie as co-author, not the model. sessionUrl:false
  // drops the Claude-Session trailer too. When the bot identity isn't configured
  // the empty string simply hides the trailer. Plugin hooks are merged in when set.
  const settingsPath = join(claudeDir, 'settings.json');
  const archie = getGitHubAppIdentity();
  const settings: Record<string, unknown> = {
    attribution: {
      commit: archie ? `Co-Authored-By: ${archie.name} <${archie.email}>` : '',
      sessionUrl: false,
    },
  };
  if (agent.def.pluginHooks) settings.hooks = agent.def.pluginHooks;
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  logger.agent(
    agent.def.id,
    `Wrote agent settings.json (attribution${agent.def.pluginHooks ? ' + plugin hooks' : ''})`,
  );

  return agentWorkspace;
}

// ---- Memory helpers ----

/**
 * Extract Slack user references from a task's knowledge.log.
 * Returns empty array if memory disabled, injection disabled, or log unavailable.
 * The result feeds only prompt injection, so when injection is off we skip the
 * transcript scan and user-file reads entirely.
 */
async function extractTaskUsernames(taskId: string): Promise<import('../memory/types.js').UserRef[]> {
  if (!isMemoryEnabled() || !isInjectionEnabled()) return [];
  try {
    const { readKnowledgeLog } = await import('../tasks/persistence.js');
    const { extractUsernames } = await import('../memory/lifecycle.js');
    const log = await readKnowledgeLog(taskId);
    return extractUsernames(log);
  } catch {
    return [];
  }
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
  // Default non-PM agents to sonnet with the 1M context window. The `[1m]`
  // suffix is how the SDK enables it (it strips the suffix and adds the
  // `context-1m-2025-08-07` beta); plain `sonnet` caps at 200K and overflows
  // on the large injected system prompt. Opus is 1M natively, no suffix needed.
  // (Resolution shared with the footer via resolveAgentModel.)
  // "Max mode": a task-lifetime, human-approved upgrade (see request_max_mode /
  // handleMaxModeApproval). When on, resolveAgentModel/Effort apply the agent's
  // maxMode overrides — repo/dynamic agents default to max effort; a model swap
  // (e.g. Fable) is a per-agent frontmatter opt-in.
  const maxMode = metadata.max_mode === true;
  const model = resolveAgentModel(def, maxMode);
  const effort = resolveAgentEffort(def, maxMode);
  const tools = def.tools;

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
    onResearchBudgetExceeded: () => task.onResearchBudgetExceeded(agent),
  });

  // ---- Per-agent config ----
  //
  // Defaults describe the plain plugin agent. The PM coordinator and repo
  // agents deviate from these in their branches below; anything they don't
  // touch keeps the default.

  let systemPrompt: string;
  let additionalDirectories: string[] = [sharedPath, ...pluginPaths];
  // Cron* are harness tools that only live for the current Claude session — they
  // die when the agent's ephemeral subprocess exits (which is every time a turn
  // ends), so a scheduled job never fires. An agent reaching for them to "monitor"
  // or "check back later" silently gets nothing (observed: task-20260617-1454-i1a08v
  // set a self-re-arming cron that died at turn-end and never woke for 6 days).
  // Block them so agents use the durable `set_reminder` instead. Native recurring
  // triggers are planned separately.
  let disallowedTools: string[] = [
    'WebSearch', 'WebFetch',
    'CronCreate', 'CronList', 'CronDelete',
    ...(def.disallowedTools || []),
  ];
  let sandboxOpts: SandboxOptions = {
    cwd,
    denyReadPaths: [WORKDIR],
    allowReadPaths: [workspace, sharedPath, ...claudeReadDirs, ...pluginReadPaths],
    allowWritePaths: [workspace, ...claudeWriteDirs],
    denyWritePaths: [sharedPath, ...pluginPaths, ...protectedWorkspaceFiles],
    allowedNetworkDomains: def.allowedNetworkDomains,
  };
  // Base servers every agent gets; branches add their own (repo-tools, the PM
  // coordinator servers, etc.) on top.
  const mcpServers: Record<string, any> = {
    ...(def.mcpServers || {}),
    'agent-tools': createBaseAgentMcpServer(agent, task),
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
        'Channel(s): none — there is nowhere to reply in this task; finish with report_completion() (no message).'
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
    if (metadata.triggered_by) {
      contextLines.push(`Spawned by trigger: ${metadata.triggered_by} (this is a fresh, trigger-initiated task — deliver the result as instructed in the first message)`);
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

    // Inject per-channel "Archie" canvas as standing project context (XML-wrapped
    // so it stays contained). Rebuilt every spawn, so canvas edits propagate on
    // the next wake. Only the PM sees it; specialists get relevant slices via
    // delegation.
    const channelCanvasSection = await buildChannelCanvasPromptSection(metadata);
    if (channelCanvasSection) {
      systemPrompt = `${systemPrompt}\n\n${channelCanvasSection}`;
    }

    // Append PM overlay prompt from the pm plugin (business context, etc.)
    if (def.pmOverlayPrompt) {
      systemPrompt = `${systemPrompt}\n\n${def.pmOverlayPrompt}`;
    }

    mcpServers['comms-tools'] = createCommsMcpServer(agent, task);
    mcpServers['orchestration-tools'] = createOrchestrationMcpServer(agent, task);
    mcpServers['scheduling-tools'] = createSchedulingMcpServer(agent, task);
  } else if (isRepoAgent(def)) {
    // ---- Repo access attached ----
    const editAllowed = metadata.edit_allowed === true;
    // Record what edit mode this process is being built under. The sandbox mount
    // and repo-tool allowlist below are frozen from this snapshot, so Agent.spawn
    // can compare it against the live flag to detect (and re-spawn) an agent that
    // booted read-only just as edit mode was approved.
    agent.editModeAtSpawn = editAllowed;

    // Ensure metadata.repositories[agentId] is an array; defaults to [primary]
    // on first spawn so single-repo behaviour matches the pre-v30 world.
    let attached = metadata.repositories[def.id];
    if (!Array.isArray(attached)) {
      attached = [];
      metadata.repositories[def.id] = attached;
    }
    // Eager mount: every repo the agent declares in frontmatter is mounted at
    // spawn. Ensure each declared repo has an attachment record (preserving
    // existing clone/branch state for repos already present — important for
    // recovering an old task after its agent gained a new repo in frontmatter).
    // We iterate the DECLARED list (not the metadata list) so a repo removed
    // from frontmatter is simply no longer mounted; a stale metadata record for
    // it is harmless and left in place.
    for (const entry of def.repo!.repos) {
      if (!attached.some((a) => a.github === entry.github)) {
        attached.push({ github: entry.github });
      }
    }

    // Set up each declared repo: prepare clone, hydrate branch state.
    const repoMounts: Array<{ github: string; clonePath: string; baseObjectsPath: string; currentBranch: string; baseBranch: string }> = [];
    for (const entry of def.repo!.repos) {
      const att = attached.find((a) => a.github === entry.github)!;
      const baseBranch = entry.baseBranch || 'main';
      // Prefer the base path the clone was actually built against — that's
      // what alternates points at. Migrated old tasks carry the legacy base
      // (`$ARCHIE_WORKDIR/repos/<short-key>/`); fresh clones default to the
      // current github-nested layout. Pin it back into metadata so the value
      // stays the single source of truth.
      const baseRepoPath = att.base_path || getBaseCachePath(att.github);
      att.base_path = baseRepoPath;
      const baseObjectsPath = join(baseRepoPath, '.git', 'objects');
      const desiredClonePath = getAgentClonePath(taskId, def.id, att.github);

      let clonePath: string;
      if (att.clone_path && await cloneExists(att.clone_path)) {
        clonePath = att.clone_path;
        logger.agent(def.id, `Reusing existing clone at ${clonePath} (${att.github})`, { editMode: editAllowed });
      } else if (await cloneExists(desiredClonePath)) {
        clonePath = desiredClonePath;
        att.clone_path = clonePath;
        logger.agent(def.id, `Reusing existing clone at ${clonePath} (${att.github})`, { editMode: editAllowed });
      } else {
        const previousBranch = att.current_branch;
        const wasOnBaseBranch = !previousBranch || previousBranch === baseBranch;

        let checkout: CloneCheckout;
        if (editAllowed && wasOnBaseBranch) {
          checkout = { type: 'new_branch', name: taskBranchName(taskId) };
        } else if (editAllowed && previousBranch) {
          checkout = { type: 'branch', name: previousBranch };
        } else {
          checkout = { type: 'base' };
        }

        const result = await setupSharedClone(
          desiredClonePath, baseRepoPath, checkout, baseBranch, att.github,
        );
        clonePath = result.clone_path;
        att.clone_path = clonePath;

        if (result.branch !== result.base_branch) {
          hydrateBranchState(att, result.branch, result.base_branch);
        } else {
          att.current_branch = result.branch;
        }
        logger.agent(def.id, `Created shared clone at ${clonePath} (${att.github} @ ${result.branch})`, { editMode: editAllowed });
      }

      await configureGitIdentity(clonePath);
      repoMounts.push({
        github: att.github,
        clonePath,
        baseObjectsPath,
        currentBranch: att.current_branch || baseBranch,
        baseBranch,
      });
    }

    systemPrompt = await generateRepoAgentPrompt(agent, task);
    const repoMode = editAllowed ? 'READ-WRITE' : 'READ-ONLY';
    const mountLines = repoMounts.map((m) =>
      `  - ${m.github}${m.github === def.repo!.primary ? ' (primary)' : ''}\n` +
      `    path: ${m.clonePath} [${repoMode}]\n` +
      `    branch: ${m.currentBranch} (base: ${m.baseBranch})`
    ).join('\n');
    const context = `
Task: ${taskId}

Working directory (cwd): ${workspace} [READ-WRITE]

Repositories (all mounted; use the github arg on repo-tools to target one, default is your primary):
${mountLines}

Shared folder: ${sharedPath} [READ-ONLY]
  - knowledge.log — conversation history and agent findings (read ONCE per message, don't poll)
  - metadata.json — task metadata
`;
    systemPrompt = `${systemPrompt}\n\nCurrent Context:\n${context}`;

    const allClonePaths = repoMounts.map((m) => m.clonePath);
    additionalDirectories = [...allClonePaths, ...additionalDirectories];
    mcpServers['repo-tools'] = createRepoToolsMcpServer(agent, task);

    disallowedTools = [
      ...disallowedTools,
      ...(editAllowed
        ? []
        : [
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

    // Repo agents extend the base sandbox with every attached clone (RW in edit
    // mode) plus per-repo read-only/protected paths.
    const readOnlyPaths = [sharedPath, ...repoMounts.map((m) => m.baseObjectsPath), ...pluginReadPaths];
    const cloneGitHeads = repoMounts.map((m) => join(m.clonePath, '.git', 'HEAD'));
    sandboxOpts = {
      cwd,
      denyReadPaths: [WORKDIR],
      allowReadPaths: [workspace, ...allClonePaths, ...claudeReadDirs, ...readOnlyPaths],
      allowWritePaths: editAllowed
        ? [workspace, ...allClonePaths, ...claudeWriteDirs]
        : [workspace, ...claudeWriteDirs],
      denyWritePaths: editAllowed
        ? [...readOnlyPaths, ...protectedWorkspaceFiles, ...cloneGitHeads]
        : [...allClonePaths, ...readOnlyPaths],
      // In edit mode, repo build sandboxes may reach the trusted package
      // registries so agents can run installs / regenerate lockfiles. Read-only
      // agents stay fully network-denied. The list is a curated constant — see
      // TRUSTED_PACKAGE_REGISTRY_DOMAINS.
      allowedNetworkDomains: [
        ...(def.allowedNetworkDomains ?? []),
        ...(editAllowed ? TRUSTED_PACKAGE_REGISTRY_DOMAINS : []),
      ],
    };
  } else {
    // ---- Plain plugin agent ----
    systemPrompt = await generatePluginAgentPrompt(agent, task);
  }

  // Plugin agents carry the domain/admin MCP servers that sometimes need a
  // local file's bytes (e.g. uploading an image). Give them the file bridge
  // so they can forward file contents into those calls without routing bytes
  // through the model. Bounded to servers the agent already has.
  if (shouldAttachFileBridge(def)) {
    // The bridge resolves targets from this same live map at call time, so it
    // sees OAuth-bound headers and never reaches servers dropped below.
    mcpServers['file-bridge'] = createFileBridgeMcpServer(agent, task, mcpServers);
  }

  // ---- Organizational memory injection (read path; gated by ARCHIE_MEMORY_INJECT, default off) ----
  const taskTitle = metadata.title ?? undefined;
  const memorySelectors = isPmAgent(def)
    ? { taskTitle }
    : isRepoAgent(def)
      ? { repo: def.repo!.primary, taskTitle }
      : { plugin: def.pluginName, taskTitle };
  const memoryUsernames = await extractTaskUsernames(taskId);
  systemPrompt = await enrichPromptWithMemory(systemPrompt, memoryUsernames, memorySelectors);

  // Expose the sandbox config on the agent so in-process tools (e.g.
  // `share_artifact`, `post_to_user` artifact_paths) can validate paths against
  // the same boundaries the OS sandbox + filesystem-guard hooks enforce.
  agent.sandbox = sandboxOpts;

  const dmOAuthUser = task.getMcpOAuthUser();
  const oauthBindings = await applyOAuthBindings(
    mcpServers,
    dmOAuthUser,
    task.metadata.mcp_personal_oauth,
  );
  if (oauthBindings.injected.length > 0) {
    logger.agent(def.id, `OAuth tokens bound: ${oauthBindings.injected.join(', ')}`);
  }
  for (const { serverName, error } of oauthBindings.dropped) {
    logger.error(def.id, `MCP "${serverName}" dropped before connect — OAuth bind failed: ${error.message}`);
  }
  if (oauthBindings.requestable.length > 0) {
    const list = oauthBindings.requestable.map((s) => `"${s}"`).join(', ');
    systemPrompt +=
      `\n\n## MCP servers awaiting authorization\n` +
      `These configured MCP servers require user authorization and are not connected yet: ${list}. ` +
      `Their tools are unavailable until the DM participant authorizes them. If you need one to complete this task, ` +
      `call request_mcp_auth with the server name. The task will resume after authorization.`;
  }
  if (dmOAuthUser && oauthBindings.sharedInjected.length > 0) {
    const list = oauthBindings.sharedInjected.map((s) => `"${s}"`).join(', ');
    systemPrompt +=
      `\n\nMCP server(s) ${list} are using shared credentials. Continue with them normally. ` +
      `Only if a call fails with an authorization or permission error (401, 403, insufficient scope), ` +
      `call request_mcp_auth to switch that server to the DM user's credentials.`;
  }

  // ---- Build query options (session ID may change on retry) ----

  // One controller per spawn, shared across retry attempts. task.complete()/stop()
  // calls handle.abort() to hard-kill a subprocess that is mid-turn when its queue
  // is stopped — otherwise it loops on "Stream closed" control requests. The
  // control channel (query.interrupt) is dead at that point, so abort is the only
  // path that reaches the subprocess.
  const abortController = new AbortController();

  // GIT_AUTHOR_* so repo-agent commits are authored by the human who approved
  // edit mode (the committer stays the GitHub App bot). See buildCommitAuthorEnv.
  const commitAuthorEnv = buildCommitAuthorEnv(def, metadata);

  // Diagnostic: surface whether the human author is actually being applied. If a
  // repo agent commits as the bot, this line distinguishes "approver was never
  // captured" (edit_approved_by=NONE) from "captured but env didn't take effect".
  if (isRepoAgent(def)) {
    const ea = metadata.edit_approved_by;
    logger.agent(
      def.id,
      `Commit author: edit_approved_by=${ea ? `${ea.name} <${ea.email ?? 'no-email'}>` : 'NONE'}; ` +
        `GIT_AUTHOR ${'GIT_AUTHOR_NAME' in commitAuthorEnv ? 'injected' : 'absent → bot authors'}`,
      { editMode: metadata.edit_allowed === true },
    );
  }

  const buildQueryOptions = (sessionId?: string) => ({
    model: model as any,
    systemPrompt,
    cwd,
    additionalDirectories: additionalDirectories as any,
    executable: 'node' as const,
    settingSources: ['project'] as any,
    // The SDK replaces (not merges) process.env with this object, so any var the
    // spawned CLI needs must be listed here explicitly. HOME in particular must be
    // set: without it `~` fails to expand in unsandboxed hook commands, silently
    // resolving to a literal `~` directory instead of the real home.
    env: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      // CA-trust config for the spawned CLI. The SDK REPLACES env (see note
      // above), so without forwarding these an operator-provided CA (e.g. a
      // TLS-intercepting egress proxy) never reaches the child and its
      // Anthropic API calls fail cert validation. No-op when both are unset.
      ...(process.env.NODE_USE_SYSTEM_CA ? { NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA } : {}),
      ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      // DEBUG: when the context-probe is enabled, route this agent's API traffic
      // through the in-process logging proxy so we can measure its real context
      // breakdown. No-op (key absent) when the probe is disabled or not listening.
      ...(getProbeBaseUrl() ? { ANTHROPIC_BASE_URL: getProbeBaseUrl()! } : {}),
      ...(useClaudeDirs ? {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CLAUDE_CODE_TMPDIR: claudeTmpDir,
      } : {}),
      ...(def.pluginPath ? { CLAUDE_PLUGIN_ROOT: def.pluginPath } : {}),
      ...(def.pluginDataPath ? { CLAUDE_PLUGIN_DATA: def.pluginDataPath } : {}),
      // Commit authorship — see commitAuthorEnv above.
      ...commitAuthorEnv,
    },
    resume: sessionId,
    abortController,
    maxTurns: def.maxTurns ?? 100,
    ...(effort ? { effort } : {}),
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
        hooks: [async (input: unknown) => {
          // Reconcile in-flight background tasks against the SDK's authoritative
          // list (StopHookInput.background_tasks — running/pending, empty when
          // nothing is in flight) before parking. A bg task that settles MID-TURN
          // never emits a `task_notification` event (the SDK folds it into the
          // active turn), so without this a completed task leaks in
          // backgroundTasks and the idle-check's `size > 0` guard wedges the task
          // until the wall-clock cap (observed: task-20260625-1122-30wkzk). This
          // fires at turn-end, right before the idle-check, and drops anything the
          // SDK no longer reports as in flight — no notification parsing needed.
          const live = new Set(
            ((input as { background_tasks?: { id: string }[] }).background_tasks ?? []).map((t) => t.id),
          );
          for (const id of [...agent.backgroundTasks]) {
            if (!live.has(id)) {
              agent.backgroundTasks.delete(id);
              emitEvent('agent:bg_task', taskId, { action: 'end', key: id, status: 'completed', summary: '' }, def.id);
            }
          }
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

  // Start each spawn with a clean teardown slot. Agent objects are reused when a
  // task parks (complete()) and reopens onto the same agents, so a teardown armed
  // by report_completion/request_edit_mode/research-budget in a previous run would
  // otherwise still be set here and fire against this fresh run. deferTeardown
  // re-arms it within this run as needed.
  agent.clearPendingTeardown();

  const existingSessionId = agent.session.session_id;
  const recoverable = createRecoverableInputGenerator(agent.queue);

  const handle = {
    running: Promise.resolve() as Promise<void>,
    isRunning: true,
    abort: () => abortController.abort(),
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
                // The init snapshot only carries { name, status }. Pull the
                // richer status so a non-connected server records WHY (its
                // error) and its true status — instead of a bare "FAILED" that
                // forces the agent (and us) to guess.
                let errorByName = new Map<string, string>();
                try {
                  const detailed = await agentQuery.mcpServerStatus();
                  errorByName = new Map(
                    detailed.filter((m) => m.error).map((m) => [m.name, m.error as string]),
                  );
                  // Capture server-reported per-tool metadata (readOnly + server
                  // name) so the Slack status line can phrase any integration
                  // ("checking Rollbar", "updating Monday.com") without a map.
                  const toolMeta = new Map<string, import('../types/agent.js').McpToolMeta>();
                  for (const m of detailed) {
                    for (const t of m.tools ?? []) {
                      toolMeta.set(`mcp__${m.name}__${t.name}`, {
                        serverName: m.serverInfo?.name,
                        readOnly: t.annotations?.readOnly,
                      });
                    }
                  }
                  if (toolMeta.size > 0) agent.mcpTools = toolMeta;
                } catch {
                  // Control request unavailable — fall back to the snapshot status.
                }
                for (const mcp of event.mcp_servers) {
                  if (mcp.status === 'connected') {
                    logger.agent(def.id, `MCP ${mcp.name}: connected`);
                    continue;
                  }
                  const reason = errorByName.get(mcp.name);
                  const line = `MCP ${mcp.name}: ${mcp.status || 'unknown'}${reason ? ` — ${reason}` : ''}`;
                  // 'failed' is a hard error; pending/needs-auth/disabled are not.
                  if (mcp.status === 'failed') logger.error(def.id, line);
                  else logger.warn(def.id, line);
                }
              }
            }

            // Background tasks: the SDK runs a backgrounded Bash wait / subagent
            // out-of-band and emits task_started → task_notification. archie drives
            // agents only through its own queue, so a settle wakes nothing on its
            // own. Track in-flight tasks (so the idle-check treats the agent as busy,
            // not stalled — no spurious recovery) and re-engage the agent on settle.
            if (event.type === 'system' && event.subtype === 'task_started') {
              agent.backgroundTasks.add(event.task_id);
              logger.agent(def.id, `background task started — ${event.description}`);
              // Chat/CLI: one transcript entry per task, keyed by task_id — rendered
              // as ⏳ running, then folded to ✅/❌ when the matching 'end' arrives.
              emitEvent('agent:bg_task', taskId, {
                action: 'start', key: event.task_id, description: event.description,
              }, def.id);
            } else if (event.type === 'system' && event.subtype === 'task_notification') {
              agent.backgroundTasks.delete(event.task_id);
              logger.agent(def.id, `background task ${event.status} — ${event.summary}`);
              emitEvent('agent:bg_task', taskId, {
                action: 'end', key: event.task_id, status: event.status, summary: event.summary,
              }, def.id);
              if (!agent.queue.isStopped()) {
                agent.queue.addMessage(
                  `Background task ${event.status}: ${event.summary}. ` +
                  `Re-check what you were waiting on and continue — then report or end your turn.`,
                );
                // Enqueue-marks-active: keep the agent busy with no gap before the
                // SDK starts the resumed turn, so the idle-check can't park it.
                task.updateAgentState(def.id, true);
              }
            }

            processAgentEventForLogging(
              event,
              def.id,
              additionalDirectories,
              isRepoAgent(def) && metadata.edit_allowed === true,
            );

            // Derive the Slack "Archie is …" loading status from this agent's
            // tool calls. Best-effort and debounced inside the task.
            task.noteActivityFromEvent(def.id, event);

            // Deferred teardown (report_completion / request_edit_mode / research
            // budget): now that the turn has fully ended (the SDK `result` event),
            // run it. The teardown stops this agent's queue, which closes the input
            // stream and lets the query generator terminate *naturally* on the next
            // pull — the same path the pre-change code relied on.
            //
            // Do NOT `return` here. `Query` is an AsyncGenerator, so returning from
            // the for-await calls its .return(), abruptly tearing down the SDK
            // subprocess mid-stream instead of letting it exit gracefully. That left
            // the session in a state that broke the next `resume`, so the first
            // attempt completed cleanly but every reopened attempt after it fell
            // into recovery.
            if (event.type === 'result' && agent.pendingTeardown) {
              const teardown = agent.pendingTeardown;
              agent.clearPendingTeardown();
              await teardown().catch((err) =>
                logger.error(def.id, 'Error during deferred teardown', err)
              );
            } else if (
              event.type === 'result' &&
              event.subtype !== 'success' &&
              agent.session.active
            ) {
              // The turn ended with an ERROR result (API "Overloaded" once the
              // SDK's own retries are exhausted, max_turns, …). Unlike a clean stop
              // this does NOT fire the SDK `Stop` hook, so nothing marks the agent
              // inactive: the active flag stays set, the idle-check never arms, and
              // the task hangs until the 60-min wall-clock cap (observed: a 44-min
              // orphan after an Overloaded, broken only by an external poke). Mark
              // the agent inactive so the normal quiescence/recovery path runs —
              // recovery re-engages the agent, which retries the work. The
              // `agent.session.active` guard makes this a safety-net: a success
              // result is owned by the Stop hook, and if the Stop hook or
              // crash-detection already cleared the flag this is a no-op, so it
              // can't double-fire recovery.
              logger.warn(
                def.id,
                `Turn ended with error result '${event.subtype}' — marking inactive so recovery can run`,
              );
              task.updateAgentState(def.id, false);
            }
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
      // A dead subprocess can't settle these — drain so they don't keep the agent
      // "busy" forever and wedge the idle-check.
      agent.backgroundTasks.clear();
      // Backstop for a deferred teardown that the `result` path above never got
      // to run — e.g. the agent crashed after report_completion/request_edit_mode
      // deferred it. Without this the flag stays set, and the idle-check's
      // pending-teardown guard would then suppress recovery forever, hanging the
      // task until the wall-clock timeout. Safe here: the turn is over and the
      // stream is closed (the only reason teardown was deferred), and complete()/
      // stop() are idempotent. The result path clears the flag, so this is a
      // no-op on every normal exit.
      if (agent.pendingTeardown) {
        const teardown = agent.pendingTeardown;
        agent.clearPendingTeardown();
        await teardown().catch((err) =>
          logger.error(def.id, 'Error during deferred teardown (exit)', err)
        );
      }
    }
  })();

  agent.handle = handle;
}
