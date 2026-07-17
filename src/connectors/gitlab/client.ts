/**
 * GitLabHost — the GitLab implementation of the RepoHost seam (design decision:
 * GitHub schema is canonical; GitLab responses are mapped into it). REST v4 only.
 * Read methods are implemented in Plan 1; write/review methods arrive in Plan 2.
 */

import type { RepoHost } from '../../ports/repo-host.js';
import type { RepoHostCapabilities } from '../../ports/capabilities.js';
import { GITLAB_CAPABILITIES_DEFAULT } from '../../ports/capabilities.js';
import type {
  PRStatus, PRReview, ReviewThread, PRComment, PRChecksReport,
  CreatePRResult, PRDetails, PRListItem, PRListFilters,
  CheckRunReport, WorkflowRunReport, CodeScanningAlert, CodeScanningAlertFilters,
} from '../../ports/repo-host-types.js';
import type { PrCardData } from '../../types/task.js';
import { logger } from '../../system/logger.js';
import { summarizeCi } from '../../system/pr-card-format.js';
import { glRequest, glRequestAll } from './http.js';
import { mapDetailedMergeStatus, mapMrState, mapPipelineStatusToConclusion } from './status-map.js';

export class GitLabHost implements RepoHost {
  readonly kind = 'gitlab' as const;

  /** Capabilities are fixed at GITLAB_CAPABILITIES_DEFAULT (securityAlerts: false). */
  private caps: RepoHostCapabilities = { ...GITLAB_CAPABILITIES_DEFAULT };

  capabilities(): RepoHostCapabilities {
    return this.caps;
  }

  /** Escape hatch for callers that need to override capabilities directly. */
  setCapabilities(next: RepoHostCapabilities): void {
    this.caps = next;
  }

  /**
   * Capability probe hook. GitLab capabilities are used as-is from
   * GITLAB_CAPABILITIES_DEFAULT (securityAlerts: false) — no license-tier probing.
   */
  async probeCapabilities(): Promise<void> {
    logger.system(`GitLab: capabilities are fixed at boot (securityAlerts=${this.caps.securityAlerts})`);
  }

  botIdentity(): { name: string; email: string } | null {
    const name = process.env.GITLAB_BOT_NAME;
    const email = process.env.GITLAB_BOT_EMAIL;
    if (!name || !email) return null;
    return { name, email };
  }

  cloneUrl(repo: string): string {
    const base = (process.env.GITLAB_BASE_URL ?? '').replace(/\/+$/, '');
    return `${base}/${repo}.git`;
  }

  async askpassToken(): Promise<string> {
    const t = process.env.GITLAB_TOKEN;
    if (!t) throw new Error('GITLAB_TOKEN is not set');
    return t;
  }

  /** URL-encoded project id for the `:id` path segment. */
  private projectId(repo: string): string {
    return encodeURIComponent(repo);
  }

  // ---- read methods: implemented in Tasks 4–6 (throw until then) ----
  async getPRStatus(repo: string, prNumber: number): Promise<PRStatus> {
    const id = this.projectId(repo);
    const mr = await glRequest<{ state: string; merged?: boolean; detailed_merge_status?: string }>({
      path: `/projects/${id}/merge_requests/${prNumber}`,
    });
    const approvals = await glRequest<{ approved?: boolean }>({
      path: `/projects/${id}/merge_requests/${prNumber}/approvals`,
    }).catch(() => ({ approved: false }));

    const mergeableState = mapDetailedMergeStatus(mr.detailed_merge_status ?? '');
    const status: PRStatus = {
      state: mapMrState(mr.state, mr.merged),
      mergeable: mergeableState === 'clean',
      mergeableState,
      approved: approvals.approved === true,
    };
    logger.system(`GitLab: MR !${prNumber} status: state=${status.state} mergeableState=${status.mergeableState} approved=${status.approved} (raw detailed_merge_status=${mr.detailed_merge_status})`);
    return status;
  }

  async getPRDetails(repo: string, prNumber: number): Promise<PRDetails> {
    const id = this.projectId(repo);
    const mr = await glRequest<{
      iid: number; title: string; description: string | null; state: string; merged?: boolean;
      source_branch: string; target_branch: string; web_url: string;
    }>({ path: `/projects/${id}/merge_requests/${prNumber}` });
    const changes = await glRequest<{ changes?: Array<{ diff?: string; old_path?: string; new_path?: string }> }>({
      path: `/projects/${id}/merge_requests/${prNumber}/changes`,
    }).catch(() => ({ changes: [] }));
    const diff = (changes.changes ?? [])
      .map((c) => `--- ${c.old_path ?? ''}\n+++ ${c.new_path ?? ''}\n${c.diff ?? ''}`)
      .join('\n');
    return {
      number: prNumber,
      title: mr.title,
      body: mr.description ?? '',
      state: mapMrState(mr.state, mr.merged),
      head: mr.source_branch,
      base: mr.target_branch,
      diff,
      url: mr.web_url,
    };
  }

  async getPRCardData(repo: string, prNumber: number): Promise<PrCardData> {
    const id = this.projectId(repo);
    const mr = await glRequest<{ iid: number; state: string; merged?: boolean; source_branch: string; sha: string; web_url: string }>({
      path: `/projects/${id}/merge_requests/${prNumber}`,
    });
    let ci = { state: 'none' as PrCardData['ci'], passed: 0, total: 0 };
    try {
      const checks = await this.listPRChecks(repo, prNumber);
      ci = summarizeCi(checks.entries);
    } catch (error) {
      logger.warn('gitlab', `Failed to fetch checks for MR !${prNumber} card`, error);
    }
    return {
      repo,
      prNumber,
      url: mr.web_url,
      headRef: mr.source_branch,
      state: mapMrState(mr.state, mr.merged),
      head_sha: mr.sha,
      ci: ci.state,
      ciPassed: ci.passed,
      ciTotal: ci.total,
    };
  }

  async listPRs(repo: string, filters: PRListFilters = {}): Promise<PRListItem[]> {
    const id = this.projectId(repo);
    // Canonical filters.state is open|closed|all; GitLab uses opened|closed|merged|all.
    const stateMap: Record<string, string> = { open: 'opened', closed: 'closed', all: 'all' };
    const items = await glRequestAll<{
      iid: number; title: string; state: string; merged?: boolean;
      source_branch: string; target_branch: string; author?: { username?: string };
      updated_at: string; web_url: string;
    }>({
      path: `/projects/${id}/merge_requests`,
      query: {
        state: stateMap[filters.state ?? 'open'] ?? 'opened',
        target_branch: filters.base,
        order_by: 'updated_at',
        sort: filters.direction ?? 'desc',
      },
    }, 1);
    const limit = filters.per_page ?? 10;
    return items.slice(0, limit).map((mr) => ({
      number: mr.iid,
      title: mr.title,
      state: mr.state === 'opened' ? 'open' : 'closed',
      head: mr.source_branch,
      base: mr.target_branch,
      author: mr.author?.username ?? 'unknown',
      updated_at: mr.updated_at,
      url: mr.web_url,
    }));
  }

  async getPRComments(repo: string, prNumber: number): Promise<PRComment[]> {
    const id = this.projectId(repo);
    const notes = await glRequestAll<{
      id: number; author?: { username?: string }; body: string; created_at: string;
      system?: boolean; noteable_type?: string;
    }>({ path: `/projects/${id}/merge_requests/${prNumber}/notes`, query: { sort: 'asc', order_by: 'created_at' } });
    return notes
      .filter((n) => !n.system)
      .map((n) => ({
        id: n.id,
        author: n.author?.username ?? 'unknown',
        body: n.body,
        createdAt: n.created_at,
        url: `${this.cloneUrl(repo).replace(/\.git$/, '')}/-/merge_requests/${prNumber}#note_${n.id}`,
      }));
  }

  private async fetchJobLogTail(repo: string, jobId: number): Promise<string | undefined> {
    try {
      const trace = await glRequest<string>({
        path: `/projects/${this.projectId(repo)}/jobs/${jobId}/trace`, raw: true,
      });
      if (!trace) return undefined;
      // Mirror the GitHub connector: prefer the tail from the first "Failures:" marker.
      const marker = trace.indexOf('Failures:');
      const slice = marker >= 0 ? trace.slice(marker) : trace;
      return slice.length > 3000 ? slice.slice(-3000) : slice;
    } catch {
      return undefined;
    }
  }

  async listPRChecks(repo: string, prNumber: number): Promise<PRChecksReport> {
    const id = this.projectId(repo);
    const mr = await glRequest<{ sha: string; head_pipeline?: { id: number } }>({
      path: `/projects/${id}/merge_requests/${prNumber}`,
    });
    if (!mr.head_pipeline) {
      return { headSha: mr.sha ?? '', entries: [] };
    }
    const jobs = await glRequestAll<{
      id: number; name: string; status: string; stage: string; web_url: string | null;
      started_at: string | null; finished_at: string | null;
    }>({ path: `/projects/${id}/pipelines/${mr.head_pipeline.id}/jobs` });

    return {
      headSha: mr.sha ?? '',
      entries: jobs.map((j) => ({
        source: 'check_run' as const,
        name: j.name,
        app: j.stage,
        status: j.status,
        conclusion: mapPipelineStatusToConclusion(j.status),
        url: j.web_url,
        startedAt: j.started_at,
        completedAt: j.finished_at,
      })),
    };
  }

  async getCheckRunById(repo: string, checkRunId: number): Promise<CheckRunReport> {
    const id = this.projectId(repo);
    const job = await glRequest<{
      id: number; name: string; stage: string; status: string; web_url: string | null;
      commit?: { id?: string }; started_at: string | null; finished_at: string | null;
    }>({ path: `/projects/${id}/jobs/${checkRunId}` });
    const conclusion = mapPipelineStatusToConclusion(job.status);
    const logTail = conclusion === 'failure' ? await this.fetchJobLogTail(repo, job.id) : undefined;
    return {
      id: job.id,
      name: job.name,
      app: job.stage,
      status: job.status,
      conclusion,
      url: job.web_url,
      headSha: job.commit?.id ?? null,
      startedAt: job.started_at,
      completedAt: job.finished_at,
      logTail,
    };
  }

  async getWorkflowRunById(repo: string, runId: number): Promise<WorkflowRunReport> {
    const id = this.projectId(repo);
    const pipeline = await glRequest<{ id: number; status: string; sha: string | null; ref: string | null; web_url: string | null }>({
      path: `/projects/${id}/pipelines/${runId}`,
    });
    const jobs = await glRequestAll<{ id: number; name: string; status: string; web_url: string | null }>({
      path: `/projects/${id}/pipelines/${runId}/jobs`,
    });
    const jobEntries = [] as WorkflowRunReport['jobs'];
    for (const j of jobs) {
      const conclusion = mapPipelineStatusToConclusion(j.status);
      jobEntries.push({
        id: j.id,
        name: j.name,
        status: j.status,
        conclusion,
        url: j.web_url,
        logTail: conclusion === 'failure' ? await this.fetchJobLogTail(repo, j.id) : undefined,
      });
    }
    return {
      id: pipeline.id,
      name: `pipeline #${pipeline.id}`,
      status: pipeline.status,
      conclusion: mapPipelineStatusToConclusion(pipeline.status),
      headSha: pipeline.sha,
      headBranch: pipeline.ref,
      url: pipeline.web_url,
      jobs: jobEntries,
    };
  }
  async listAccessibleRepos(): Promise<Array<{ github: string; default_branch: string; description?: string }>> {
    const projects = await glRequestAll<{ path_with_namespace: string; default_branch: string | null; description: string | null }>({
      path: '/projects', query: { membership: true, order_by: 'last_activity_at', sort: 'desc' },
    });
    return projects
      .filter((p) => p.default_branch) // skip empty repos with no default branch
      .map((p) => ({
        github: p.path_with_namespace,
        default_branch: p.default_branch as string,
        ...(p.description ? { description: p.description } : {}),
      }));
  }
  async resolveRepo(repo: string): Promise<{ default_branch: string } | null> {
    try {
      const project = await glRequest<{ default_branch: string | null }>({ path: `/projects/${this.projectId(repo)}` });
      if (!project.default_branch) return null;
      return { default_branch: project.default_branch };
    } catch {
      return null;
    }
  }

  // ---- write/review methods: implemented in Plan 2 (throw for now) ----
  async createPullRequest(repo: string, head: string, base: string, title: string, body: string): Promise<CreatePRResult> {
    const mr = await glRequest<{ iid: number; web_url: string }>({
      method: 'POST',
      path: `/projects/${this.projectId(repo)}/merge_requests`,
      body: { source_branch: head, target_branch: base, title, description: body },
    });
    logger.system(`GitLab: created MR !${mr.iid} for ${repo} (${head} -> ${base})`);
    return { pr_number: mr.iid, pr_url: mr.web_url };
  }

  async updatePR(repo: string, prNumber: number, fields: { title?: string; body?: string; base?: string }): Promise<void> {
    const patch: Record<string, string> = {};
    if (fields.title !== undefined) patch.title = fields.title;
    if (fields.body !== undefined) patch.description = fields.body;
    if (fields.base !== undefined) patch.target_branch = fields.base;
    await glRequest({ method: 'PUT', path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}`, body: patch });
    logger.system(`GitLab: updated MR !${prNumber}`);
  }

  async closePullRequest(repo: string, prNumber: number): Promise<void> {
    await glRequest({
      method: 'PUT',
      path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}`,
      body: { state_event: 'close' },
    });
    logger.system(`GitLab: closed MR !${prNumber}`);
  }

  async addPRComment(repo: string, prNumber: number, comment: string): Promise<void> {
    await glRequest({
      method: 'POST',
      path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/notes`,
      body: { body: comment },
    });
    logger.system(`GitLab: added note to MR !${prNumber}`);
  }

  async mergePullRequest(repo: string, prNumber: number, mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash'): Promise<{ success: boolean; message: string }> {
    // GitLab's merge endpoint has no 'rebase' merge; it exposes a boolean `squash`.
    // Map for parity: 'squash' (Archie's default) → squash:true; 'merge'/'rebase' → squash:false.
    const squash = mergeMethod === 'squash';
    try {
      await glRequest({
        method: 'PUT',
        path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/merge`,
        body: { squash },
      });
      logger.system(`GitLab: merged MR !${prNumber} (squash=${squash})`);
      return { success: true, message: `MR !${prNumber} merged successfully` };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('gitlab', `Failed to merge MR !${prNumber}: ${message}`);
      return { success: false, message };
    }
  }

  async pushBranch(repo: string, branch: string, worktreePath: string): Promise<{ success: boolean; message: string }> {
    // Parity with the GitHub host: the actual push happens via git CLI in the
    // worktree (host-agnostic); this method is a no-op acknowledgement.
    logger.system(`GitLab: pushBranch called for ${repo}:${branch} from ${worktreePath}`);
    return { success: true, message: `Would push ${branch} to ${repo}` };
  }

  /** MR author username, used to exclude self-authored discussions from D2 synthesis. */
  private async mrAuthor(repo: string, prNumber: number): Promise<string | null> {
    try {
      const mr = await glRequest<{ author?: { username?: string } }>({
        path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}`,
      });
      return mr.author?.username ?? null;
    } catch (error) {
      logger.warn('gitlab', `Failed to fetch MR !${prNumber} author; self-exclusion in review synthesis is disabled for this call`, error);
      return null;
    }
  }

  async getPRReviews(repo: string, prNumber: number): Promise<PRReview[]> {
    const id = this.projectId(repo);
    const author = await this.mrAuthor(repo, prNumber);
    const reviews: PRReview[] = [];

    // Approvals → approved reviews (one per approver).
    const approvals = await glRequest<{ approved_by?: Array<{ user?: { username?: string } }> }>({
      path: `/projects/${id}/merge_requests/${prNumber}/approvals`,
    }).catch(() => ({ approved_by: [] as Array<{ user?: { username?: string } }> }));
    for (const a of approvals.approved_by ?? []) {
      reviews.push({ id: `approval:${a.user?.username ?? 'unknown'}`, user: a.user?.username ?? 'unknown', state: 'approved', body: '', submittedAt: '' });
    }

    // D2: unresolved, resolvable discussions started by a non-author reviewer →
    // one synthesized changes_requested review per such reviewer.
    const discussions = await glRequestAll<{
      id: string; individual_note?: boolean;
      notes?: Array<{ author?: { username?: string }; body?: string; resolvable?: boolean; resolved?: boolean; created_at?: string }>;
    }>({ path: `/projects/${id}/merge_requests/${prNumber}/discussions` }).catch((error) => {
      logger.warn('gitlab', `Failed to fetch discussions for MR !${prNumber}; degrading to approvals-only reviews`, error);
      return [];
    });

    const changeRequesters = new Map<string, { body: string; at: string }>();
    for (const d of discussions) {
      if (d.individual_note) continue;
      const first = d.notes?.[0];
      if (!first || !first.resolvable || first.resolved) continue;
      const user = first.author?.username;
      if (!user || user === author) continue;
      if (!changeRequesters.has(user)) {
        changeRequesters.set(user, { body: first.body ?? '', at: first.created_at ?? '' });
      }
    }
    for (const [user, info] of changeRequesters) {
      reviews.push({ id: `discussion:${user}`, user, state: 'changes_requested', body: info.body, submittedAt: info.at });
    }

    logger.system(`GitLab: MR !${prNumber} reviews: ${reviews.filter((r) => r.state === 'approved').length} approved, ${changeRequesters.size} changes_requested (synthesized)`);
    return reviews;
  }

  async getReviewThreads(repo: string, prNumber: number): Promise<ReviewThread[]> {
    const discussions = await glRequestAll<{
      id: string; individual_note?: boolean;
      notes?: Array<{
        id: number; author?: { username?: string }; body?: string; resolvable?: boolean; resolved?: boolean;
        created_at?: string; position?: { new_path?: string; new_line?: number | null };
      }>;
    }>({ path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/discussions` });

    const threads: ReviewThread[] = [];
    for (const d of discussions) {
      // Only resolvable (review) discussions become threads; individual_note=true are plain comments.
      if (d.individual_note) continue;
      const notes = d.notes ?? [];
      const first = notes[0];
      if (!first?.resolvable) continue;
      const pos = first.position;
      threads.push({
        threadId: d.id,
        isResolved: first.resolved === true,
        isOutdated: false, // GitLab exposes outdated only via position drift; not modeled here.
        path: pos?.new_path ?? '',
        line: pos?.new_line ?? null,
        comments: notes.map((n) => ({
          commentId: n.id,
          author: n.author?.username ?? 'unknown',
          body: n.body ?? '',
          createdAt: n.created_at ?? '',
          url: `${this.cloneUrl(repo).replace(/\.git$/, '')}/-/merge_requests/${prNumber}#note_${n.id}`,
        })),
      });
    }
    return threads;
  }
  async resolveReviewThread(repo: string, prNumber: number, threadId: string): Promise<void> {
    await glRequest({
      method: 'PUT',
      path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/discussions/${threadId}`,
      body: { resolved: true },
    });
    logger.system(`GitLab: resolved discussion ${threadId} on MR !${prNumber}`);
  }

  /** Find the discussion id that contains a given note id (GitLab replies target a discussion, not a note). */
  private async findDiscussionIdForNote(repo: string, prNumber: number, noteId: number): Promise<string | null> {
    const discussions = await glRequestAll<{ id: string; notes?: Array<{ id: number }> }>({
      path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/discussions`,
    });
    for (const d of discussions) {
      if ((d.notes ?? []).some((n) => n.id === noteId)) return d.id;
    }
    return null;
  }

  async replyToReviewComment(repo: string, prNumber: number, commentId: number, comment: string): Promise<void> {
    const discussionId = await this.findDiscussionIdForNote(repo, prNumber, commentId);
    if (!discussionId) {
      throw new Error(`GitLab: no discussion found containing note ${commentId} on MR !${prNumber}`);
    }
    await glRequest({
      method: 'POST',
      path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/discussions/${discussionId}/notes`,
      body: { body: comment },
    });
    logger.system(`GitLab: replied in discussion ${discussionId} on MR !${prNumber}`);
  }

  async addReviewComment(repo: string, prNumber: number, path: string, line: number, comment: string): Promise<void> {
    // E2E-VERIFY: positioned diff note. Endpoint: POST /merge_requests/:iid/discussions
    // with position { position_type:'text', new_path, new_line, base_sha, head_sha, start_sha }.
    // The three shas come from the MR's diff_refs. Verify the field names + a real
    // line maps correctly against the live instance (Plan 4 E2E).
    const id = this.projectId(repo);
    const mr = await glRequest<{ diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string } }>({
      path: `/projects/${id}/merge_requests/${prNumber}`,
    });
    const refs = mr.diff_refs;
    if (!refs?.base_sha || !refs?.head_sha || !refs?.start_sha) {
      throw new Error(`GitLab: MR !${prNumber} has no diff_refs; cannot post a positioned review comment`);
    }
    await glRequest({
      method: 'POST',
      path: `/projects/${id}/merge_requests/${prNumber}/discussions`,
      body: {
        body: comment,
        position: {
          position_type: 'text',
          new_path: path,
          new_line: line,
          base_sha: refs.base_sha,
          head_sha: refs.head_sha,
          start_sha: refs.start_sha,
        },
      },
    });
    logger.system(`GitLab: added review comment to ${path}:${line} on MR !${prNumber}`);
  }

  async requestReReview(repo: string, prNumber: number): Promise<void> {
    // GitLab has no re-review request primitive; capability reReviewRequest=false.
    // Degrade gracefully (P3): log and no-op rather than throwing on a normal path.
    logger.system(`GitLab: requestReReview is a no-op on this host (MR !${prNumber}); reReviewRequest capability is false`);
  }

  /**
   * GitLab's code-scanning-equivalent (vulnerability findings) is an Ultimate-tier
   * feature and is out of scope for this adapter. securityAlerts is always false in
   * GITLAB_CAPABILITIES_DEFAULT, so tools.ts never surfaces these; these bodies are
   * unreachable in practice and exist only to satisfy RepoHost conformance.
   */
  async listCodeScanningAlerts(_repo: string, _filters: CodeScanningAlertFilters = {}): Promise<CodeScanningAlert[]> {
    if (!this.caps.securityAlerts) return [];
    throw new Error('code scanning not supported for GitLab');
  }

  async getCodeScanningAlert(_repo: string, _alertNumber: number): Promise<CodeScanningAlert> {
    throw new Error('code scanning not supported for GitLab');
  }
}
