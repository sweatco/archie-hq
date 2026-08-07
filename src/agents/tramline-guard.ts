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
 * 1. `createTramlineGuardHooks()` — PreToolUse. Classifies each
 *    `mcp__tramline__*` call into read / auto-allowed / gated / never-allowed.
 *    A gated call is denied, and a Slack approval carrying the *rendered*
 *    action is posted; the task parks. Once a human approves, the approval is
 *    stored against a digest of `(tool, arguments)` and the agent's retry of
 *    that exact call passes once.
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

/**
 * Writes that only mirror state Tramline can already observe elsewhere: two CI
 * status polls and a store re-read. They advance a state machine no further
 * than the external system has already moved it, and they are idempotent.
 *
 * They are ungated because gating them would make the gate worthless — a single
 * diagnosis needs several of these, and an approval prompt a human learns to
 * click through without reading is worse than no prompt at all.
 */
const AUTO_ALLOWED_ACTIONS = new Set([
  'poll_workflow_run_status',
  'fetch_workflow_run_status',
  'sync_submission_from_store',
]);

/**
 * Actions no approval can unlock.
 *
 * Not "most dangerous" — *wrongly shaped for a chat button*. Each one is
 * irreversible and needs the operator looking at the rollout page, the health
 * metrics, or App Store Connect while they decide. A Slack button invites the
 * decision to be made from a phone, on the strength of a one-line summary. So
 * the agent's job for these is to say what it thinks should happen and let a
 * human go and do it in Tramline.
 *
 * These are also absent from the agent's tool list (`disallowedTools` in
 * release-manager.md). This set is the second layer: it holds even if an agent
 * is configured with the tools by mistake.
 */
const NEVER_ALLOWED_ACTIONS = new Set([
  'fully_release_rollout',
  'halt_rollout',
  'fully_release_previous_rollout',
  'prepare_submission',
  'cancel_submission_review',
]);

export type TramlineDisposition = 'not-tramline' | 'read' | 'auto' | 'gated' | 'never';

/** Classify a tool call. `toolName` is the full MCP name. */
export function classifyTramlineTool(toolName: string): TramlineDisposition {
  if (!toolName.startsWith(TOOL_PREFIX)) return 'not-tramline';
  const action = toolName.slice(TOOL_PREFIX.length);
  if (READ_ACTIONS.has(action)) return 'read';
  if (NEVER_ALLOWED_ACTIONS.has(action)) return 'never';
  if (AUTO_ALLOWED_ACTIONS.has(action)) return 'auto';
  return 'gated';
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
 */
const ACTION_DESCRIPTIONS: Record<string, string> = {
  // Release lifecycle
  start_release: 'Start a new release — cuts the release branch, bumps versions and starts CI',
  stop_release: 'Stop this release entirely (terminal)',
  retry_pre_release: 'Retry the failed pre-release phase (branch creation, version bump)',
  retry_preparation: 'Retry the failed preparation workflow',
  trigger_preparation: 'Trigger the preparation workflow now',
  sync_release_commits: 'Re-process the release branch commits — this can push a version-bump commit, apply the build queue and open backmerge PRs',
  sync_release_pull_requests: 'Re-check the release PRs — on a failed post-release this finalizes the release (tag + backmerge)',
  complete_release: 'Finalize the release: tag it and run the end-of-release backmerge',
  finish_release: 'Finish a partially-finished release, stopping the platforms still pending',
  apply_build_queue: 'Flush the queued commits into the release — changes what is being shipped',
  end_soak: 'End the beta soak early, skipping the rest of the observation window',
  extend_soak: 'Extend the beta soak period',
  // Platform runs
  start_internal_release: 'Create an internal build for the team',
  start_beta_release: 'Create a release-candidate build for testers',
  start_production_release: 'Start the production release with a specific build — decides which binary goes to the store',
  conclude_platform_run: 'Conclude this platform, closing it out of the release',
  // Workflow runs
  trigger_workflow_run: 'Trigger this CI workflow run',
  retry_workflow_run: 'Re-run this failed CI build',
  // Store submissions
  trigger_submission: 'Send this submission to the store',
  retry_submission: 'Retry this failed store submission',
  submit_for_review: 'Submit to Apple for review',
  update_submission_build: 'Swap the build attached to this production submission',
  // Store rollouts
  start_rollout: 'Start the staged rollout',
  increase_rollout: 'Advance the staged rollout to its next stage — more real users get this build',
  pause_rollout: 'Pause the staged rollout',
  resume_rollout: 'Resume the staged rollout',
  enable_automatic_rollout: 'Hand stage advances to the scheduler — the next stage goes out automatically, 24h from now',
  disable_automatic_rollout: 'Stop automatic stage progression',
};

/** Something that looks like one of Tramline's record ids. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeRecordId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Pull the record ids out of a call's arguments. Tools addressing a resource by
 * UUID need a label from the index; tools addressing it by slug (start_release
 * takes app + train slugs) are already readable.
 */
export function recordIdsIn(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  return Object.values(input as Record<string, unknown>).filter(looksLikeRecordId);
}

/** Argument list rendered for the prompt, minus the ids the label covers. */
function renderArguments(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const parts = Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && !looksLikeRecordId(v))
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.join(', ');
}

export interface RenderedAction {
  /** One-line consequence, for the Slack prompt and the audit finding. */
  summary: string;
  /** Human label of the target, when the call addresses one by id. */
  target?: string;
}

/**
 * Build the approval text for a gated call.
 *
 * Returns `undefined` when the call addresses a record by id that this task has
 * not read — the caller denies instead of posting an unlabelled button.
 */
export function renderAction(
  toolName: string,
  input: unknown,
  targets: Record<string, string> | undefined,
): RenderedAction | undefined {
  const action = tramlineAction(toolName);
  const described = ACTION_DESCRIPTIONS[action];
  const ids = recordIdsIn(input);

  const labels: string[] = [];
  for (const id of ids) {
    const label = targets?.[id];
    // No label — refuse to render. Approving an opaque uuid is approving the
    // agent's word for what it points at.
    if (!label) return undefined;
    labels.push(label);
  }

  const args = renderArguments(input);
  const head = described ?? `Run the Tramline action \`${action}\``;
  const target = labels.length > 0 ? labels.join(' · ') : undefined;

  let summary = head;
  if (target) summary += `\n*Target:* ${target}`;
  if (args) summary += `\n*Arguments:* ${args}`;

  return { summary, target };
}

// ---- Target index (PostToolUse) ----------------------------------------------

interface ReleaseLike {
  id?: unknown;
  version_name?: unknown;
  release_version?: unknown;
  platform?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Walk a Tramline read payload and label every record id in it.
 *
 * The labels are deliberately coarse — "253.0.0 iOS · store submission
 * (failed)" is enough for a human to recognise what a button is about, and it
 * carries the state they need to sanity-check the request. The walk is
 * defensive about shape: a payload change should degrade to fewer labels (and
 * so to denied gated calls), never to a thrown hook.
 */
export function indexTargets(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};

  const walk = (node: unknown, context: string, kind: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, context, kind);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as ReleaseLike;

    // A release (or platform run) refines the context every id below inherits.
    const version = str(obj.release_version) ?? str(obj.version_name);
    const platform = str(obj.platform);
    let nextContext = context;
    if (version || platform) {
      nextContext = [version ?? context, platform ? platform.toUpperCase() : undefined]
        .filter(Boolean)
        .join(' ');
    }

    const id = str(obj.id);
    if (id && UUID_RE.test(id)) {
      const status = str(obj.status);
      const label = [nextContext || undefined, kind, status ? `(${status})` : undefined]
        .filter(Boolean)
        .join(' · ');
      out[id] = label || kind;
    }

    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== 'object') continue;
      walk(value, nextContext, KIND_BY_KEY[key] ?? kind);
    }
  };

  walk(payload, '', 'release');
  return out;
}

/** Payload key → what the records under it are, for labelling. */
const KIND_BY_KEY: Record<string, string> = {
  release: 'release',
  releases: 'release',
  platform_runs: 'platform run',
  release_platform_runs: 'platform run',
  builds: 'build',
  workflow_runs: 'CI workflow run',
  workflow_run: 'CI workflow run',
  pre_prod_releases: 'internal/beta release',
  production_releases: 'production release',
  production_release: 'production release',
  store_submissions: 'store submission',
  store_submission: 'store submission',
  store_rollout: 'staged rollout',
  store_rollouts: 'staged rollout',
};

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
 * Unset means nobody can approve. That is the intended failure mode: an
 * unconfigured deployment behaves exactly as it does today (Archie reads,
 * humans act), rather than letting anyone who can see the message press the
 * button. Note the existing edit-mode and merge gates do *not* check the
 * clicker at all — this one does, because these buttons move a release.
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

const CONTINUE: HookJSONOutput = { continue: true };

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
      const { tool_name, tool_input } = input ?? {};
      if (typeof tool_name !== 'string') return CONTINUE;

      const disposition = classifyTramlineTool(tool_name);
      if (disposition === 'not-tramline' || disposition === 'read' || disposition === 'auto') {
        return CONTINUE;
      }

      const action = tramlineAction(tool_name);

      if (disposition === 'never') {
        return deny(
          `\`${action}\` is not available to agents — it is irreversible and has to be done by a human ` +
          `looking at the release page in Tramline (https://tramline.sweatco.team). ` +
          `Report what you think should happen and who should do it; do not look for another route to the same effect.`,
        );
      }

      const digest = actionDigest(tool_name, tool_input);

      // Already approved? Spend it and let this one call through.
      if (port.consumeApproval(digest)) {
        logger.system(`Tramline action ${action} approved (${digest}) — proceeding`);
        return CONTINUE;
      }

      const rendered = renderAction(tool_name, tool_input, port.getTargets());
      if (!rendered) {
        return deny(
          `Cannot request approval for \`${action}\`: this task has not read the record it targets, so the ` +
          `approval prompt cannot say what it is about. Call \`get_release\` for the release this belongs to ` +
          `first, then retry.`,
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
    }],
  }];
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
      if (typeof tool_name !== 'string' || classifyTramlineTool(tool_name) !== 'read') return CONTINUE;

      try {
        const payload = extractPayload(tool_response);
        if (payload !== undefined) port.recordTargets(indexTargets(payload));
      } catch (error) {
        // A labelling failure must never break the agent's read. It degrades to
        // a denied gated call, which is the safe direction.
        logger.warn('tramline-guard', 'Failed to index Tramline read response', error);
      }
      return CONTINUE;
    }],
  };
}

/**
 * Dig the JSON payload out of an MCP tool response. The Tramline server returns
 * `{ content: [{ type: 'text', text: '<json>' }] }`; be tolerant of the
 * response arriving already-parsed.
 */
export function extractPayload(response: unknown): unknown {
  if (response === null || response === undefined) return undefined;
  if (typeof response === 'string') return safeParse(response);
  if (typeof response !== 'object') return undefined;

  const content = (response as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part) => (part && typeof part === 'object' ? (part as { text?: unknown }).text : undefined))
      .filter((text): text is string => typeof text === 'string');
    const parsed = texts.map(safeParse).filter((value) => value !== undefined);
    if (parsed.length === 1) return parsed[0];
    if (parsed.length > 1) return parsed;
    return undefined;
  }
  return response;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
