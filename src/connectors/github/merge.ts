/**
 * Merge Orchestrator
 *
 * Handles automatic merging of PRs when all conditions are met.
 * System-level component - not part of any agent.
 *
 * Key logic:
 * - Uses mergeableState to differentiate conflicts from CI/policy blocks
 * - dirty: merge conflicts → notify PM to resolve
 * - blocked/unstable: CI or policy → wait silently
 * - clean: ready to merge → proceed
 */

export interface MergeCheckResult {
  merged: string[];    // PRs that were merged
  pending: string[];   // PRs waiting for approval/CI
  conflicts: string[]; // PRs with merge conflicts
  ready: string[];     // Ready PRs in non-auto repos — held for an explicit merge request
}

import { appendAgentFinding } from '../../tasks/persistence.js';
import { Task } from '../../tasks/task.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { isAutoMergeRepo } from '../../agents/registry.js';
import { createGitHubClient, type GitHubClient } from './client.js';
import { isMergeReadyPerGithub } from './mergeability.js';
import { logger } from '../../system/logger.js';
import type { PRStatus } from '../../agents/tools.js';
import type { BranchState } from '../../types/task.js';

interface LinkedPRStatus {
  github: string;
  prNumber: number;
  status: PRStatus;
}

/**
 * Check all linked PRs and merge if ready (webhook-triggered)
 *
 * Called from webhook handlers on: approval, push, CI success.
 * Notifies PM about results (conflicts, merges, failures).
 */
export async function checkAndMergeLinkedPRs(taskId: string): Promise<void> {
  const result = await triggerMergeCheck(taskId);

  // Only notify PM if something noteworthy happened
  const newlyMerged = result.merged.filter((pr) => !pr.includes('already merged'));

  if (result.conflicts.length > 0) {
    await notifyPMAboutConflicts(taskId, result.conflicts);
  } else if (newlyMerged.length > 0) {
    await notifyPMAboutMerge(taskId, newlyMerged, []);
  }
  // If only pending PRs, wait silently (retry on next webhook)
}

/**
 * Check and merge linked PRs, returning results for tool use
 *
 * Similar to checkAndMergeLinkedPRs but returns results instead of
 * notifying PM (since PM is calling this via a tool).
 */
export async function triggerMergeCheck(taskId: string): Promise<MergeCheckResult> {
  const result: MergeCheckResult = { merged: [], pending: [], conflicts: [], ready: [] };

  const task = await Task.get(taskId);

  const githubClient = createGitHubClient();
  if (!githubClient) {
    logger.warn('merge-orchestrator', 'GitHub client not configured');
    return result;
  }

  // Collect all PRs linked to this task by iterating every attached repo across
  // every agent. A PR is identified by (github, prNumber); dedupe so two agents
  // pointing at the same PR don't generate duplicate work.
  const linkedPRSet = new Set<string>();
  const linkedPRs: Array<{ github: string; prNumber: number }> = [];
  for (const attachments of Object.values(task.metadata.repositories)) {
    if (!Array.isArray(attachments)) continue;
    for (const attached of attachments) {
      if (!attached.branch_states) continue;
      for (const state of Object.values(attached.branch_states)) {
        if (!state.pr_number) continue;
        const key = `${attached.github}#${state.pr_number}`;
        if (linkedPRSet.has(key)) continue;
        linkedPRSet.add(key);
        linkedPRs.push({ github: attached.github, prNumber: state.pr_number });
      }
    }
  }

  if (linkedPRs.length === 0) {
    logger.system(`Task ${taskId}: No PRs linked`);
    return result;
  }

  logger.system(`Task ${taskId}: Checking ${linkedPRs.length} linked PR(s)`);

  // Fetch status of all PRs
  const prStatuses = await fetchAllPRStatuses(githubClient, linkedPRs);

  // Categorize PRs with detailed logging
  const alreadyMerged = prStatuses.filter((pr) => pr.status.state === 'merged');
  // PR is mergeable when:
  // - state is open (not already merged/closed)
  // - approved by reviewer
  // - GitHub reports it ready (see isMergeReadyPerGithub for the 'blocked' tolerance)
  const mergeable = prStatuses.filter(
    (pr) =>
      pr.status.state === 'open' &&
      pr.status.approved &&
      isMergeReadyPerGithub(pr.status)
  );
  const conflicted = prStatuses.filter(
    (pr) => pr.status.state === 'open' && pr.status.mergeableState === 'dirty'
  );
  const pending = prStatuses.filter(
    (pr) =>
      pr.status.state === 'open' &&
      !conflicted.includes(pr) &&
      !mergeable.includes(pr)
  );

  // Policy split: the orchestrator only merges PRs in auto-merge repos. Ready
  // PRs in non-auto repos are held for an explicit user-requested merge.
  const autoMergeable = mergeable.filter((pr) => isAutoMergeRepo(pr.github));
  const held = mergeable.filter((pr) => !autoMergeable.includes(pr));

  // Notify-once bookkeeping: a PR observed no longer ready — not ready while
  // open, or closed without merging — drops its `merge_ready_notified`
  // markers, so the next continuous ready period notifies again (a
  // closed-then-reopened PR included).
  const notReady = prStatuses.filter(
    (pr) =>
      (pr.status.state === 'open' && !mergeable.includes(pr)) ||
      pr.status.state === 'closed'
  );
  let markersCleared = false;
  for (const pr of notReady) {
    for (const state of findBranchStatesForPR(task, pr.github, pr.prNumber)) {
      if (state.merge_ready_notified) {
        delete state.merge_ready_notified;
        markersCleared = true;
      }
    }
  }
  if (markersCleared) {
    task.debouncedSave();
  }

  // Log categorization for debugging
  logger.system(
    `Task ${taskId}: PR categorization: ` +
      `alreadyMerged=${alreadyMerged.length}, ` +
      `mergeable=${autoMergeable.length}, ` +
      `ready=${held.length}, ` +
      `conflicted=${conflicted.length}, ` +
      `pending=${pending.length}`
  );

  // Log details for all non-merged PRs
  for (const pr of prStatuses) {
    if (pr.status.state === 'merged') continue;

    const flags = [
      `state=${pr.status.state}`,
      `approved=${pr.status.approved}`,
      `mergeable=${pr.status.mergeable}`,
      `mergeableState=${pr.status.mergeableState}`,
    ];

    let category: string;
    let reason = '';
    if (autoMergeable.includes(pr)) {
      category = 'READY TO MERGE';
    } else if (held.includes(pr)) {
      category = 'READY (merge on request)';
      reason = 'repo is not auto-merge';
    } else if (conflicted.includes(pr)) {
      category = 'CONFLICTED';
      reason = 'merge conflicts';
    } else {
      category = 'PENDING';
      // Explain why not mergeable
      const reasons: string[] = [];
      if (!pr.status.approved) reasons.push('needs approval');
      if (pr.status.mergeableState !== 'clean') reasons.push(`mergeableState=${pr.status.mergeableState}`);
      reason = reasons.join(', ');
    }

    const reasonStr = reason ? ` - ${reason}` : '';
    logger.system(`Task ${taskId}: ${pr.github}#${pr.prNumber} → ${category}${reasonStr} (${flags.join(', ')})`);
  }

  // Format already merged PRs
  for (const pr of alreadyMerged) {
    result.merged.push(`${pr.github}#${pr.prNumber} (already merged)`);
  }

  // Merge what's ready — auto-merge repos only (AC2)
  for (const pr of autoMergeable) {
    try {
      const mergeResult = await githubClient.mergePullRequest(pr.github, pr.prNumber);
      if (mergeResult.success) {
        result.merged.push(`${pr.github}#${pr.prNumber}`);
        logger.system(`Merged ${pr.github}#${pr.prNumber}`);
      } else {
        result.pending.push(`${pr.github}#${pr.prNumber}: ${mergeResult.message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      result.pending.push(`${pr.github}#${pr.prNumber}: ${message}`);
    }
  }

  // Record held-ready PRs (non-auto repos — never merged here, AC1)
  for (const pr of held) {
    result.ready.push(`${pr.github}#${pr.prNumber}`);
  }

  // Record conflicts
  for (const pr of conflicted) {
    result.conflicts.push(`${pr.github}#${pr.prNumber}`);
  }

  // Record pending PRs
  for (const pr of pending) {
    const reasons: string[] = [];
    if (!pr.status.approved) reasons.push('needs approval');
    if (pr.status.mergeableState !== 'clean') reasons.push(pr.status.mergeableState);
    result.pending.push(`${pr.github}#${pr.prNumber}: ${reasons.join(', ')}`);
  }

  return result;
}

/**
 * Map a PR back to its BranchState entries — the same repositories walk the
 * PR collection does. A PR attached under several agents may match several
 * branch states, so callers treat the result as a set: "notified" is true if
 * any entry carries the marker; setting/clearing applies to all of them.
 */
function findBranchStatesForPR(task: Task, github: string, prNumber: number): BranchState[] {
  const matches: BranchState[] = [];
  for (const attachments of Object.values(task.metadata.repositories)) {
    if (!Array.isArray(attachments)) continue;
    for (const attached of attachments) {
      if (attached.github !== github || !attached.branch_states) continue;
      for (const state of Object.values(attached.branch_states)) {
        if (state.pr_number === prNumber) matches.push(state);
      }
    }
  }
  return matches;
}

/**
 * Fetch status for all linked PRs
 */
async function fetchAllPRStatuses(
  githubClient: GitHubClient,
  linkedPRs: Array<{ github: string; prNumber: number }>
): Promise<LinkedPRStatus[]> {
  const results: LinkedPRStatus[] = [];

  for (const { github, prNumber } of linkedPRs) {
    try {
      const status = await githubClient.getPRStatus(github, prNumber);
      results.push({ github, prNumber, status });
    } catch (error) {
      logger.error(
        'merge-orchestrator',
        `Failed to get status for ${github}#${prNumber}`,
        error
      );
    }
  }

  return results;
}

/**
 * Notify PM about PRs with conflicts
 * Logs to knowledge.log and sends message to PM
 */
async function notifyPMAboutConflicts(
  taskId: string,
  conflictedPRs: string[]
): Promise<void> {
  const prList = conflictedPRs.map((pr) => `- ${pr}`).join('\n');

  const message =
    `The following PRs have merge conflicts that need resolution:\n${prList}\n\n` +
    `Please instruct the team to merge from the base branch and resolve conflicts.`;

  logger.system(`Task ${taskId}: Notifying PM about conflicts`);

  await appendAgentFinding(taskId, 'system', message, 'blocker');

  const task = await Task.get(taskId);
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}

/**
 * Notify PM that PRs were merged (or failed to merge)
 * Logs to knowledge.log and sends message to PM
 */
async function notifyPMAboutMerge(
  taskId: string,
  mergedPRs: string[],
  failedPRs: string[]
): Promise<void> {
  let message = '';

  if (mergedPRs.length > 0) {
    message += `PRs merged successfully:\n${mergedPRs.map((pr) => `- ${pr}`).join('\n')}`;
  }

  if (failedPRs.length > 0) {
    if (message) message += '\n\n';
    message += `PRs failed to merge:\n${failedPRs.map((pr) => `- ${pr}`).join('\n')}`;
  }

  if (!message) {
    return;
  }

  logger.system(`Task ${taskId}: Notifying PM about merge results`);

  const findingType = failedPRs.length > 0 ? 'blocker' : 'completion';
  await appendAgentFinding(taskId, 'system', message, findingType);

  const task = await Task.get(taskId);
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}
