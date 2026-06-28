import type { AgentDef } from '../types/agent.js';
import type { TaskMetadata } from '../types/task.js';
import { isRepoAgent } from '../types/agent.js';

/**
 * The `GIT_AUTHOR_*` environment a repo agent commits under, so commits are
 * authored by the human who approved edit mode while the committer stays the
 * GitHub App bot (set via `configureGitIdentity()`). `git` applies these to the
 * author only; with no `GIT_COMMITTER_*` set, the committer falls back to the
 * clone's `user.*` config (the bot).
 */
export type CommitAuthorEnv =
  | { GIT_AUTHOR_NAME: string; GIT_AUTHOR_EMAIL: string }
  | Record<string, never>;

/**
 * Build the commit-author env for a spawning agent.
 *
 * Returns an empty object — inject nothing, so the bot authors — when:
 *  - the agent isn't a repo agent (only repo agents commit), or
 *  - no approver was recorded (CLI approvals, pre-feature tasks), or
 *  - the recorded name is blank after trimming. A blank `GIT_AUTHOR_NAME` makes
 *    `git commit` fatal ("empty ident name") on *every* commit, so we never
 *    inject one. Names/emails originate from a Slack profile or the API request
 *    body, so neither can be trusted to be non-empty.
 *
 * The email is trimmed and falls back to a non-routable `.invalid` noreply that
 * still surfaces the name in `git blame` (it just won't link to a GitHub
 * profile) when no usable email is present.
 */
export function buildCommitAuthorEnv(
  def: AgentDef,
  metadata: Pick<TaskMetadata, 'edit_approved_by'>,
): CommitAuthorEnv {
  const approver = isRepoAgent(def) ? metadata.edit_approved_by : undefined;
  const name = approver?.name?.trim();
  if (!approver || !name) return {};
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: approver.email?.trim() || `${approver.id}@users.noreply.archie.invalid`,
  };
}
