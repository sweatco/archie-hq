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

/**
 * The only write that stays ungated: polling a CI run that is already in flight.
 *
 * Note what this does *not* claim. `poll_workflow_run_status` is not
 * side-effect-free — on a `triggered` run it calls `workflow_run.found!`, which
 * enqueues a poll that can attach a build and trigger store submissions. It is
 * ungated because that is the same progression Tramline's own poller performs
 * unprompted: the run is live, CI has already decided, and the call only pulls
 * that decision forward. Contrast `fetch_workflow_run_status`, which resurrects a
 * run Tramline had already marked **failed** — a state change nothing else would
 * have made.
 *
 * This set was originally three. The other two were removed after reading what
 * they actually do on the Tramline side, and the deletions are the point of the
 * comment — "sounds like a read" is not evidence:
 *
 * - `fetch_workflow_run_status` calls `workflow_run.found!`, which transitions
 *   **failed → started** and enqueues a poll; when that poll settles it
 *   cascades AttachBuildJob → TriggerSubmissionsJob, which calls
 *   `trigger_submissions!` and, for a hotfix release candidate,
 *   `Coordinators::StartProductionRelease`. An ungated call could start a
 *   production release.
 * - `sync_submission_from_store` drives `approve!` / `submit_for_review!` /
 *   `reject!` / `sync_rollout!`, and App Store rollouts are created with
 *   `automatic_rollout: true` — so a "re-read" can put a user-facing rollout on
 *   an auto-advancing schedule.
 *
 * Keeping this set as small as the evidence supports costs the agent an
 * approval per diagnosis step. That is the right trade: an approval prompt a
 * human learns to click through without reading is worse than no prompt, but a
 * tool wrongly labelled safe is worse than both.
 */
const AUTO_ALLOWED_ACTIONS = new Set([
  'poll_workflow_run_status',
]);

/**
 * Actions no approval can unlock.
 *
 * The list is closed under **effect**, not under name. That distinction is the
 * whole design: a gate that reasons about tool names is trivially laundered by
 * a differently-named tool reaching the same Tramline code path, and the first
 * version of this list was. Each entry below is here because of what it does,
 * and the ones that read as surprising are the ones that were laundering an
 * entry above them:
 *
 * - `fully_release_rollout` — 100% of users, irreversible.
 * - `enable_automatic_rollout` — schedules `AutomaticUpdateRolloutJob`, which
 *   increases the rollout and *re-schedules itself* every 24h until the last
 *   stage completes. One click reaches the same end state as
 *   `fully_release_rollout` with no human present for any stage after the
 *   first, and it then refuses manual control ("cannot manually increase
 *   rollout when automatic rollout is enabled").
 * - `halt_rollout` — on App Store this delists the app rather than pausing a
 *   phase. (Reversible in principle; that was never the reason.)
 * - `fully_release_previous_rollout` — pushes a *different*, already-shipped
 *   release to 100%.
 * - `prepare_submission` — re-preparing force-overwrites the store version's
 *   metadata, release notes included, destroying edits made in App Store
 *   Connect. No undo.
 * - `update_submission_build` — routes into `UpdateBuildOnProduction`, whose
 *   own comment says it "re-prepares the store version and force-pushes the
 *   release's stored metadata". Same effect as the entry above it.
 * - `submit_for_review` — hands the build to Apple. Its only exit,
 *   `cancel_submission_review`, is also on this list, and an in-progress ASC
 *   review is what blocks the *next* submission — so allowing submit while
 *   denying cancel would let the agent manufacture the exact incident class
 *   this feature was built to triage. Both or neither; neither.
 * - `cancel_submission_review` — throws away a review slot; re-submitting
 *   restarts Apple's queue.
 * - `start_release` / `stop_release` — `start_release` cuts a branch, bumps
 *   versions, opens kickoff PRs and starts CI; `stop_release` is terminal and
 *   unwinds none of it. Neither has an inverse in the API.
 *
 * `increase_rollout` is deliberately *not* here — advancing 1% → 2% is the
 * routine operation this feature exists to make possible. It is refused only at
 * the terminal stage, where it is `fully_release_rollout` by another name; see
 * `terminalStageRefusal`.
 *
 * These are also absent from the agent's tool list (`disallowedTools` in
 * release-manager.md). This set is the second layer: it holds even if an agent
 * is configured with the tools by mistake.
 */
const NEVER_ALLOWED_ACTIONS = new Set([
  'fully_release_rollout',
  'enable_automatic_rollout',
  'halt_rollout',
  'fully_release_previous_rollout',
  'prepare_submission',
  'update_submission_build',
  'submit_for_review',
  'cancel_submission_review',
  'start_release',
  'stop_release',
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
 *
 * **This map is the gate's allowlist**, not decoration: an action with no entry
 * is refused rather than rendered as a bare method name. That is what makes
 * "defaults to gated" mean "defaults to *refused*" — otherwise a future
 * Tramline action arrives as a one-click button labelled `Run the Tramline
 * action \`x\``, with no statement of consequence for the approver to weigh.
 * Adding an action here is therefore a deliberate review step: whoever writes
 * the sentence has to know what the action does, which is exactly the moment to
 * notice it belongs on the never-list instead.
 */
const ACTION_DESCRIPTIONS: Record<string, string> = {
  // Release lifecycle
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
  fetch_workflow_run_status: 'Re-check a workflow run that could not be found on the CI provider — this moves it out of `failed`, and if CI reports success it attaches the build and triggers store submissions (on a hotfix RC it starts the production release)',
  // Store submissions
  trigger_submission: 'Send this submission to the store — on a production App Store submission this prepares the store version, which overwrites its metadata',
  retry_submission: 'Retry this failed store submission — if it failed before it was ever prepared, this re-prepares the store version and overwrites its metadata',
  sync_submission_from_store: 'Pull this submission\'s state from the store — this can advance it (approve/reject/submit) and can put an App Store rollout on an automatic schedule',
  // Store rollouts
  start_rollout: 'Start the staged rollout — the first stage goes out to real users',
  increase_rollout: 'Advance the staged rollout to its next stage — more real users get this build',
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
      // "not staged" is load-bearing, not colour: starting a non-staged Play
      // rollout goes to 100% immediately (see stateRefusal).
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

const IN_TRAMLINE = 'A human has to do this on the release page in Tramline (https://tramline.sweatco.team).';

/**
 * Refuse an action that is only forbidden *in a particular state*.
 *
 * Classification by tool name cannot express these: the same tool is routine in
 * one state and equivalent to a never-listed action in another. Both cases below
 * reach 100% of users, which is the one outcome the never-list exists to
 * prevent, so both are refused rather than made approvable.
 *
 * - `increase_rollout` at the final stage: `move_to_next_stage!` rolls out the
 *   last percentage and calls `complete!` — it *is* `fully_release_rollout`.
 * - `start_rollout` on a **non-staged** rollout: `start_release!` skips the
 *   stages entirely and calls `rollout(FULL_ROLLOUT_VALUE)` — 100% immediately.
 *
 * State comes from the label index, which is the only state this process has. A
 * rollout whose relevant field we cannot read is refused too: guessing in the
 * permissive direction is exactly the mistake this function exists to prevent.
 */
export function stateRefusal(action: string, label: string | undefined): string | undefined {
  if (!label) return undefined; // no label ⇒ the caller already refuses

  if (action === 'start_rollout') {
    if (/not staged/.test(label)) {
      return `This rollout is not staged, so starting it releases to 100% of users immediately — the same ` +
        `irreversible effect as \`fully_release_rollout\`, which is not available to agents. ${IN_TRAMLINE}`;
    }
    if (!/stage \d+\/\d+/.test(label)) {
      return `Cannot start this rollout: the release payload this task has read does not say whether it is staged, ` +
        `so there is no way to tell if starting it would go straight to 100%. Re-read with \`get_release\` and retry.`;
    }
    return undefined;
  }

  if (action !== 'increase_rollout') return undefined;

  const stage = /stage (\d+)\/(\d+)/.exec(label);
  if (!stage) {
    return `Cannot advance this rollout: its stage is not visible in the release payload this task has read, ` +
      `so there is no way to tell whether the next stage is 100%. Re-read the release with \`get_release\` and retry.`;
  }
  const [, currentRaw, totalRaw] = stage;
  if (Number(currentRaw) >= Number(totalRaw)) {
    return `Advancing this rollout would take it to its final stage, which completes the rollout at 100% of users — ` +
      `the same irreversible effect as \`fully_release_rollout\`, which is not available to agents. ${IN_TRAMLINE}`;
  }
  return undefined;
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
      if (disposition === 'not-tramline' || disposition === 'read' || disposition === 'auto') {
        return proceed();
      }

      try {
        return await decideTramlineCall(port, toolName!, input.tool_input, disposition);
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
  disposition: TramlineDisposition,
): Promise<HookJSONOutput> {
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

  // Some actions are only forbidden in a particular state — `increase_rollout`
  // at the final stage is `fully_release_rollout` under another name.
  const refusal = stateRefusal(action, rendered.target);
  if (refusal) return deny(refusal);

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
