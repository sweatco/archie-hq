/**
 * Task-related type definitions
 */

export type TaskStatus = 'in_progress' | 'stopped' | 'completed';

/** Core agent names - repo agents can be any string ending in '-agent' */
export type CoreAgentName = 'pm-agent' | 'triage-agent';

/** Agent name - core agents or any repo agent (e.g., 'backend-agent', 'mobile-agent', 'web-agent') */
export type AgentName = CoreAgentName | `${string}-agent`;

export type FindingType = 'discovery' | 'decision' | 'completion' | 'blocker' | 'artifact';

/** Tracking record for a Slack thread linked to a task */
export interface SlackThreadRef {
  thread_id: string;
  channel_id: string;
  last_processed_ts: string;
}

/**
 * Resolved Slack user info attached to a message or an attachment.
 *
 * Carries everything needed to classify the user (home-team membership,
 * guest status) without a second lookup. Use `isExternalUser` from the Slack
 * client to evaluate.
 */
export interface SlackAuthor {
  id: string;
  username: string;     // @handle
  realName: string;     // Full display name
  teamId?: string;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
}

/** An emoji reaction present on a Slack message (snapshot at fetch time). */
export interface SlackReaction {
  /** Emoji shortcode without colons (e.g. "thumbsup", "eyes"). */
  name: string;
  /** Number of users who reacted with this emoji. */
  count: number;
  /**
   * Display names of the users who reacted, when known. Populated by live reads
   * (`getMessageReactions`); omitted from the ingest snapshot, which only knows
   * counts.
   */
  users?: string[];
}

/** A fully-resolved message from a Slack thread */
export interface SlackThreadMessage {
  user: SlackAuthor;
  /**
   * ONLY the author's own typed text — top-level blocks/text plus file descriptions, mentions already resolved. This is NOT the message body: the body comes from `renderMessageBody` / `messageBody` in `src/connectors/slack/message-body.ts`, which folds in attachment cards, the file list and reactions.
   */
  ownText: string;
  ts: string;
  files?: SlackFile[];    // raw file metadata (not yet downloaded)
  /** Forwarded / unfurled message attachments — each carries its author and text. */
  attachments?: SlackAttachment[];
  /** Emoji reactions present on this message at fetch time. Omitted when none. */
  reactions?: SlackReaction[];
}

/**
 * Full Slack thread context — all API data resolved, ready for task consumption.
 *
 * `shared` is a thread-level signal: when true, the channel is currently
 * shared with one or more external workspaces (Slack Connect). Consumers use
 * `shared && isExternalUser(msg.user)` to decide whether to redact a message
 * when writing it out — the data layer never strips content itself. Redaction covers the whole message body (`ownText` plus attachments, files and reactions), not just `ownText`.
 */
export interface SlackThread {
  threadId: string;
  channel: { id: string; name: string };
  shared: boolean;
  messages: SlackThreadMessage[];  // bot messages excluded, EXCEPT the root when our bot started the thread
  currentMessageTs: string;
  /**
   * True when OUR bot authored the thread's root message. The router uses this
   * to seed a task when a human replies to a thread Archie itself started
   * (a post made via the task-decoupled `post_to_channel` explore tool).
   */
  rootAuthorWasBot: boolean;
}

// ---- Channel types (replace slack_threads) ----

export type ChannelType = 'slack' | 'cli' | 'recall';

export interface ChannelBase {
  type: ChannelType;
}

/** Slack channel — wraps a specific thread in a Slack channel */
export interface SlackChannel extends ChannelBase {
  type: 'slack';
  thread_id: string;
  channel_id: string;
  channel_name: string;
  last_processed_ts: string;
  url?: string;     // Full Slack URL to the thread (e.g. https://workspace.slack.com/archives/C.../p...)
  muted?: boolean;  // When true, messages are not routed to task until next @mention
  /**
   * Timestamp of the message we've currently acked, if any (surfaced to the
   * user as an `:eyes:` reaction). Tracked separately from `last_processed_ts`
   * because the latter advances on every processed message (including
   * non-mention thread replies we never ack), which would otherwise orphan the
   * indicator. Cleared when the ack is removed.
   */
  ack_ts?: string;
  /** Snapshot of last observed Slack-Connect / shared-channel state for this channel. */
  isShared?: boolean;
  /** User IDs already shown the shared-channel ephemeral warning in this thread. */
  warnedUsers?: string[];
  /** User IDs already shown the forward-from-external ephemeral notice in this thread. */
  forwardNotifiedUsers?: string[];
}

/** CLI channel — the REST/SSE surface the CLI tails. One per task at most. */
export interface CliChannel extends ChannelBase {
  type: 'cli';
  id: 'cli:local';
}

export const CLI_CHANNEL_KEY = 'cli:local' as const;

/**
 * Recall channel — a voice meeting (Zoom, Meet or Teams) that the Recall
 * connector bound to this task. Named for the connector that owns it, the
 * same way `SlackChannel` is named for Slack: a meeting is a place Archie is
 * reachable, and that place is Recall — a future Telegram call would add a
 * `telegram` kind owned by that connector instead. `src/voice/` is the
 * medium and has no channel kind of its own; see `docs/architecture/voice.md`.
 *
 * `session_id` is Recall's bot id — also `Meeting.sessionId` (the voice
 * medium's own name for it; see `src/voice/meeting.ts`). It is what makes the
 * channel key (`recall:<session_id>`) unique per meeting: the in-process
 * live-meeting registry in `src/voice/task-binding.ts` is keyed by taskId
 * alone, so a deliverer reaching it for a *stale* channel key must compare
 * this field against the live meeting's own `sessionId` to tell "no meeting
 * live" apart from "a different, later meeting is live now" — see
 * `src/voice/channel-delivery.ts`.
 *
 * The record itself is permanent, exactly like a `SlackChannel`: linked and
 * `ended: false` when the meeting starts, flipped to `ended: true` when it
 * stops, never removed. That is what lets a post to this channel — live,
 * ended, or left stale by a crash — always reach the Recall connector's own
 * deliverer rather than fall through to generic task code that has no idea
 * what a meeting is. See `src/tasks/channel-delivery.ts`.
 */
export interface RecallChannel extends ChannelBase {
  type: 'recall';
  session_id: string;
  /** The meeting URL, when known. */
  url?: string;
  /** Set once the meeting has ended. Everything else about the record is unchanged and kept. */
  ended: boolean;
}

export type Channel = SlackChannel | CliChannel | RecallChannel;

/**
 * One roster entry from Recall's participant list — presence, not speech:
 * everyone who joined the call, including anyone who never unmuted. Names are
 * self-reported display names from the meeting platform; nothing verifies
 * them, the same caveat the transcript's own speaker names carry.
 *
 * Recall's own record also carries `id` (its own opaque key, meaningless to a
 * reader of `metadata.json`), `extra_data` (an untyped, vendor-internal blob)
 * and `email`. `email` is left out on purpose rather than typed as optional:
 * it only ever populates for a calendar-dispatched bot, and every bot we
 * create joins from a raw meeting URL instead — so for this deployment it
 * would always be `null`. A field that can never carry a value here should
 * not be modelled as one that might.
 */
export interface MeetingParticipant {
  name: string | null;
  is_host: boolean | null;
}

/**
 * One entry in the roster this connector accumulates LIVE, from
 * `participant_events.join`/`.leave` on the same realtime websocket that
 * already carries audio — see `MeetingMetadata.live_participants` for how
 * this differs from (and coexists with) `MeetingParticipant` above.
 *
 * Never removed once added, only closed: a rejoin after a real departure
 * gets its own new entry (Recall issues a fresh participant id per join), so
 * two short visits show as two rows rather than one silently resumed —
 * preserving history is the whole point, since a summary written after the
 * meeting needs to know who was there even if they left long before it ended.
 *
 * Recall's own participant id is deliberately not carried here — it is
 * Recall-internal and meaningless to a reader of `metadata.json`, the same
 * reasoning `MeetingParticipant` already gives for leaving off `email`.
 */
export interface LiveMeetingParticipant {
  name: string | null;
  is_host: boolean | null;
  /**
   * When this join was recorded, or `null` if we never actually saw the join
   * itself — only a later `.leave` for someone already in the room when this
   * bot started listening (or whose join event this connector otherwise
   * missed). Never guessed to fill the gap; `null` means the same "not known"
   * it means everywhere else in this file.
   */
  joined_at: string | null;
  /** `null` while still present, or if we never heard them leave either. */
  left_at: string | null;
}

/**
 * What a voice meeting WAS — facts about the occasion, so an agent opening a
 * finished meeting's folder knows what it was without parsing `transcript.log`.
 * Lives at `shared/recall/{sessionId}/metadata.json` (see
 * `getMeetingMetadataPath` in `src/tasks/persistence.ts`) and mirrors the
 * task's own `shared/metadata.json` in both regards that matter: a plain JSON
 * snapshot, written whole with no lock, safe to go briefly stale.
 *
 * Most fields are written twice, never merged: once when the meeting starts,
 * with whatever is known then (`writeMeetingMetadataStart` in
 * `src/voice/task-binding.ts`), and once more at teardown, with the rest
 * (`completeMeetingMetadata`) — each write is a full replacement, so its
 * caller is responsible for carrying every field forward, not just the new
 * ones. `live_participants` is the one exception: it is written again on
 * every participant join and leave in between (`updateMeetingParticipantsLive`),
 * re-asserting the same `null` placeholders for whatever the first two writes
 * own, since this file has no partial-patch form — see that field's own doc.
 *
 * Every field below that can be unknown IS modelled as nullable rather than
 * omitted-or-guessed: a `null` always means "not known", whether that is
 * because the teardown fetch has not happened yet, because it failed, or
 * because the meeting platform never supplies that fact at all (Teams and
 * Webex never give a title; Google Meet only gives one for a signed-in bot).
 * All three look the same on purpose — see `docs/architecture/voice.md`.
 */
export interface MeetingMetadata {
  /** Recall's bot id — same value as `RecallChannel.session_id` and the folder name. */
  session_id: string;
  /** The plain URL string handed to Recall when the meeting started. */
  url: string;
  /**
   * Recall's own structured read of `url`, a discriminated union server-side
   * (`zoom`, `google_meet`, `microsoft_teams`, `microsoft_teams_live`,
   * `webex`, `goto_meeting`) — we only ever send the plain string; Recall
   * parses it and echoes back the structured form on `GET /api/v1/bot/{id}/`.
   * `null` until that fetch happens, or if it failed, or if Recall's own
   * response omitted it.
   */
  platform: string | null;
  /**
   * The meeting's own title, from Recall's `meeting_metadata` shortcut. Zoom
   * supplies it; Teams and Webex never do; Google Meet only for a bot that
   * joined signed in. `null` is the ordinary state for most platforms, not a
   * sign anything went wrong.
   */
  title: string | null;
  /**
   * When Archie (the bot) joined — never "when the meeting started". Recall
   * has no record of the latter, only of the bot's own status, and the room
   * may already have been talking for a while before this bot arrived: the
   * transcript only covers from this instant onward.
   */
  archie_joined_at: string;
  /**
   * When the meeting ended: Recall's own `call_ended` status if the teardown
   * fetch reached it, otherwise the local wall-clock instant teardown began.
   * `null` only while the meeting is still open (the end-of-meeting write has
   * not happened yet).
   */
  meeting_ended_at: string | null;
  /**
   * `meeting_ended_at` minus `archie_joined_at`, in whole seconds — computed
   * here because Recall's own schema has no duration field. `null` until
   * `meeting_ended_at` is known.
   */
  duration_seconds: number | null;
  /**
   * The roster Recall recorded. `null` until the teardown fetch runs, if it
   * failed, or if Recall never produced one (the roster is itself an async
   * artifact and may not be ready yet even when the rest of the fetch
   * succeeds) — an empty array means the fetch succeeded and Recall reported
   * nobody, which is a different, stronger claim than `null`.
   */
  participants: MeetingParticipant[] | null;
  /**
   * The roster this connector accumulated LIVE, from `participant_events.join`
   * and `.leave` arriving on the same realtime websocket that already carries
   * audio — present from the moment the first participant joins, unlike
   * `participants` above which stays `null` until the teardown fetch runs.
   * See `LiveMeetingParticipant` for why an entry is closed rather than
   * removed.
   *
   * Deliberately NOT reconciled into one list with `participants`: the two
   * answer different questions and are allowed to disagree. This one is
   * presence-over-time — ours, live, best-effort, with timestamps — from the
   * moment Archie joins. `participants` is Recall's own deduplicated final
   * view, populated once, only after the meeting is over, with no timestamps
   * at all. Merging them would mean inventing a rule for which one wins when
   * they differ (a network blip producing two `.join`s this connector sees
   * as two entries but Recall's own dedup collapses into one, for instance) —
   * keeping both lets a reader who wants "was X ever here" check either, and
   * a reader who wants "when" has only this one to check.
   *
   * Archie itself never appears here, filtered at the connector boundary
   * (`isArchie`, exported from `src/voice/meeting.ts`) the same way it is
   * absent from `participants` — the bot is not a fact about who else was in
   * the room, and already has its own `archie_joined_at` above.
   *
   * Always an array, never `null`: unlike `participants`, which distinguishes
   * "the teardown fetch never ran" from "it ran and found nobody," this
   * field is this connector's own in-memory state from the first write
   * onward, never a fetch that could fail to happen at all.
   */
  live_participants: LiveMeetingParticipant[];
}

/**
 * What a voice meeting was told it COULD DO — the `<capabilities>` block as the
 * model actually received it. Lives at
 * `shared/recall/{sessionId}/capabilities.json` (see
 * `getMeetingCapabilitiesPath` in `src/tasks/persistence.ts`).
 *
 * This record exists for one question that used to be unanswerable after the
 * fact. The block is built once at join by a model call
 * (`buildCapabilitySummary` in `src/voice/capabilities.ts`), kept only in the
 * meeting's own closure, and included in the context of EVERY model call for the
 * rest of the meeting — and it is the sole source for answering "what can you
 * help with". So when that answer came back wrong in a live room, nothing on
 * disk could say whether the block had been empty, had been the wrong shape, or
 * had been fine and the model ignored it. The transcript records the wrong
 * answer; nothing recorded the input that produced it.
 *
 * Written whole, exactly once, the same write model as the `metadata.json`
 * beside it — but deliberately NOT a field in that file. `metadata.json` is
 * re-asserted in full from in-memory state on every participant join and again
 * at teardown (see `MeetingMetadata`), and this summary lands at an
 * unpredictable moment somewhere among those writes, so a field there would be
 * silently clobbered by the next person to join the room. Its own file cannot
 * be.
 *
 * There is no prompt-version or prompt-hash field, and the reason is worth
 * writing down because it is not obvious. The text the summarising call
 * actually used is a local inside `summariseCapabilities`
 * (`src/voice/comprehension.ts`): `loadPrompt` keeps no cache, so it exists
 * nowhere else in the process, and it is not the file's bytes either —
 * `{{BOT_NAME}}` is interpolated into it before the call sees it, so its hash
 * would never match `sha256sum prompts/voice-capabilities.md` and would shift
 * whenever the bot was renamed with the prompt untouched. Re-reading the file
 * here to hash it instead would be a second read that can disagree with the one
 * the call used — a confidently wrong provenance claim, which is worse than
 * none.
 *
 * So provenance is recovered from `captured_at` rather than stored: the prompt
 * is version-controlled, and
 * `git log -1 --until=<captured_at> -- prompts/voice-capabilities.md` names the
 * revision that was live when the block was made. That holds only for a
 * committed prompt — a block captured against an uncommitted local edit is not
 * recoverable this way, and the verbatim `summary` is then the only evidence of
 * what that prompt produced.
 */
export interface MeetingCapabilities {
  /** Recall's bot id — same value as `MeetingMetadata.session_id` and the folder name. */
  session_id: string;
  /**
   * Whether there was a block at all: `'summarised'` when the model produced
   * one, `'empty'` when it did not.
   *
   * Derivable from `summary` being empty, and recorded anyway, because the
   * empty case is the one outcome this file most needs to STATE rather than
   * leave a reader inferring from an absence. An empty summary renders no
   * `<capabilities>` block at all (`capabilitiesBlock` in
   * `src/voice/comprehension.ts`) — a real, fail-safe outcome rather than a
   * fault, and exactly as diagnostic as a full block. See
   * `recordMeetingCapabilities` in `src/voice/task-binding.ts` for why a
   * missing file therefore never means this.
   */
  outcome: 'summarised' | 'empty';
  /**
   * The block's text as the model received it, verbatim and unreshaped — the
   * whole reason this file is JSON rather than one more `.log` beside its
   * neighbours, since "the block was the wrong shape" is one of the three
   * diagnoses it exists to separate and a line-per-entry log format cannot
   * preserve line shape.
   *
   * Trimmed, because trimmed is what the model gets: `setCapabilities`
   * (`src/voice/meeting.ts`) and the renderer both trim, so a summary that came
   * back as whitespace reaches the prompt as no block at all and is recorded
   * here as `outcome: 'empty'` with an empty string.
   *
   * The `<capabilities>` tags themselves are constant framing added by the
   * renderer and are not stored — this is the part that varies.
   */
  summary: string;
  /**
   * When this was recorded, which is when the summarising model call came back
   * — NOT when the bot joined (`MeetingMetadata.archie_joined_at` has that).
   * The gap between the two is the window the meeting ran with no capability
   * block, and any turn taken inside it had none.
   */
  captured_at: string;
}

/**
 * Snapshot of a pull request as shown on its "PR card" — the compact, updating
 * block rendered in Slack and the CLI. Carried verbatim in the `pr_card` event
 * (so every surface renders the same data) and used to build the Slack blocks.
 */
export interface PrCardData {
  repo: string;          // 'owner/name'
  prNumber: number;
  url: string;           // html_url to the PR
  headRef: string;       // head branch name, shown in the card title
  state: 'open' | 'merged' | 'closed';
  head_sha: string;
  ci: 'none' | 'pending' | 'passed' | 'failed';  // rolled-up CI verdict
  ciPassed: number;      // checks concluded OK
  ciTotal: number;       // total checks (0 = no CI)
}

/**
 * Per-PR card bookkeeping stored on the branch state. `fingerprint` is the
 * channel-agnostic "has this card changed?" gate (see `prCardFingerprint`);
 * `slack` holds the posted message ref so it can be deleted/reposted (resurface)
 * or edited in place. The CLI keeps no server-side state — it folds the
 * `pr_card` event stream client-side.
 */
export interface PrCardState {
  fingerprint: string;
  slack?: { ts: string; channel_id: string; thread_id: string };
}

/** Per-branch state — tracks PR lifecycle and stash */
export interface BranchState {
  base_branch?: string;                // PR target branch (e.g. 'main', 'master')
  pr_number?: number;                  // PR associated with this branch
  last_processed_comment_id?: number;  // triage tracking for this branch's PR
  stash_name?: string;                 // set if dirty work was auto-stashed when leaving
  pr_card?: PrCardState;               // PR-card message ref + change-detection fingerprint
  /**
   * Set when the "PR ready — merges on request" notification fired for this
   * branch's PR (non-auto repos only), cleared when a merge check observes the
   * PR no longer ready — so each continuous ready period notifies exactly once.
   */
  merge_ready_notified?: boolean;
  /**
   * Set when the user approved an explicit merge request for this branch's PR
   * but GitHub did not yet report it clean (non-auto repos only): the PR is
   * *armed* for auto-merge. The merge orchestrator merges an armed PR on the
   * next merge-triggering webhook once `mergeableState === 'clean'`, with no
   * Archie-side approval floor. Cleared when the PR is observed merged or
   * closed.
   */
  merge_armed?: boolean;
}

/**
 * One repo attached to a specific agent in a specific task.
 *
 * Each agent has its own clone — two agents attaching the same `github` get two
 * independent `AttachedRepo` records under different agent IDs in
 * `TaskMetadata.repositories`. The base-cache path is derivable as
 * `join(REPOS_DIR, github)` and is not stored here.
 */
export interface AttachedRepo {
  /** Github identifier, e.g. 'acme/backend'. */
  github: string;
  /**
   * Task-local shared clone path, e.g.
   * `sessions/<id>/repos/<agentId>/acme/backend`. Set when the clone is
   * created during agent spawn; undefined briefly between attachment record
   * creation and clone setup. Lives outside the agent's cwd
   * (`sessions/<id>/agents/<agentId>/`) so workspace and repo state are
   * cleanly separated.
   */
  clone_path?: string;
  /**
   * Absolute path to the base cache this clone borrows from — i.e. the
   * directory the clone's `.git/objects/info/alternates` file points at the
   * parent of. Pinned at clone time and used by the sandbox to grant read
   * access to the borrowed object store, so the clone keeps working even if
   * the layout convention changes underneath it (pre-v30 caches lived at
   * `$ARCHIE_WORKDIR/repos/<short-key>/`; new caches at
   * `$ARCHIE_WORKDIR/repos/<org>/<repo>/`). Migration preserves the legacy
   * `path` here; fresh clones populate it from `getBaseCachePath(github)`.
   */
  base_path?: string;
  /** Branch the agent is on right now (key into `branch_states`). */
  current_branch?: string;
  /** Per-branch state — PR number, base branch, stash, last-processed-comment id. */
  branch_states?: Record<string, BranchState>;
}

/**
 * Legacy per-repo state shape (pre-v30).
 * Retained only to type the lazy migration path in Task.get; new code uses
 * `AttachedRepo` and `metadata.repositories: Record<agentId, AttachedRepo[]>`.
 */
export interface RepositoryInfo {
  path: string;
  branch?: string;
  base_branch?: string;
  base_sha?: string;
  clone_path?: string;
  feature_branch?: string;
  pr_number?: number;
  last_processed_comment_id?: number;
  current_branch?: string;
  branch_states?: Record<string, BranchState>;
}

/**
 * Spec for a repo agent the PM spawned on demand via `spawn_repo_agent`.
 *
 * Stores only the PM-supplied inputs (not a full AgentDef); the live AgentDef
 * is re-synthesized from this on every `Task.get` via `synthesizeDynamicAgentDef`,
 * so resolved/derived fields never go stale on disk. Persisted in
 * `TaskMetadata.dynamic_agents`. Such an agent eager-mounts its `repos` at spawn
 * exactly like a plugin-defined repo agent — there is no on-demand attach.
 */
export interface DynamicAgentSpec {
  /** Final agent ID, e.g. 'explorer-a3f9-agent'. */
  id: string;
  /** PM-supplied short name (`[a-z][a-z0-9-]*`). */
  shortname: string;
  /** Repos this agent works with. First entry is the primary. */
  repos: Array<{ github: string; baseBranch?: string }>;
  /** Role string used in peer lists and the agent's own prompt. */
  role: string;
  /** Expertise string used in the agent's prompt. */
  expertise: string;
}

/**
 * Per-agent session state — tracks whether each agent is active
 * and preserves session IDs for SDK resume.
 */
export interface AgentSessionState {
  session_id?: string;       // undefined = no session yet or cleared (fresh start)
  active: boolean;           // true = doing work, false = finished turn / crashed
  last_activity?: string;    // ISO timestamp
}

export interface TaskMetadata {
  task_id: string;
  task_owner: AgentName | null;
  participants: AgentName[];
  channels: Record<string, Channel>;   // Active message delivery targets, keyed by channel ID
  default_channel: string | null;      // Channel ID of the originating channel (null for CLI-originated tasks)
  /**
   * The Slack channel a trigger-fired task is homed in. Written only by `fireTrigger`, from the binding on an approved trigger — never from a model input.
   *
   * It answers two questions for a task that has no thread yet: where the task opens its own thread (its first user-facing agent message becomes that thread's root), and whose standing context applies before that thread exists.
   */
  home_channel?: { channel_id: string; channel_name: string };
  title?: string;                      // AI-generated one-line summary; absent on pre-feature tasks
  slack_threads?: SlackThreadRef[];    // Legacy — only present on old tasks loaded from disk, removed after migration
  agent_sessions: Record<string, AgentSessionState | string>; // union handles legacy string values on disk
  /**
   * Per-agent attached repos. Keyed by agent ID. Each value is the list of
   * repos that agent currently has mounted (always includes the agent's
   * primary at minimum, once it has spawned).
   *
   * Legacy on-disk shape (pre-v30): `Record<repoKey, RepositoryInfo>` keyed by
   * short repo name. Migrated lazily in `Task.get`.
   */
  repositories: Record<string, AttachedRepo[]>;
  /**
   * Specs for repo agents the PM spawned on demand (via `spawn_repo_agent`).
   * Re-synthesized into AgentDefs and merged into the task team on every
   * `Task.get`. Absent on tasks that never spawned one.
   */
  dynamic_agents?: DynamicAgentSpec[];
  /**
   * Channel ids whose standing brief `post_to_channel`'s preflight has already
   * shown on this task. The first attempt to post into a channel with an `Archie…`
   * canvas returns that brief instead of posting; the retry goes through, and every
   * later post to the same channel skips the preflight entirely.
   *
   * Lives in metadata, not on the Agent, because the Agent's lifetime is shorter
   * than the task's: a settled task leaves the active registry, and the next
   * message rebuilds `Task` from disk with a fresh Agent — which would show the
   * same brief again on every re-activation (observed live before this was moved).
   * Once per task means once per task, restarts included.
   */
  briefed_channels?: string[];
  status: TaskStatus;
  edit_allowed?: boolean;     // Has user approved edit mode for this task?
  max_mode?: boolean;         // Has user approved "max mode" (per-task model/effort upgrade) for this task?
  /**
   * The human who approved edit mode. Used as the git *author* on every commit
   * the repo agents make for this task (the committer stays the GitHub App bot),
   * so `git blame` and GitHub attribute the change to a person you can ask about
   * it. Absent on pre-feature tasks and on CLI/API approvals with no resolved
   * user — in which case authoring falls back to the bot (the prior behaviour).
   */
  edit_approved_by?: { id: string; name: string; email?: string };
  /**
   * The single pending merge-approval request (written by `merge_pull_request`
   * on a non-auto repo, cleared on every resolution — approve or deny). A
   * request record, not a grant: merge approval is one-shot per PR, not a
   * task-lifetime mode. Survives restart like `edit_allowed`.
   */
  pending_merge_approval?: {
    github: string;       // repo of the requested PR
    pr_number: number;    // which PR to merge on approval
    requested_by: string; // agent id — to clear its parked teardown on resolution
    requested_at: string; // ISO 8601, for the audit finding
  };
  /**
   * The single pending MCP tool-call approval (written by the PreToolUse gate
   * in `tool-approval-gate.ts`, cleared on resolution, on a failed Slack post,
   * or by ageing out). One at a time by design: a queue of pending approvals
   * invites clearing them in a batch, which is the accident the gate exists to
   * stop.
   */
  pending_tool_approval?: {
    digest: string;       // identity of the exact (server, tool, arguments) call
    server: string;       // MCP server key, for the audit finding
    tool: string;         // bare tool name
    summary: string;      // rendered prompt body shown to the approver
    heading: string;      // one-line heading (the tool's description, or server:tool)
    requested_by: string; // agent id — woken on approval; park cleared on resolution
    requested_at: string; // ISO 8601
  };
  /**
   * Grants approved but not yet spent. Each is one-shot and bound to a digest
   * of the exact call, so it cannot be redirected to a different call or
   * replayed. Expired entries are pruned on read.
   */
  approved_tool_calls?: ApprovedToolCall[];
  research_budget_extra?: number;    // Additional research budget granted via Slack approval (+5 per approval)
  research_request_count?: number;   // Persisted research request count (survives stop/reactivate)
  failure_counter?: number;          // Consecutive recovery attempts (Stage 3 idle detection)
  reminder?: {                       // Pending self-scheduled reminder (set by agent via set_reminder tool)
    trigger_at: string;              // ISO 8601 datetime when the task should be reactivated
    reason: string;                  // Why — shown to agent when woken
  };
  triggered_by?: string;             // Trigger ID that spawned this task (set by fireTrigger). Blocks the task from creating triggers.
  pending_trigger_id?: string;       // Trigger ID proposed by this task, awaiting approve/deny (read by handleTriggerApproval/Denial)
  created_at: string;
  updated_at: string;
}

/**
 * A human-approved, single-use permission to run one gated MCP tool call.
 * Bound to `digest` — a hash of the server, tool and every argument — so it is
 * spendable on that call and no other.
 */
export interface ApprovedToolCall {
  digest: string;
  server: string;
  tool: string;
  approved_by?: string;  // Slack user id of the approver, for the audit finding
  approved_at: string;   // ISO 8601
  expires_at: string;    // ISO 8601 — unspent grants go stale (APPROVAL_TTL_MS)
}

export interface LogEntry {
  timestamp: string;
  source: string;
  type?: FindingType;
  message: string;
}

export interface TriageResult {
  action: 'new_task' | 'existing_task' | 'cancel_task' | 'noop';
  task_id?: string;
  confidence: 'high' | 'medium' | 'low';
  similar_tasks?: string[];
}

/** File metadata from Slack */
export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  /** URL for downloading with Bearer token (preferred for API downloads) */
  url_private_download?: string;
  /** Local path after download (set by task processing) */
  localPath?: string;
}

/**
 * A simplified attachment on a Slack message.
 *
 * Slack attachments cover several use cases (forwarded messages, permalink
 * unfurls, link previews). We collapse them into a single shape: each entry
 * has its own text and, when known, the original author resolved to a
 * SlackAuthor. This keeps the author + content correlation that flat parallel
 * fields would lose.
 */
export interface SlackAttachment {
  /** Resolved author info, when the attachment carries an author (forwards / message unfurls). */
  author?: SlackAuthor;
  /** Text content of the attachment (forwarded message body, unfurled preview, etc.). */
  text: string;
}

