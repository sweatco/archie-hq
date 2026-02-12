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
}

import { loadMetadata, appendAgentFinding } from '../system/task-manager.js';
import { createGitHubClient, type GitHubClient } from './client.js';
import { getRepoConfig } from '../agents/repo-configs.js';
import { logger } from '../system/logger.js';
import { reactivateTask } from '../system/event-handler.js';
import type { PRStatus } from '../mcp/tools.js';
import type { TaskMetadata } from '../types/index.js';

interface LinkedPRStatus {
  repoKey: string;
  githubRepo: string;
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
  const result: MergeCheckResult = { merged: [], pending: [], conflicts: [] };

  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.error('merge-orchestrator', `Task ${taskId} not found`);
    return result;
  }

  const githubClient = createGitHubClient();
  if (!githubClient) {
    logger.warn('merge-orchestrator', 'GitHub client not configured');
    return result;
  }

  // Collect all PRs linked to this task
  const linkedPRs: Array<{ repoKey: string; prNumber: number }> = [];
  for (const [repoKey, repoInfo] of Object.entries(metadata.repositories)) {
    if (repoInfo.pr_number) {
      linkedPRs.push({ repoKey, prNumber: repoInfo.pr_number });
    }
  }

  if (linkedPRs.length === 0) {
    logger.system(`Task ${taskId}: No PRs linked`);
    return result;
  }

  logger.system(`Task ${taskId}: Checking ${linkedPRs.length} linked PR(s)`);

  // Fetch status of all PRs
  const prStatuses = await fetchAllPRStatuses(githubClient, linkedPRs, metadata);

  // Categorize PRs with detailed logging
  const alreadyMerged = prStatuses.filter((pr) => pr.status.state === 'merged');
  // PR is mergeable when:
  // - state is open (not already merged/closed)
  // - approved by reviewer
  // - mergeableState is 'clean' OR (mergeable=true AND mergeableState='blocked')
  //
  // Note on 'blocked' state: GitHub Rulesets (vs classic branch protection) have a known
  // issue where API reports 'blocked' even when the UI shows a green merge button.
  // See: https://github.com/runatlantis/atlantis/issues/4116
  // When mergeable=true, GitHub has determined the PR CAN be merged, so we attempt it.
  // The merge API call will fail if it's actually blocked, which we handle gracefully.
  const mergeable = prStatuses.filter(
    (pr) =>
      pr.status.state === 'open' &&
      pr.status.approved &&
      (pr.status.mergeableState === 'clean' ||
        (pr.status.mergeable && pr.status.mergeableState === 'blocked'))
  );
  const conflicted = prStatuses.filter((pr) => pr.status.mergeableState === 'dirty');
  const pending = prStatuses.filter(
    (pr) =>
      pr.status.state === 'open' &&
      !conflicted.includes(pr) &&
      !mergeable.includes(pr)
  );

  // Log categorization for debugging
  logger.system(
    `Task ${taskId}: PR categorization: ` +
      `alreadyMerged=${alreadyMerged.length}, ` +
      `mergeable=${mergeable.length}, ` +
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
    if (mergeable.includes(pr)) {
      category = 'READY TO MERGE';
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
    logger.system(`Task ${taskId}: ${pr.repoKey}#${pr.prNumber} → ${category}${reasonStr} (${flags.join(', ')})`);
  }

  // Format already merged PRs
  for (const pr of alreadyMerged) {
    result.merged.push(`${pr.repoKey}#${pr.prNumber} (already merged)`);
  }

  // Merge what's ready
  for (const pr of mergeable) {
    try {
      const mergeResult = await githubClient.mergePullRequest(pr.githubRepo, pr.prNumber);
      if (mergeResult.success) {
        result.merged.push(`${pr.repoKey}#${pr.prNumber}`);
        logger.system(`Merged ${pr.githubRepo}#${pr.prNumber}`);
      } else {
        result.pending.push(`${pr.repoKey}#${pr.prNumber}: ${mergeResult.message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      result.pending.push(`${pr.repoKey}#${pr.prNumber}: ${message}`);
    }
  }

  // Record conflicts
  for (const pr of conflicted) {
    result.conflicts.push(`${pr.repoKey}#${pr.prNumber}`);
  }

  // Record pending PRs
  for (const pr of pending) {
    const reasons: string[] = [];
    if (!pr.status.approved) reasons.push('needs approval');
    if (pr.status.mergeableState !== 'clean') reasons.push(pr.status.mergeableState);
    result.pending.push(`${pr.repoKey}#${pr.prNumber}: ${reasons.join(', ')}`);
  }

  return result;
}

/**
 * Fetch status for all linked PRs
 */
async function fetchAllPRStatuses(
  githubClient: GitHubClient,
  linkedPRs: Array<{ repoKey: string; prNumber: number }>,
  metadata: TaskMetadata
): Promise<LinkedPRStatus[]> {
  const results: LinkedPRStatus[] = [];

  for (const { repoKey, prNumber } of linkedPRs) {
    const config = getRepoConfig(`${repoKey}-agent`);
    if (!config) {
      logger.warn('merge-orchestrator', `No config found for repo key: ${repoKey}`);
      continue;
    }

    try {
      const status = await githubClient.getPRStatus(config.githubRepo, prNumber);
      results.push({
        repoKey,
        githubRepo: config.githubRepo,
        prNumber,
        status,
      });
    } catch (error) {
      logger.error(
        'merge-orchestrator',
        `Failed to get status for ${config.githubRepo}#${prNumber}`,
        error
      );
    }
  }

  return results;
}

/**
 * Notify PM about PRs with conflicts
 * Logs to knowledge.log and routes through spawn queue
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

  // Log to knowledge.log (PM will read this)
  await appendAgentFinding(taskId, 'system', message, 'blocker');

  // Reactivate task so PM reads the new knowledge
  await reactivateTask(taskId);
}

/**
 * Notify PM that PRs were merged (or failed to merge)
 * Logs to knowledge.log and routes through spawn queue
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

  // Log to knowledge.log (PM will read this)
  const findingType = failedPRs.length > 0 ? 'blocker' : 'completion';
  await appendAgentFinding(taskId, 'system', message, findingType);

  // Reactivate task so PM reads the new knowledge
  await reactivateTask(taskId);
}
