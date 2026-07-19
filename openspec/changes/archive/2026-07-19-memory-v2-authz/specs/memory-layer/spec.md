# Memory Layer — Delta: memory-v2-authz

## ADDED Requirements

### Requirement: Channel visibility classification and stamping

The system SHALL classify every Slack conversation into one visibility class — `public`, `private`, `dm`, `ext-shared`, or `unknown` — and persist the class onto the task's stored channel record (`SlackChannel.visibility`). Classification SHALL derive from `conversations.info` for every conversation id, `D`-prefixed ids included: ext-shared (`is_ext_shared`, pending, or >1 connected team) SHALL win over every other class unconditionally — Slack Connect DMs are externally-shared im conversations and SHALL classify `ext-shared`, so the `dm` branch (`is_im`/`is_mpim`) SHALL be evaluated only after the ext-shared predicate, and there SHALL be no API-free short-circuit for any id shape; `is_private` or a legacy `G` prefix classify `private`; everything else is `public`. On any classification error the system SHALL stamp `unknown` — a distinct class, never a collapse into `private`: `unknown` SHALL gate extraction (see "Extraction confidentiality gate") AND SHALL trigger the read lockdown (see "Ext-shared task memory lockdown"), because the channel's true class may be `ext-shared` and an API failure must never widen access in either direction. Errors SHALL NOT be cached, so the stamp self-heals on the next successful classification (deliberately the opposite of the advisory shared-channel check, which fails open because it only drives warnings). DMs are NOT private channels: they carry their own class and their own rules.

The class SHALL be stamped wherever channels attach to tasks — on inbound Slack messages (refreshing existing channels, so mid-task flips restamp on the next message), when the PM opens a new thread or DM (`new_dm` stamps via the same classification lookup, never a static literal), and when a new thread links via append. A channel record with no visibility stamp SHALL be treated as `private` by every consumer. GitHub and CLI channels are org-contributing (governed by GitHub's ACLs and the host operator respectively).

**Rationale:** No persisted `is_private` existed anywhere; the only shared-channel signal failed open and was observability-only. Authorization state must be fail-closed and readable without API calls at decision time.

#### Scenario: Classification precedence and fail-closed error handling

- **WHEN** `conversations.info` reports a channel as both externally shared and private
- **THEN** the channel classifies `ext-shared`
- **WHEN** the API call fails
- **THEN** the channel classifies `unknown`
- **AND** the error is not cached, so the next classification attempt retries the API

#### Scenario: Classification failure read-locks a possibly-Connect channel

- **WHEN** a Slack Connect channel attaches to a task during a transient `conversations.info` outage
- **THEN** the channel is stamped `unknown` and the task gets no memory surface — no injection, no tools, per-call deny (never the normal read surface that a `private` collapse would grant)
- **WHEN** a later message classifies the channel successfully as `ext-shared`
- **THEN** the restamp keeps the task locked
- **WHEN** instead it classifies `public`
- **THEN** the next spawn gets the normal memory surface

#### Scenario: Visibility restamps on traffic

- **WHEN** a channel flips private mid-task
- **AND** a new message arrives in a linked thread
- **THEN** the stored channel record's `visibility` reflects the new class

#### Scenario: Slack Connect DM classifies ext-shared, not dm

- **WHEN** a `D`-prefixed conversation reports `is_im: true` and `is_ext_shared: true`
- **THEN** the channel classifies `ext-shared`
- **AND** the task carrying it gets no memory surface (see "Ext-shared task memory lockdown")

### Requirement: Extraction confidentiality gate

Before any extraction work, the system SHALL classify the completed task's Slack channels into one of three extraction modes, whitelist-style — only the values `public` and `dm` are recognized as non-gating, so an unknown or missing visibility value can never widen the gate:

- any `ext-shared` channel → **skip**: NO memory artifacts of any kind; log + one `kind: "extraction-skip"` telemetry record with reason `ext-shared`.
- else any `unknown` channel (classification failure — see "Channel visibility classification and stamping") → **skip**: same as above with reason `unknown`.
- else any `private` channel, any unstamped channel, or any visibility value outside the known vocabulary → **skip**: same as above with reason `private`.
- else any `dm` channel → **prefs-only**: the extraction applies user-preference updates ONLY (still restricted to the task's author users). NO task summary, NO activity row, NO entity updates, NO Related Tasks participation — the lifecycle SHALL drop any non-preference output the extractor returns, regardless of prompt behavior. One `kind: "extraction-prefs-only"` telemetry record is appended. A task with any DM channel — including mixed public+DM tasks — is prefs-only: DM presence always suppresses org artifacts.
- else (all channels `public`, or no Slack channels at all — CLI/GitHub tasks) → **full**: extraction runs and stamps `access: org`.

Extraction SHALL stamp `access: org` (the only access class ever written) into the summary frontmatter as a top-level `access:` key and a `visibility:` value onto each `links.slack[]` entry. The activity row SHALL carry the class in an `Access` column (legacy 5-column rows SHALL still parse, with no class). Because prefs-only tasks write no summary and no activity row, DM-derived content is episodically unreachable by construction — no read-side rule for a `dm` class exists.

**Retraction on downgrade:** tasks complete more than once (a reply reopens a parked task and completion re-fires) and the channel set can grow between completions (the PM can attach a DM mid-task), so an earlier completion's artifacts can front a knowledge log that has since absorbed confidential lines. When a skip or prefs-only extraction runs for a task that already has episodic artifacts, the system SHALL retract them before returning: delete `memory/tasks/<taskId>/summary.md` and remove the task's activity row. A stale `access: org` stamp MUST NOT survive a downgraded re-completion — it would keep granting `grep_task_log` over the grown raw log. The skip/prefs-only telemetry record SHALL carry `retracted: true` when artifacts were removed. Entity facts distilled by the earlier completion are not retracted — they derive from the pre-downgrade transcript, which was org-eligible when extracted; per-fact provenance remains a non-goal.

**Rationale:** Read-side scoping alone cannot protect `knowledge.log` content that extraction has already distilled into org-visible summaries, activity titles, and entity facts. The policy is enforced where the artifacts are created. The first iteration's `access: dm` read class (channel/author overlap) over-granted through mixed tasks' public parts; the owner retired cross-task DM readability instead of scoping it — DMs contribute exactly their durable per-user signal (preferences) and nothing else.

#### Scenario: Private-channel task stores nothing

- **WHEN** a task whose channels include a `private` Slack channel completes
- **THEN** no summary, activity row, entity update, or user update is written
- **AND** an `extraction-skip` telemetry record with reason `private` is appended

#### Scenario: Unknown visibility value gates as private

- **WHEN** a task completes holding a Slack channel whose stored visibility is an unrecognized string (e.g. `shared` from hand-edited or version-skewed metadata)
- **THEN** extraction skips with reason `private`
- **AND** no memory artifact is written

#### Scenario: DM task writes user preferences only

- **WHEN** a task whose Slack channels are one `public` channel and one `dm` channel completes
- **AND** the extractor returns user updates, org updates, and a summary
- **THEN** only the user-preference updates for the task's author users are applied
- **AND** no summary file, no activity row, and no entity update is written
- **AND** an `extraction-prefs-only` telemetry record is appended

#### Scenario: DM tasks never appear in Related Tasks

- **WHEN** a DM-derived task completes and a later org task extracts with overlapping entities or domain
- **THEN** the later task's summary contains no reference to the DM task (no activity row exists to select)

#### Scenario: Downgraded re-completion retracts the stale org grant

- **WHEN** a task completes with all-public channels and extraction writes an `access: org` summary
- **AND** the task reopens, a DM channel attaches, and confidential lines land in the same `knowledge.log`
- **AND** the task completes again (prefs-only)
- **THEN** the earlier summary is deleted and the task's activity row is removed
- **AND** a later `read_task_summary` or `grep_task_log` for it from another task is denied `no-access-stamp`
- **AND** the `extraction-prefs-only` telemetry record carries `retracted: true`

### Requirement: User memory ownership

User memory SHALL be written from, and served to, only its owner's own participation:

- **Write:** extraction SHALL accept `user_updates` only for the task's AUTHOR users (source-line scan of the transcript; redacted external authors excluded). A user who is merely @-mentioned SHALL NOT be writable. Own-statement attribution SHALL be enforced in code, not only by prompt: every `user_update` SHALL cite one or more `msg:<ts>` source ids as evidence, and the lifecycle SHALL apply the update only when every cited id resolves to a transcript source line authored by the target user — an update with no evidence, an unresolvable id, or a cited line authored by anyone else SHALL be dropped and recorded as a `kind: "user-update-dropped"` telemetry record (task id, target user, cited ids). The extractor prompt SHALL still instruct own-statements-only attribution and require the citations.
- **Read (push):** injection SHALL emit `<user_preferences>` blocks only for the task's author users.
- **Read (pull):** `search_memory` SHALL rank user preference files only for the calling task's author users; there is no user-page read tool, and another user's bullets SHALL never surface in results.
- **Transcript integrity:** the persistence layer SHALL frame appended message bodies so that no line originating from a body can match the author source-line format (continuation lines are indented at append time); authorship SHALL derive only from writer-emitted source lines. Legacy unframed lines SHALL keep parsing as before (their trust class is unchanged and bounded by task age-out).

**Rationale:** Bob's memory belongs to Bob. Mention-derived involvement let anyone who typed `@Bob` route Bob's preferences into their own context and let the extractor write Bob's file from second-hand claims.

#### Scenario: Mention-only users are not writable

- **WHEN** Alice authors a message mentioning Bob, and Bob never posts
- **AND** extraction runs
- **THEN** the allowed-user set contains Alice only
- **AND** no update to Bob's file is applied

#### Scenario: A crafted message body cannot forge authorship

- **WHEN** Alice posts a multi-line message whose second line mimics the source-line format for Bob (`[ts] [@<U_BOB:Bob> in #chan | msg:…] …`), and Bob never posts
- **THEN** the persisted knowledge log carries that line framed (indented) so it does not parse as a source line
- **AND** the author set contains Alice only — Bob gains neither write eligibility nor read scope

#### Scenario: Second-hand claims are dropped by evidence validation

- **WHEN** Bob authored at least one message in the task (so Bob is in the allowed-user set)
- **AND** the extractor returns a `user_update` for Bob citing message ids authored by Alice, or citing none
- **THEN** the update is not applied
- **AND** a `user-update-dropped` telemetry record is appended

#### Scenario: A user's bullets never surface to tasks they are not authoring in

- **WHEN** an agent on a task whose authors do not include Bob calls `search_memory` with keywords matching Bob's preference bullets
- **THEN** no hit for Bob's user file is returned

#### Scenario: DM statements update the speaker's preferences

- **WHEN** Igor tells the bot a durable preference in a 1:1 DM and the task completes
- **THEN** Igor's user file gains the preference (prefs-only extraction — see "Extraction confidentiality gate")
- **AND** no other artifact records the DM's content

### Requirement: Ext-shared task memory lockdown

A task with any `ext-shared` Slack channel, any channel stamped `unknown` (classification failure — the true class may be ext-shared), or the legacy `isShared` snapshot as an additional positive trigger, SHALL receive no memory surface at all: the memory tools SHALL NOT be registered at spawn, prompt injection SHALL be skipped, and — as a per-call backstop for stale snapshots — ANY tool invocation from a locked caller context SHALL be denied: all four tools (`search_memory`, `read_entity`, `read_task_summary`, `grep_task_log`), evaluated before any corpus read and before the self rule, so entity content and the caller's own artifacts are equally out of reach. All triggers fold into the single caller-context flag. The skip SHALL be logged; per-call denials are recorded in pull telemetry with reason `ext-shared`.

**Rationale:** Anything an agent reads (pulled or injected) can be pasted where an external organisation reads it. Entity pages are distilled org knowledge — precisely what must not cross that boundary — so a partial surface (entities-only) inverts the risk, and the previous advisory prompt note is not enforcement.

#### Scenario: Ext-shared task gets no memory surface

- **WHEN** `ARCHIE_MEMORY_TOOLS=true` and `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns for a task holding an `ext-shared` Slack channel
- **THEN** no memory tools are registered and the prompt carries no memory context
- **AND** the lockdown is logged

#### Scenario: Stale-snapshot backstop denies every tool, entities and self included

- **WHEN** memory tools were registered before a channel's ext-shared stamp landed (stale spawn snapshot) and the caller context carries `extShared: true`
- **AND** the agent calls `read_entity`, `search_memory`, `read_task_summary`, or `grep_task_log` — the latter two with its OWN task id
- **THEN** every call returns a content-free policy denial with reason `ext-shared`
- **AND** no store file is read

## MODIFIED Requirements

### Requirement: Memory injection at agent spawn

The system SHALL append a memory context block to the system prompt of every spawned agent (PM track, repo track, plugin track) **when memory is enabled AND injection is enabled** (`ARCHIE_MEMORY_INJECT=true`; see "Memory injection MUST be independently gated and default off") **and the task is not ext-shared-locked** (see "Ext-shared task memory lockdown"). The block SHALL contain `<user_preferences user="...">` per AUTHOR user of the task who has a memory file (see "User memory ownership" — mention-derived users are not injected), `<recent_activity>` re-rendered from parsed rows filtered to `access: org` (never the raw file; legacy rows without an access class and any `dm`-classed rows left by the first iteration SHALL NOT be injected — prefs-only tasks write no rows, so org rows are the only rows that render), `<entity_index>` (when at least one entity exists), and `<entity slug="..." ...>` blocks for the entities selected for this task. Organizational knowledge is carried by the injected `scope: org` entity pages **and the always-injected `<entity_index>`**, not a separate `<organizational_knowledge>` block. The block SHALL be appended after the agent's track-specific context and any plugin overlays, under a header `## Organizational Memory`. If no memory exists, the prompt SHALL be returned unchanged. When injection is disabled, the system SHALL return the prompt unchanged and SHALL NOT perform any store reads or entity selection.

Entity-page selection SHALL be **push** (decided by the system at spawn, with no agent-callable query tool). The system SHALL select full entity pages by scoring the entity index against the spawn context — the agent's repo or plugin, the participating users, and the task title — and SHALL expand one hop along `[[wikilink]]` relations from the selected set. A page of any scope SHALL become an injection candidate only when it carries at least one relevance signal from the spawn context: a repo match, an `owned_by` relation to a participating user, token overlap with the context, or one-hop graph expansion from a signal-bearing page. `scope: org` entity pages SHALL be bounded by `ARCHIE_MEMORY_ORG_INJECT_MAX` as a **ceiling, not a target**: the highest-scoring signal-bearing org pages are injected up to the bound, with last-touched recency as the tiebreak, and an org page with no relevance signal SHALL NOT be injected even when the org budget has spare capacity. The bound `ARCHIE_MEMORY_ENTITY_INJECT_MAX` SHALL apply to the remaining repo/domain/title-scored and graph-expanded (non-`org`) pages. When more signal-bearing pages of either class qualify than its bound allows, the system SHALL inject the highest-scoring ones and SHALL log which entities were dropped; pages with no signal are not candidates and SHALL NOT be logged as drops. The thin `<entity_index>` SHALL always be injected in full and SHALL NOT be subject to any page bound — it is the catalogue through which org knowledge not selected for full injection remains discoverable via its `L0` summary.

When rendering a selected entity page into its `<entity>` block, the system SHALL bound the number of `touched_by` relations rendered to `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` (default 10), retaining the newest (most recently appended) edges; `0` SHALL be honored as "render no `touched_by` edges". Rendering SHALL NOT modify the stored entity page — the full `touched_by` history SHALL remain on disk for provenance and related-task selection. Relation types other than `touched_by` SHALL NOT be subject to this bound.

#### Scenario: Spawned agent receives memory context

- **WHEN** a `scope: org` entity relevant to the task (e.g. its name appears in the task title) exists and a user with memory is mentioned in the task
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns for that task
- **THEN** its system prompt contains both the `scope: org` `<entity ...>` block and a `<user_preferences user="...">` block
- **AND** no `<organizational_knowledge>` block is present

#### Scenario: Org-scoped entities are bounded by the org injection budget

- **WHEN** more signal-bearing `scope: org` entities qualify than `ARCHIE_MEMORY_ORG_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** at most `ARCHIE_MEMORY_ORG_INJECT_MAX` `scope: org` entity pages are injected in full
- **AND** the injected pages are the highest-scoring org pages by relevance, with last-touched date breaking ties
- **AND** the dropped org entity slugs are logged

#### Scenario: Zero-signal org page is not injected and not logged as a drop

- **WHEN** a `scope: org` entity carries no relevance signal for the spawn context (no repo match, no `owned_by` participant, no token overlap, not reachable by one-hop expansion)
- **AND** fewer signal-bearing org pages qualify than `ARCHIE_MEMORY_ORG_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** that entity's full page is not injected despite spare org budget
- **AND** its slug is not logged as an over-cap drop
- **AND** the `<entity_index>` still contains its row including its `L0` summary

#### Scenario: Dropped org page remains discoverable via the index

- **WHEN** a `scope: org` entity is not selected for full injection
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** the `<entity_index>` still contains that entity's row including its `L0` summary

#### Scenario: Entity index is always injected when entities exist

- **WHEN** at least one entity file exists
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** its system prompt contains an `<entity_index>` block listing the entities

#### Scenario: Activity injection filters restricted rows

- **WHEN** `recent-activity.md` holds an `org` row, a `dm` row left by the first iteration, and a legacy row without an access class
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** the injected `<recent_activity>` contains the `org` row only

#### Scenario: DM-task callers receive the full memory context

- **WHEN** an agent spawns for a task whose only Slack channel is a (non-ext-shared) `dm`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **THEN** its prompt contains the `<entity_index>`, selected `<entity>` pages, org `<recent_activity>` rows, and `<user_preferences>` for the DM's author users — identical surface to an org task
- **AND** (with `ARCHIE_MEMORY_TOOLS=true`) all four read tools are registered

#### Scenario: Repo-scoped and org-scoped entities are selected

- **WHEN** a repo agent spawns for repo `backend` on a task titled "Stripe webhooks failing"
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an entity `payment-service` has `repos: [backend]` and an entity `stripe` has `scope: org`
- **AND** the number of signal-bearing `scope: org` entities is within `ARCHIE_MEMORY_ORG_INJECT_MAX`
- **THEN** both `payment-service` (repo match) and `stripe` (token overlap with the task title) full pages are injected

#### Scenario: One-hop graph expansion pulls a linked entity

- **WHEN** `payment-service` is selected and contains `depends_on [[postgres-prod]]`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** `postgres-prod` is not directly matched by the spawn context
- **THEN** `postgres-prod` is also injected

#### Scenario: Injection bound drops are logged

- **WHEN** more signal-bearing non-`org` entities qualify for injection than `ARCHIE_MEMORY_ENTITY_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **THEN** only the bound's worth of highest-scoring pages are injected
- **AND** the dropped entity slugs are logged

#### Scenario: touched_by relations are truncated at render time only

- **WHEN** a selected entity page holds more `touched_by` relations than `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** the injected `<entity>` block contains only the newest `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` `touched_by` relations
- **AND** relations of other types are rendered in full
- **AND** the entity file on disk retains every `touched_by` relation

#### Scenario: Feature-disabled passthrough

- **WHEN** memory is disabled (`ARCHIE_MEMORY=false`)
- **AND** any agent spawns
- **THEN** `enrichPromptWithMemory()` returns the input prompt byte-for-byte

#### Scenario: Injection-disabled passthrough

- **WHEN** memory is enabled but `ARCHIE_MEMORY_INJECT` is unset or not `true`
- **AND** any agent spawns
- **THEN** `enrichPromptWithMemory()` returns the input prompt byte-for-byte
- **AND** no store reads or entity selection are performed
- **AND** a single debug log line records that injection is disabled

### Requirement: Existing memory for ALL involved users SHALL be passed to extraction

The system SHALL load existing memory for every involved user — the task's AUTHOR users per "User memory ownership" (falling back to the deterministic non-Slack identifier when no human authored anything) — and pass all of them to the extraction prompt's `<user_memory>` block, labelled by user ID. The extractor SHALL only be permitted to return updates for users whose existing memory was provided in the input.

**Rationale:** The extractor needs each writable user's current memory to know whether an update duplicates or contradicts existing entries — and the writable set is the author set, so loading anyone else's memory would only leak it into the extraction prompt.

#### Scenario: Multi-user memory is loaded for extraction

- **WHEN** users alice and bob both authored messages in the transcript
- **AND** extraction runs
- **THEN** the prompt contains both alice's and bob's existing memory
- **AND** any user updates returned target a subset of {alice, bob}

### Requirement: Agent-callable memory read tools

The system SHALL expose a read-only memory tool surface to every agent track (PM, repo, plugin) via an in-process MCP server, gated by a dedicated environment variable `ARCHIE_MEMORY_TOOLS`. Tools SHALL be registered only when memory is enabled (`ARCHIE_MEMORY` ≠ `false`) AND `ARCHIE_MEMORY_TOOLS` is exactly `true`; the default (unset, or any other value) SHALL be **disabled** — no tools registered, no store reads, agent tool lists byte-identical to today. The tool flag SHALL be independent of `ARCHIE_MEMORY_INJECT`: pull SHALL work with push injection on or off.

The tool surface SHALL be exactly:

- `search_memory(query)` — lexical search over active entity pages (name, aliases, L0 summary, facts), user preference files, task summaries, and the recent-activity index, using the same tokenization as entity selection; returns a ranked, size-bounded list of hits (entity slug or file identifier, kind, L0/one-line summary or matching snippet). An empty result SHALL be a normal response, not an error.
- `read_entity(slug)` — the full rendered entity page for one slug, with `touched_by` relations truncated to `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` exactly as injection rendering does. Archived entities SHALL be readable and marked as archived.
- `read_task_summary(taskId)` — the contents of `memory/tasks/<taskId>/summary.md`.
- `grep_task_log(taskId, pattern)` — matching lines (with line numbers, count-bounded) from the task's `knowledge.log`.

All identifier arguments SHALL pass the existing path guards (`isValidEntitySlug`, task-ID validation, `getUserPath` rules) before any filesystem access; a failing guard SHALL return a tool error without touching the filesystem. The tool surface SHALL contain no operation that creates, mutates, or deletes memory content — writes remain funneled through the extraction side-agent. Tool implementation errors SHALL surface as tool-result errors to the calling agent, never as process faults.

**Authorization.** The tools SHALL receive the calling task's involvement scope at registration (task id, agent id, author user ids, and the lock flag — set when any calling-task channel is `ext-shared`, stamped `unknown`, or legacy-shared), derived once per spawn from task metadata and the transcript author scan; an absent or partial scope SHALL be treated as empty (fail-closed, self-only episodic access). Every tool handler SHALL deny an ext-shared caller before anything else (see "Ext-shared task memory lockdown"). Episodic reads (`read_task_summary`, `grep_task_log`) SHALL be served for a non-self target only when the target's persisted stamp is exactly `access: org`; any other state — no summary, no stamp, a first-iteration `access: dm` stamp, an unrecognized value — SHALL be denied (`no-access-stamp`). There is no overlap-based grant of any kind: DM-derived content is unreachable because prefs-only extraction writes no episodic artifacts, and v1 dm-stamped leftovers are denied like legacy. The caller's own task SHALL always be readable (ext-shared aside), including `grep_task_log` with no summary on disk. `grep_task_log` SHALL authorize before the knowledge log is ever opened. `search_memory` SHALL apply the same rules as a corpus pre-filter — user hits per "User memory ownership", task-summary and activity hits org-stamped-only (rows whose tasks lack an org-stamped summary are dropped) — so restricted content never reaches ranking; entity hits are org-wide for every non-ext-shared caller, DM-task callers included. A denial SHALL be a normal tool result carrying zero target content, worded as policy, and SHALL be recorded in pull telemetry with its reason.

**Rationale:** Push selection is bounded and can only miss silently; the always-injected `<entity_index>` tells agents what exists but not what it says. A pull path lets the agent that knows what it needs fetch it — and (via the pull sensor) turns every fetch into ground truth about what push should have injected. The authorization layer exists because the path guards prove only that an identifier is well-formed, not that the caller is entitled to it — an adversarial review demonstrated any agent could read any task's raw transcript and any user's preferences.

#### Scenario: Tools are registered only when the flag is on

- **WHEN** `ARCHIE_MEMORY_TOOLS=true` and memory is enabled
- **AND** an agent spawns on any track
- **THEN** the agent's tool list contains `search_memory`, `read_entity`, `read_task_summary`, and `grep_task_log`
- **AND** no memory write/modify/delete tool is present

#### Scenario: Disabled flag leaves the system untouched

- **WHEN** `ARCHIE_MEMORY_TOOLS` is unset or not `true`
- **AND** an agent spawns
- **THEN** no memory tools are registered
- **AND** no store reads are performed on behalf of the tool layer

#### Scenario: Search returns ranked bounded hits

- **WHEN** an agent calls `search_memory("stripe webhooks")` against a store containing a matching entity
- **THEN** the result lists at most the configured maximum hits, ranked, each with identifier, kind, and a one-line summary or snippet
- **AND** the full page content is not returned by search (the agent follows up with `read_entity`)

#### Scenario: Zero-result search is a normal response

- **WHEN** an agent calls `search_memory` with a query matching nothing
- **THEN** the tool returns an empty result set without error

#### Scenario: Malformed identifiers are rejected before filesystem access

- **WHEN** an agent calls `read_entity("../../etc/passwd")` or `read_task_summary` with a malformed task ID
- **THEN** the tool returns an error
- **AND** no file outside the memory store is read

#### Scenario: Pull works with injection off

- **WHEN** `ARCHIE_MEMORY_TOOLS=true` and `ARCHIE_MEMORY_INJECT` is unset
- **AND** an agent calls `read_entity` with a valid slug
- **THEN** the full entity page is returned even though nothing was push-injected

#### Scenario: Org-derived tasks are readable across tasks

- **WHEN** an agent on task A calls `read_task_summary` for task B whose summary carries `access: org`
- **THEN** the summary content is returned

#### Scenario: v1 dm-stamped summaries are denied even with full overlap

- **WHEN** task B carries a first-iteration summary stamped `access: dm` and the caller's task shares B's DM channel and B's users
- **AND** the caller calls `read_task_summary` or `grep_task_log` for B
- **THEN** the result is a normal (non-error) denial carrying none of B's content (reason `no-access-stamp`)
- **AND** for `grep_task_log`, B's knowledge log is never opened
- **AND** a pull record with `denied: true` and the reason is appended

#### Scenario: Current DM tasks have nothing to deny

- **WHEN** a DM-derived task completes under prefs-only extraction
- **AND** any other task later calls `read_task_summary` for it
- **THEN** the call is denied `no-access-stamp` — no summary exists on disk (never written, or retracted by the downgraded re-completion — see "Retraction on downgrade"), and its content exists nowhere outside its own `knowledge.log`

#### Scenario: Legacy artifacts without an access stamp are denied

- **WHEN** an agent calls `read_task_summary` for a pre-policy task whose summary has no `access:` key
- **THEN** the call is denied (reason `no-access-stamp`) with no content

#### Scenario: Self access always works

- **WHEN** an agent calls `grep_task_log` with its own task id and no summary exists yet
- **THEN** matching lines from its own log are returned (a missing log is a plain miss, not a denial)

### Requirement: Pull-call telemetry

When memory tools are enabled and a read tool is invoked during a known task, the system SHALL append exactly one JSON line to `workdir/memory/tasks/<taskId>/telemetry.jsonl` per invocation, creating the task directory when absent. The line SHALL carry a schema version, a record-kind discriminator distinguishing pull records from selection records (existing selection lines without a kind field SHALL remain valid and be read as selection records), an ISO timestamp, the task ID, the calling agent, the tool name, the query or arguments, and a result summary (returned identifiers, result count, zero-result flag). Invocations refused by the authorization policy SHALL be recorded with `denied: true` and a `denyReason`. The confidentiality gate SHALL append `kind: "extraction-skip"` records (task ID + reason) and `kind: "extraction-prefs-only"` records (task ID) to the same file, so both the policy's memory loss and the DM prefs-only carve-out stay measurable. Evidence validation (see "User memory ownership") SHALL append `kind: "user-update-dropped"` records (task ID, target user, cited ids), so misattribution drops stay measurable too. Sensor failures SHALL NOT affect the tool result: on any telemetry write error the system SHALL log a warning and return the tool result exactly as if the sensor did not exist. When no task ID is available, the system SHALL skip the record silently while still serving the tool call.

**Rationale:** Pull calls are revealed ground truth — a pulled-but-never-injected page is a measured push-recall miss, and a zero-result search is a measured store gap. These records are the input that makes the later memory-value eval honest, and they cannot be backfilled.

#### Scenario: Pull call leaves a telemetry record

- **WHEN** an agent working task `task-X` calls `search_memory("payments")`
- **THEN** `memory/tasks/task-X/telemetry.jsonl` gains exactly one new line
- **AND** the line parses as JSON with the pull kind, tool name, query, returned identifiers, and result count

#### Scenario: Zero-result search is recorded as a store gap

- **WHEN** an agent's `search_memory` call returns no hits
- **THEN** the pull record carries a zero-result flag and the query text

#### Scenario: Sensor failure never affects the tool call

- **WHEN** the telemetry path is unwritable
- **AND** an agent calls a memory read tool
- **THEN** the tool returns its normal result
- **AND** a warning is logged

#### Scenario: Mixed record kinds coexist in one telemetry file

- **WHEN** a task has both an enriched spawn (selection record) and read-tool calls (pull records)
- **THEN** all records append to the same `telemetry.jsonl`
- **AND** a reader can partition them by the kind discriminator, treating kind-less lines as selection records

#### Scenario: Denied calls are recorded and excluded from store gaps

- **WHEN** an agent's `search_memory` or episodic read is refused by the authorization policy
- **THEN** the pull record carries `denied: true` and the reason
- **AND** the eval's store-gap list does not include the denied query (policy outcome, not a store gap)

#### Scenario: Prefs-only extraction is recorded

- **WHEN** a DM-carrying task completes and extraction runs in prefs-only mode
- **THEN** the task's `telemetry.jsonl` gains one `kind: "extraction-prefs-only"` record

