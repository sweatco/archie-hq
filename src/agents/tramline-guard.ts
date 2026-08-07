/**
 * Tramline Action Guard
 *
 * Tramline's MCP server exposes reads *and* 36 release-lifecycle write actions
 * on one API key. Tramline's own scopes are binary (`read`/`write`), so a key
 * that can retry a submission can also push a staged rollout to 100% — there is
 * no server-side way to express "may retry, may not roll out". This guard is
 * where that distinction is enforced instead.
 *
 * Two PreToolUse/PostToolUse hooks, both fired for every agent from spawn.ts:
 *
 * 1. `createTramlineGuardHooks()` — PreToolUse. One rule, no tiers: reads pass,
 *    and **every mutation requires per-call human approval**. A write is denied,
 *    a Slack approval carrying the *rendered* action is posted, and the task
 *    parks. Once a human approves, the approval is stored against a digest of
 *    `(tool, arguments)` and the agent's retry of that exact call passes once.
 *
 * 2. `createTramlineContextHook()` — PostToolUse. Indexes the human-readable
 *    label of every id that appears in a Tramline read response, so the
 *    approval prompt can name what it is about.
 *
 * Two properties are deliberate, and both are borrowed from the merge gate
 * (see `merge_pull_request` in tools.ts):
 *
 * - **The approval is bound to the exact call.** The digest covers the tool
 *   name and every argument, so approving "retry submission A" cannot be
 *   spent on submission B, and cannot be spent twice.
 * - **The prompt is rendered by us, not by the agent.** The human reads a
 *   description built from the real tool arguments and Tramline's own read
 *   data — never the agent's summary of what it intends to do. An agent that
 *   has misdiagnosed cannot mislabel the button it is asking you to press.
 *
 * A gated call whose target cannot be named is denied rather than posted
 * unlabelled: you cannot act on a release resource this task has not read.
 */

import { createHash } from 'crypto';
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../system/logger.js';

const TOOL_PREFIX = 'mcp__tramline__';

/** How long an approval stays spendable. The agent retries within seconds of
 *  reactivation; a long window only widens the gap between what the approver
 *  saw and what eventually runs. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** How long an unresolved *request* keeps the single pending slot. Past this it
 *  is discarded rather than blocking every other action for the task's life, and
 *  rather than minting a fresh grant if someone finds the prompt days later. */
export const PENDING_APPROVAL_TTL_MS = 60 * 60 * 1000;

/** Cap on the per-task id→label index. Bounds the metadata file; a release tree
 *  is ~30 ids, so this holds several releases' worth. */
export const TARGET_INDEX_LIMIT = 120;

// ---- Classification ----------------------------------------------------------

/**
 * Reads. Allow-listed rather than derived, so a *new* Tramline tool added to
 * the MCP server later defaults to gated instead of silently open.
 */
const READ_ACTIONS = new Set([
  'list_apps',
  'get_app',
  'list_trains',
  'get_train',
  'list_releases',
  'get_release',
  'get_release_commits',
  'get_release_pull_requests',
  'get_release_analytics',
]);

export type TramlineDisposition = 'not-tramline' | 'read' | 'gated';

/**
 * Classify a tool call. `toolName` is the full MCP name.
 *
 * Deliberately two-valued for Tramline tools: reads pass, everything else is a
 * mutation and needs a human. No auto-allowed tier ("sounds like a read" turned
 * out to be false for every candidate — the sync/fetch tools reach code that
 * starts production releases and schedules rollouts), and no never-list (which
 * turned out not to be closed under effect: permitted tools reached forbidden
 * outcomes through Tramline's own cascades). One uniform rule has nothing to
 * launder: whatever the action does, a human reads the rendered label and
 * decides. Reads are allow-listed rather than derived, so a Tramline tool added
 * later defaults to gated instead of silently open.
 */
export function classifyTramlineTool(toolName: string): TramlineDisposition {
  if (!toolName.startsWith(TOOL_PREFIX)) return 'not-tramline';
  return READ_ACTIONS.has(toolName.slice(TOOL_PREFIX.length)) ? 'read' : 'gated';
}

export function tramlineAction(toolName: string): string {
  return toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : toolName;
}

// ---- Digest ------------------------------------------------------------------

/** Stable stringify: object keys sorted at every depth, so argument order in
 *  the model's output can't change the digest of the same logical call. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Identity of a specific call. Covers the arguments, not just the tool, so an
 * approval is spendable on one target only.
 */
export function actionDigest(toolName: string, input: unknown): string {
  return createHash('sha256')
    // NUL delimiter, written as an escape rather than a literal control
    // character: a raw NUL in the source makes git treat this file as binary
    // and GitHub then shows no diff for it. It cannot occur in an action name
    // (`[a-z_]+`) or in canonicalized JSON, so it separates the two parts
    // unambiguously.
    .update(`${tramlineAction(toolName)}\u0000${canonicalize(input ?? {})}`)
    .digest('hex')
    .slice(0, 16);
}

// ---- Rendering the approval prompt -------------------------------------------

/**
 * What each gated action does, in the words a release manager would use. This
 * is the text a human reads before clicking Approve, so it says the
 * consequence, not the method name.
 *
 * **This map is the gate's allowlist**, not decoration: an action with no entry
 * is refused rather than rendered as a bare method name. That is what makes
 * "defaults to gated" mean "defaults to *refused*" — otherwise a future
 * Tramline action arrives as a one-click button labelled `Run the Tramline
 * action \`x\``, with no statement of consequence for the approver to weigh.
 * Adding an action here is therefore a deliberate review step: whoever writes
 * the sentence has to read the Tramline code and state the real consequence —
 * the descriptions for the sync/fetch tools below exist because their names
 * suggested reads and their code started builds.
 */
const ACTION_DESCRIPTIONS: Record<string, string> = {
  // Release lifecycle
  start_release: 'Start a new release — cuts the release branch, bumps versions, opens the kickoff PRs and starts CI. No undo short of stopping the release',
  stop_release: 'Stop this release entirely — terminal, a stopped release cannot be un-stopped',
  retry_pre_release: 'Retry the failed pre-release phase (branch creation, version bump)',
  retry_preparation: 'Retry the failed preparation workflow',
  trigger_preparation: 'Trigger the preparation workflow now',
  sync_release_commits: 'Re-process the release branch commits — this can push a version-bump commit that auto-merges to the working branch, start a build, and open backmerge PRs',
  sync_release_pull_requests: 'Re-check the release PRs — on a failed post-release this finalizes the release (tag + backmerge)',
  complete_release: 'Finalize the release: tag it and run the end-of-release backmerge',
  finish_release: 'Finish a partially-finished release, stopping the platforms still pending',
  apply_build_queue: 'Flush the queued commits into the release — changes what is being shipped',
  end_soak: 'End the beta soak early, skipping the rest of the observation window',
  extend_soak: 'Extend the beta soak period (delays the release; does not ship anything)',
  // Platform runs
  start_internal_release: 'Create an internal build for the team',
  start_beta_release: 'Create a release-candidate build for testers — built from the latest applicable commit, so it may contain commits the previous RC did not',
  start_production_release: 'Start the production release with a specific build — decides which binary goes to the store',
  conclude_platform_run: 'Conclude this platform, closing it out of the release',
  // Workflow runs
  trigger_workflow_run: 'Trigger this CI workflow run',
  retry_workflow_run: 'Re-run this failed CI build',
  poll_workflow_run_status: 'Poll the CI provider for this in-progress workflow run — if CI has finished, this attaches the build and triggers store submissions (on a hotfix release candidate it starts the production release)',
  fetch_workflow_run_status: 'Re-check a workflow run that could not be found on the CI provider — this moves it out of `failed`, and if CI reports success it attaches the build and triggers store submissions (on a hotfix RC it starts the production release)',
  // Store submissions
  trigger_submission: 'Send this submission to the store — on a production App Store submission this prepares the store version, which overwrites its metadata',
  retry_submission: 'Retry this failed store submission — if it failed before it was ever prepared, this re-prepares the store version and overwrites its metadata',
  sync_submission_from_store: 'Pull this submission\'s state from the store — this can advance it (approve/reject/submit) and can put an App Store rollout on an automatic schedule',
  prepare_submission: 'Prepare the store version for this submission — re-preparing force-overwrites the store version\'s metadata, release notes included, destroying edits made directly in App Store Connect. No undo',
  submit_for_review: 'Submit this build to Apple for review — occupies the review slot, and an in-progress review blocks the next submission until it clears',
  cancel_submission_review: 'Cancel the Apple review in progress — throws away the review slot; re-submitting starts Apple\'s queue over',
  update_submission_build: 'Swap the build attached to this production submission — this re-prepares the store version and force-pushes the release\'s stored metadata over it',
  fully_release_previous_rollout: 'Complete the PREVIOUS release\'s staged rollout to 100% of users so this submission can proceed — irreversible, and it acts on the release already in production',
  // Store rollouts
  start_rollout: 'Start the rollout — the first stage goes out to real users, and on a NON-staged rollout this releases to 100% immediately (the label says which)',
  fully_release_rollout: 'Release this rollout to 100% of users immediately — irreversible, a rollout cannot be narrowed back down',
  halt_rollout: 'Halt this rollout (emergency stop; resumable) — on App Store this delists the app from the store rather than pausing a phase',
  enable_automatic_rollout: 'Hand stage advances to a scheduler that increases the rollout every 24h, unattended, until 100% — and manual increases are refused while it is on',
  increase_rollout: 'Advance the staged rollout to its next stage — more real users get this build, and advancing the final stage completes the rollout at 100%',
  pause_rollout: 'Pause the staged rollout (Play Store: only has an effect on an automatic rollout — on a manual one Tramline reports success and changes nothing)',
  resume_rollout: 'Resume a paused or halted rollout — if a human halted it, this undoes that',
  disable_automatic_rollout: 'Stop automatic stage progression, returning the rollout to manual control',
};

/** Something that looks like one of Tramline's record ids. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeRecordId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Pull the target references out of a call's arguments.
 *
 * Keyed on the argument *name* (`id`, `release_id`, `build_id`), not on the
 * value's shape. Matching UUIDs alone left a hole: Tramline accepts `release_id`
 * as "UUID **or slug**", so an agent could address a release as
 * `2026-08-03-thrumming-brook`, match no UUID, and skip the label requirement
 * entirely — which is every release-level action. `app_slug` / `train_slug` are
 * not target references: they are already human-readable and name a
 * configuration, not a record.
 */
export function targetRefsIn(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  return Object.entries(input as Record<string, unknown>)
    .filter(([key]) => key === 'id' || key.endsWith('_id'))
    .map(([, value]) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

/**
 * Neutralize a model-supplied argument value for a Slack `mrkdwn` block.
 *
 * Argument values are the one part of the prompt the agent controls, and without
 * this they are the hole in "rendered by us, not by the agent": a string
 * argument can carry newlines and `*bold*` and append its own lines to the
 * message — `custom_source_branch: "main\n*Note:* pre-agreed, safe to approve"`
 * renders as an extra instruction to the approver. Collapse whitespace, strip
 * the mrkdwn and Block Kit sigils, cap the length, and wrap in a code span so
 * whatever survives reads as data.
 */
function sanitizeArgumentValue(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const flat = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`*_~<>|]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const capped = flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
  return `\`${capped}\``;
}

/** Argument list rendered for the prompt, minus the ids the label covers. */
function renderArguments(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const parts = Object.entries(input as Record<string, unknown>)
    .filter(([k, v]) => v !== undefined && v !== null && k !== 'id' && !k.endsWith('_id'))
    .map(([k, v]) => `${k}=${sanitizeArgumentValue(v)}`);
  return parts.join(', ');
}

export interface RenderedAction {
  /** One-line consequence, for the Slack prompt and the audit finding. */
  summary: string;
  /** Human label of the target, when the call addresses one by id. */
  target?: string;
}

/** Why a gated call could not be turned into an approval prompt. */
export type RenderFailure = 'no-description' | 'unlabelled-target';

/**
 * Build the approval text for a gated call, or say why it cannot be built.
 *
 * Both failure modes end in a refusal rather than a prompt, and both are
 * deliberate:
 *
 * - `no-description` — the action has no entry in `ACTION_DESCRIPTIONS`, so
 *   nobody has written down what it does. A button labelled with a method name
 *   is a button approved without understanding.
 * - `unlabelled-target` — the call addresses a record this task has not read,
 *   so the prompt cannot say what it is about. Approving an opaque uuid is
 *   approving the agent's word for what it points at.
 */
export function renderAction(
  toolName: string,
  input: unknown,
  targets: Record<string, string> | undefined,
): RenderedAction | RenderFailure {
  const action = tramlineAction(toolName);
  const described = ACTION_DESCRIPTIONS[action];
  if (!described) return 'no-description';

  const labels: string[] = [];
  for (const ref of targetRefsIn(input)) {
    const label = targets?.[ref];
    if (!label) return 'unlabelled-target';
    labels.push(label);
  }

  const args = renderArguments(input);
  const target = labels.length > 0 ? labels.join(' · ') : undefined;

  let summary = described;
  if (target) summary += `\n*Target:* ${target}`;
  if (args) summary += `\n*Arguments:* ${args}`;

  return { summary, target };
}

export function isRenderFailure(value: RenderedAction | RenderFailure): value is RenderFailure {
  return typeof value === 'string';
}

// ---- Target index (PostToolUse) ----------------------------------------------

interface Node {
  id?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Payload key → what the records under it are.
 *
 * These keys are the **actual** `Api::V2::*Serializer` output of
 * `GET /api/v2/releases/:id`, not Tramline's domain model. The first version of
 * this map was written from the domain model and shared almost no keys with the
 * API, which silently produced unlabelled and mislabelled approval prompts — the
 * failure mode that matters most, because the prompt is the whole safety
 * property. The fixture in `__tests__/fixtures/tramline-release-payload.json` is
 * generated from the serializers so that mistake cannot recur quietly.
 */
const KIND_BY_KEY: Record<string, string> = {
  release: 'release',
  platform_runs: 'platform run',
  latest_internal_release: 'internal release',
  latest_beta_release: 'beta release',
  production_releases: 'production release',
  build: 'build',
  workflow_run: 'CI workflow run',
  store_submissions: 'store submission',
  store_submission: 'store submission',
  store_rollout: 'staged rollout',
};

/**
 * The detail that distinguishes two records of the same kind, so an approver can
 * tell *which* one the button is about.
 *
 * Without this, a cross-platform release's two failed RC workflow runs render
 * identically and the prompt is unanswerable on the one flow this feature exists
 * for. Percentages matter for the same reason: on a rollout action the number
 * *is* the decision, and it is sitting in the payload.
 */
function distinguishingDetail(kind: string, obj: Node): string | undefined {
  switch (kind) {
    case 'build':
      return str(obj.build_number) ? `build ${str(obj.build_number)}` : undefined;
    case 'CI workflow run': {
      const workflowKind = str(obj.kind)?.replace(/_/g, ' ');
      const number = num(obj.external_number) ?? str(obj.external_number);
      return [workflowKind, number !== undefined ? `#${number}` : undefined].filter(Boolean).join(' ') || undefined;
    }
    case 'store submission':
      // "PlayStoreSubmission" → "Play Store", "AppStoreSubmission" → "App Store"
      return str(obj.kind)?.replace(/Submission$/, '').replace(/([a-z])([A-Z])/g, '$1 $2') || undefined;
    case 'staged rollout': {
      const current = num(obj.current_percentage);
      const next = num(obj.next_percentage);
      const stage = num(obj.stage);
      const stageCount = num(obj.stage_count);
      const parts: string[] = [];
      // "not staged" is load-bearing: starting a non-staged Play rollout goes to
      // 100% immediately, and this label is what the approver decides from.
      if (obj.is_staged_rollout === false) parts.push('not staged');
      if (current !== undefined) parts.push(`at ${current}%`);
      if (next !== undefined) parts.push(`next ${next}%`);
      if (stage !== undefined && stageCount !== undefined) parts.push(`stage ${stage}/${stageCount}`);
      if (obj.automatic_rollout === true) parts.push('automatic');
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Walk a Tramline read payload and label every record id in it.
 *
 * Context (version + platform) is **inherited downward and never replaced**: a
 * build carries its own `version_name`, and letting that overwrite the
 * platform run's "253.0.0 ANDROID" was what dropped the platform from every
 * nested label. A child may only *fill* a context slot its ancestors left empty.
 *
 * The walk is defensive about shape: a payload change should degrade to fewer
 * labels — and therefore to *denied* gated calls — never to a thrown hook.
 */
export function indexTargets(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};

  const walk = (node: unknown, version: string | undefined, platform: string | undefined, kind: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, version, platform, kind);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Node;

    // Fill-only, never overwrite. `version` is the release's key; platform runs
    // use `release_version`; builds use `version_name` and are the reason this
    // must not clobber.
    const nextVersion = version ?? str(obj.version) ?? str(obj.release_version) ?? str(obj.version_name);
    const nextPlatform = platform ?? str(obj.platform)?.toUpperCase();

    const id = str(obj.id);
    if (id && UUID_RE.test(id)) {
      const status = str(obj.status);
      const label = [
        [nextVersion, nextPlatform].filter(Boolean).join(' ') || undefined,
        kind,
        distinguishingDetail(kind, obj),
        status ? `(${status})` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      out[id] = label;
      // Release-level actions accept `release_id` as a UUID *or* a slug, so index
      // the slug under the same label — otherwise addressing a release by slug
      // sidesteps the "must have read it" requirement entirely.
      const slug = str(obj.slug);
      if (slug) out[slug] = label;
    }

    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== 'object') continue;
      // An unmapped key keeps the parent's kind rather than inventing one — but
      // it is also the signal that the payload has grown a shape we don't know.
      walk(value, nextVersion, nextPlatform, KIND_BY_KEY[key] ?? kind);
    }
  };

  walk(payload, undefined, undefined, 'release');
  return out;
}

/** Merge fresh labels into an existing index, newest-wins, oldest evicted. */
export function mergeTargets(
  existing: Record<string, string> | undefined,
  fresh: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...(existing ?? {}) };
  for (const [id, label] of Object.entries(fresh)) {
    delete merged[id]; // re-insert so recency drives eviction order
    merged[id] = label;
  }
  const keys = Object.keys(merged);
  if (keys.length <= TARGET_INDEX_LIMIT) return merged;
  for (const key of keys.slice(0, keys.length - TARGET_INDEX_LIMIT)) delete merged[key];
  return merged;
}

// ---- Approver authorization --------------------------------------------------

/**
 * Slack user ids allowed to approve a Tramline action, from
 * `ARCHIE_RELEASE_APPROVERS` (comma-separated).
 *
 * Unset means nobody can approve, and in that case the guard refuses a gated
 * call outright rather than posting a prompt — see `createTramlineGuardHooks`.
 * Posting an unresolvable button *and* parking the task would leave a dead
 * thread and be strictly worse than the read-only status quo, which is the
 * opposite of what an unconfigured deployment should do.
 *
 * Note the existing edit-mode and merge gates do *not* check the clicker at all
 * — this one does, because these buttons move a live release.
 */
export function releaseApprovers(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.ARCHIE_RELEASE_APPROVERS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function canApproveReleaseAction(
  userId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!userId) return false;
  return releaseApprovers(env).has(userId);
}

// ---- Hook wiring -------------------------------------------------------------

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

/** Fresh object per call — the SDK receives these and a shared mutable literal
 *  handed out on every hook invocation is an accident waiting to happen. */
function proceed(): HookJSONOutput {
  return { continue: true };
}

/**
 * What the guard needs from the task. Kept as a narrow port rather than
 * importing Task, so the classification and rendering above stay unit-testable
 * without a task on disk (and so this module doesn't join the task ↔ agent
 * import cycle).
 */
export interface TramlineGuardPort {
  /** The task's id→label index, for rendering. */
  getTargets(): Record<string, string> | undefined;
  /** Fold fresh labels from a read response into the index. */
  recordTargets(fresh: Record<string, string>): void;
  /**
   * Spend a stored approval for this digest. Returns true when one was found,
   * unexpired, and consumed — false otherwise. Must consume synchronously so a
   * repeated call cannot spend the same approval twice.
   */
  consumeApproval(digest: string): boolean;
  /**
   * Post the Slack approval and park the task. Returns `'posted'`, or
   * `'already-pending'` when a different request is outstanding (one at a
   * time — a queue of pending release actions is its own hazard).
   */
  requestApproval(request: {
    digest: string;
    tool: string;
    summary: string;
    target?: string;
  }): Promise<'posted' | 'already-pending'>;
}

/**
 * PreToolUse hooks enforcing the Tramline action gate.
 *
 * Returns a single matcher (no `matcher` field → fires on all tools) that
 * filters by tool name inside the callback, mirroring
 * `createFilesystemGuardHooks`.
 */
export function createTramlineGuardHooks(port: TramlineGuardPort): HookCallbackMatcher[] {
  return [{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks: [async (input: any): Promise<HookJSONOutput> => {
      const toolName = typeof input?.tool_name === 'string' ? input.tool_name : undefined;
      // Classify before the try, so a throw can be attributed: a non-Tramline
      // tool must proceed even if something below would have failed, and a
      // Tramline write must be denied rather than left to the SDK's handling of
      // a rejected hook.
      const disposition = toolName ? classifyTramlineTool(toolName) : 'not-tramline';
      if (disposition !== 'gated') {
        return proceed();
      }

      try {
        return await decideTramlineCall(port, toolName!, input.tool_input);
      } catch (error) {
        // Fail closed. The arguments are agent-controlled, so this path is
        // reachable on purpose as well as by accident (a deeply nested argument
        // overflows the canonicalizer's recursion), and a security hook must not
        // depend on how the host treats a rejected hook.
        const message = error instanceof Error ? error.message : String(error);
        logger.error('tramline-guard', `Guard failed for ${toolName} — denying`, error);
        return deny(
          `\`${tramlineAction(toolName!)}\` was refused because the approval gate errored while evaluating it ` +
          `(${message}). Nothing ran. Report this and let a human act in Tramline (https://tramline.sweatco.team).`,
        );
      }
    }],
  }];
}

/** The gate's decision for one Tramline write. Separated so the wrapper above can
 *  turn any throw into a denial. */
async function decideTramlineCall(
  port: TramlineGuardPort,
  tool_name: string,
  tool_input: unknown,
): Promise<HookJSONOutput> {
  const action = tramlineAction(tool_name);
  const digest = actionDigest(tool_name, tool_input);

  // Already approved? Spend it and let this one call through.
  if (port.consumeApproval(digest)) {
    logger.system(`Tramline action ${action} approved (${digest}) — proceeding`);
    return proceed();
  }

  const targets = port.getTargets();
  const rendered = renderAction(tool_name, tool_input, targets);
  if (isRenderFailure(rendered)) {
    return deny(
      rendered === 'no-description'
        ? `\`${action}\` has no approval description registered in Archie, so there is no way to tell a human ` +
          `what approving it would do. It is refused until someone adds one. Report that you wanted to run it ` +
          `and why, and let a human act in Tramline (https://tramline.sweatco.team).`
        : `Cannot request approval for \`${action}\`: this task has not read the record it targets, so the ` +
          `approval prompt cannot say what it is about. Call \`get_release\` for the release this belongs to ` +
          `first, then retry.`,
    );
  }

  // No approver configured: refuse instead of posting a button nobody can
  // press and parking the task on it. An unconfigured deployment must be no
  // worse than the read-only status quo, not worse than it.
  const approvers = releaseApprovers();
  if (approvers.size === 0) {
    return deny(
      `\`${action}\` needs human approval, but no release approvers are configured on this Archie deployment ` +
      `(ARCHIE_RELEASE_APPROVERS is unset), so nobody could resolve the request. Nothing was posted. ` +
      `Report what you would have done and let a human act in Tramline (https://tramline.sweatco.team).`,
    );
  }

  const outcome = await port.requestApproval({
    digest,
    tool: action,
    summary: rendered.summary,
    target: rendered.target,
  });

  if (outcome === 'already-pending') {
    return deny(
      `Another Tramline action is already waiting for approval on this task. One release action is ` +
      `resolved at a time — wait for the outstanding request to be approved or denied.`,
    );
  }

  return deny(
    `\`${action}\` needs human approval. The request has been posted and the task is pausing. ` +
    `When it is approved you will be reactivated — re-read the release state, then retry this exact call.`,
  );
}

/**
 * PostToolUse hook that indexes ids from Tramline read responses so the
 * approval prompt can name its target.
 */
export function createTramlineContextHook(port: Pick<TramlineGuardPort, 'recordTargets'>): HookCallbackMatcher {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks: [async (input: any): Promise<HookJSONOutput> => {
      const { tool_name, tool_response } = input ?? {};
      if (typeof tool_name !== 'string' || classifyTramlineTool(tool_name) !== 'read') return proceed();

      try {
        const payload = extractPayload(tool_response);
        if (payload !== undefined) port.recordTargets(indexTargets(payload));
      } catch (error) {
        // A labelling failure must never break the agent's read. It degrades to
        // a denied gated call, which is the safe direction.
        logger.warn('tramline-guard', 'Failed to index Tramline read response', error);
      }
      return proceed();
    }],
  };
}

/**
 * Dig the JSON payload out of an MCP tool response.
 *
 * Deliberately shape-agnostic, because the repo does not agree with itself about
 * what a PostToolUse `tool_response` looks like for an MCP tool: this module was
 * written for `{ content: [{ type: 'text', text: '<json>' }] }` (what the
 * Tramline server returns), while `createResearchPostToolHook` in
 * `src/mcp/research-tools.ts` assumes a **bare array of content blocks**. Both
 * are untested against the live SDK, and getting it wrong here is not a graceful
 * degradation: zero labels means every gated call is refused with "call
 * get_release first", and the agent loops on a read that can never satisfy it.
 *
 * So handle every plausible shape rather than betting on one.
 */
export function extractPayload(response: unknown): unknown {
  if (response === null || response === undefined) return undefined;
  if (typeof response === 'string') return safeParse(response);
  if (typeof response !== 'object') return undefined;

  // Bare array of content blocks (research-tools' assumption).
  if (Array.isArray(response)) return fromContentBlocks(response);

  // `{ content: [...] }` envelope (what the Tramline MCP server returns).
  const content = (response as { content?: unknown }).content;
  if (Array.isArray(content)) return fromContentBlocks(content);

  // Some hosts hand back `{ text: '<json>' }` or the parsed object itself.
  const text = (response as { text?: unknown }).text;
  if (typeof text === 'string') return safeParse(text);

  return response;
}

/** Parse the JSON out of a list of MCP content blocks. */
function fromContentBlocks(blocks: unknown[]): unknown {
  const parsed = blocks
    .map((part) => {
      if (typeof part === 'string') return safeParse(part);
      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') return safeParse(text);
      }
      return undefined;
    })
    .filter((value) => value !== undefined);
  if (parsed.length === 0) return undefined;
  return parsed.length === 1 ? parsed[0] : parsed;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
