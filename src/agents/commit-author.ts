import type { AgentDef } from '../types/agent.js';
import type { TaskMetadata } from '../types/task.js';

/**
 * The `GIT_AUTHOR_*` environment the agent commits under, so commits are
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
  _def: AgentDef,
  metadata: Pick<TaskMetadata, 'edit_approved_by'>,
): CommitAuthorEnv {
  // Gated on the APPROVAL, not on the kind of agent. It used to also require
  // `isRepoAgent(def)`, which was how "only agents that commit get an author"
  // was expressed — but the flattening left the PM as the only agent and it
  // carries no `repo`, so the predicate went permanently false and every commit
  // after an approval was authored by the bot. `edit_approved_by` is only ever
  // set by an edit-mode approval, so it is the condition that was actually
  // meant. `_def` stays in the signature: the caller passes it and a future
  // per-agent rule would want it back.
  const approver = metadata.edit_approved_by;
  const name = approver?.name?.trim();
  if (!approver || !name) return {};
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: approver.email?.trim() || `${approver.id}@users.noreply.archie.invalid`,
  };
}
