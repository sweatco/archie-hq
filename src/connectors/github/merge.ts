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
 *
 * The Task is resolved exactly once per run and threaded through every step.
 * For an inactive (parked) task each `Task.get` loads a fresh instance from
 * disk, so marker writes on one instance would race the instance a PM
 * notification activates — the marker must be set on, and flushed from, the
 * same instance that gets activated.
 */
export async function checkAndMergeLinkedPRs(taskId: string): Promise<void> {
  const task = await Task.get(taskId);
  const result = await runMergeCheck(task);

  // Only notify PM if something noteworthy happened
  const newlyMerged = result.merged.filter((pr) => !pr.includes('already merged'));

  if (result.conflicts.length > 0) {
    await notifyPMAboutConflicts(task, result.conflicts);
  } else if (newlyMerged.length > 0) {
    await notifyPMAboutMerge(task, newlyMerged, []);
  }

  // Held-ready PRs in non-auto repos: notify once per continuous ready period.
  const notifiable = markNewlyNotifiableReadyPRs(task, result.ready);
  if (notifiable.length > 0) {
    // Flush the marker synchronously before the PM reactivation. A debounced
    // save is not enough: the activation makes this instance canonical and it
    // saves constantly from then on, but any instance loaded elsewhere before
    // the deferred write lands would miss the marker and re-notify.
    await task.save(true);
    await notifyPMAboutReadyPRs(task, notifiable);
  }
  // If only pending PRs, wait silently (retry on next webhook)
}

/**
 * Filter the held-ready bucket down to PRs that still need their ready
 * notification, setting the `merge_ready_notified` marker on every matching
 * BranchState entry as they are selected. Skips a PR whose merge-approval
 * prompt is currently pending — the user already holds an actionable prompt
 * for it, and a simultaneous "ready" nudge would be a confusing double prompt.
 *
 * Pure marker bookkeeping — the caller persists (synchronously, before any
 * task activation) when the result is non-empty.
 */
function markNewlyNotifiableReadyPRs(task: Task, readyPRs: string[]): string[] {
  if (readyPRs.length === 0) return [];

  const notifiable: string[] = [];
  for (const prRef of readyPRs) {
    // prRef is `<github>#<pr_number>` — split on the last '#' (repo names never contain one)
    const sep = prRef.lastIndexOf('#');
    const github = prRef.slice(0, sep);
    const prNumber = Number(prRef.slice(sep + 1));

    const pending = task.metadata.pending_merge_approval;
    if (pending && pending.github === github && pending.pr_number === prNumber) continue;

    const states = findBranchStatesForPR(task, github, prNumber);
    if (states.some((s) => s.merge_ready_notified)) continue;

    for (const state of states) {
      state.merge_ready_notified = true;
    }
    notifiable.push(prRef);
  }

  return notifiable;
}

/**
 * Check and merge linked PRs, returning results for tool use
 *
 * Similar to checkAndMergeLinkedPRs but returns results instead of
 * notifying PM (since PM is calling this via a tool).
 */
export async function triggerMergeCheck(taskId: string): Promise<MergeCheckResult> {
  return runMergeCheck(await Task.get(taskId));
}

/**
 * The merge-check body, operating on an already-resolved Task instance so a
 * single run never mixes state across separately loaded instances (see
 * checkAndMergeLinkedPRs).
 */
async function runMergeCheck(task: Task): Promise<MergeCheckResult> {
  const result: MergeCheckResult = { merged: [], pending: [], conflicts: [], ready: [] };

  const taskId = task.taskId;

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

  // Notify-once bookkeeping: a PR observed out of the ready state — not ready
  // while open, closed without merging, or merged — drops its
  // `merge_ready_notified` markers. Open/closed clears let the next continuous
  // ready period notify again (a closed-then-reopened PR included); the merged
  // clear matters because a BranchState's `pr_number` can later be overwritten
  // by a new PR on the same branch, which must not inherit the stale marker.
  const notReady = prStatuses.filter((pr) => !mergeable.includes(pr));
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
  task: Task,
  conflictedPRs: string[]
): Promise<void> {
  const prList = conflictedPRs.map((pr) => `- ${pr}`).join('\n');

  const message =
    `The following PRs have merge conflicts that need resolution:\n${prList}\n\n` +
    `Please instruct the team to merge from the base branch and resolve conflicts.`;

  logger.system(`Task ${task.taskId}: Notifying PM about conflicts`);

  await appendAgentFinding(task.taskId, 'system', message, 'blocker');

  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}

/**
 * Notify PM that held-ready PRs (non-auto repos) can be merged on request
 * Logs to knowledge.log and sends message to PM
 */
async function notifyPMAboutReadyPRs(
  task: Task,
  readyPRs: string[]
): Promise<void> {
  const prList = readyPRs.map((pr) => `- ${pr}`).join('\n');

  const message =
    `The following PRs are approved and green, but their repos do not auto-merge:\n${prList}\n\n` +
    `Tell the user in the thread that the PR is ready and will be merged on their request.`;

  logger.system(`Task ${task.taskId}: Notifying PM about ready PRs`);

  await appendAgentFinding(task.taskId, 'system', message, 'decision');

  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}

/**
 * Notify PM that PRs were merged (or failed to merge)
 * Logs to knowledge.log and sends message to PM
 */
async function notifyPMAboutMerge(
  task: Task,
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

  logger.system(`Task ${task.taskId}: Notifying PM about merge results`);

  const findingType = failedPRs.length > 0 ? 'blocker' : 'completion';
  await appendAgentFinding(task.taskId, 'system', message, findingType);

  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}
