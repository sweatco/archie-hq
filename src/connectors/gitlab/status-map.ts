/**
 * Pure GitLab → canonical mappers (spec §5 Phase 1, design decision 4). Kept
 * network-free so they are unit-testable in isolation. GitLab's vocabulary is
 * translated into the canonical GitHub-shaped types in ports/repo-host-types.ts.
 */

import type { MergeableState, CheckConclusion } from '../../ports/repo-host-types.js';

/** GitLab MR `detailed_merge_status` → canonical MergeableState. */
export function mapDetailedMergeStatus(status: string): MergeableState {
  switch (status) {
    case 'mergeable':
      return 'clean';
    case 'conflict':
    case 'broken_status':
      return 'dirty';
    case 'ci_still_running':
    case 'preparing':
    case 'checking':
    case 'unchecked':
      return 'unstable';
    case 'not_approved':
    case 'discussions_not_resolved':
    case 'draft_status':
    case 'blocked_status':
    case 'not_open':
    case 'need_rebase':
      return 'blocked';
    default:
      return 'unknown';
  }
}

/** GitLab pipeline/job `status` → canonical CheckConclusion (null = no conclusion yet). */
export function mapPipelineStatusToConclusion(status: string): CheckConclusion {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failure';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      // running, pending, created, manual, scheduled, waiting_for_resource, preparing…
      return null;
  }
}

/** GitLab MR `state` (+ optional merged flag) → canonical PR state. */
export function mapMrState(state: string, merged?: boolean): 'open' | 'merged' | 'closed' {
  if (merged || state === 'merged') return 'merged';
  if (state === 'opened') return 'open';
  return 'closed'; // closed | locked | anything else
}

/**
 * Parse a GitLab job/pipeline reference (URL or bare id) for the check tools.
 * `/-/jobs/:id` → job; `/-/pipelines/:id` → pipeline; a bare number → job.
 */
export function parseGitLabCheckRef(input: string): { kind: 'job' | 'pipeline'; id: number } | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return { kind: 'job', id: Number(trimmed) };
  }
  const job = trimmed.match(/\/-\/jobs\/(\d+)/);
  if (job) return { kind: 'job', id: Number(job[1]) };
  const pipeline = trimmed.match(/\/-\/pipelines\/(\d+)/);
  if (pipeline) return { kind: 'pipeline', id: Number(pipeline[1]) };
  return null;
}
