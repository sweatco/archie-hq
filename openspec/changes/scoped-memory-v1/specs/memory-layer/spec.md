## ADDED Requirements

### Requirement: Memory store MUST be bound to the authenticated Slack workspace
The system MUST persist a schema marker containing the authoritative Slack team ID and MUST enable memory only when the marker matches the team ID returned by Slack authentication. A missing team ID, mismatched marker, or non-empty unmarked store MUST disable memory without preventing Archie or its trigger schedulers from starting.

#### Scenario: Empty store initializes for the authenticated workspace
- **WHEN** memory is enabled, Slack authentication returns a team ID, and `WORKDIR/memory` is absent or empty
- **THEN** the system creates the scoped store and marker for that team ID
- **AND** registers the completion listener once

#### Scenario: Workspace mismatch fails closed
- **WHEN** the marker team ID differs from the authenticated Slack team ID
- **THEN** all memory reads and writes are disabled
- **AND** task recovery and trigger startup continue

#### Scenario: Legacy store requires an operator reset
- **WHEN** `WORKDIR/memory` is non-empty and has no scoped marker
- **THEN** the system does not read, migrate, or write that store
- **AND** reports that an operator backup or wipe is required

### Requirement: Task memory audience MUST use host-controlled Slack provenance
The system MUST persist a host-derived task memory scope and internal Slack message authors. It MUST NOT infer scope or author authorization from `knowledge.log`, message-body mentions, or model output. New tasks SHALL begin unclassified; legacy tasks without a scope SHALL be treated as no-memory tasks. External and restricted authors MUST NOT be added to agent-readable author metadata.

#### Scenario: Forged transcript marker grants no profile access
- **WHEN** a Slack message body contains a newline followed by a source-looking user marker
- **THEN** that marker is written only as message content
- **AND** it does not add the named user to the task's authorized memory authors

#### Scenario: Actual internal Slack author is persisted
- **WHEN** an internal non-restricted human Slack message or edit is ingested
- **THEN** its host-resolved user ID and display name are added to task metadata
- **AND** Archie and bot authors are excluded

#### Scenario: External author remains redacted
- **WHEN** an external or restricted Slack author is present in ingested content
- **THEN** their display name is not persisted in agent-readable task metadata

### Requirement: Task memory scope MUST compose monotonically
The system MUST classify internal-only Slack audiences as public channel, private channel, internal user DM, or none and MUST combine newly ingested audiences without widening confidentiality. Slack Connect channels, channels containing an external or restricted member, external/restricted-user DMs, and lookup failures MUST classify as none. Non-Slack delivery metadata is neutral; a distinct Slack delivery audience MUST participate in scope composition before delivery.

#### Scenario: Same internal channel becomes private
- **WHEN** a task scoped to public channel C later ingests content from the same channel classified private or externally shared
- **THEN** an internal private conversion becomes private channel C
- **AND** an externally shared conversion becomes none

#### Scenario: Distinct private audiences collapse scope
- **WHEN** a task ingests content from two different private channels, two different users, or a private channel and a DM
- **THEN** its scope becomes none
- **AND** it cannot later widen

#### Scenario: Private and distinct public audiences collapse scope
- **WHEN** a task scoped to private channel C ingests from or is about to deliver into distinct public channel P
- **THEN** its scope becomes none before memory read or delivery

#### Scenario: Multiple internal public channels remain public
- **WHEN** a task ingests content from more than one explicit public non-shared channel and every member is internal and non-restricted
- **THEN** it remains public with no single locality channel

#### Scenario: Outsider-visible audience disables memory
- **WHEN** a channel is externally shared, pending external sharing, contains an external/restricted member, or a DM partner is external/restricted
- **THEN** that audience classifies as none
- **AND** receives no public prompt injection or memory tools

#### Scenario: Scheduled channel binding is classified before start
- **WHEN** a channel-bound scheduled trigger fires without an inbound message
- **THEN** the approved channel binding is strictly classified and persisted before the task starts
- **AND** lookup failure sets scope none without blocking the trigger

#### Scenario: Conversation lookup fails
- **WHEN** Slack conversation classification fails or lacks required fields
- **THEN** memory for that audience is classified none
- **AND** normal task ingestion and scheduled-trigger startup continue when no memory has been exposed
- **AND** a task that already received memory rejects delivery to that now-unclassified audience

#### Scenario: Memory-derived trigger survives delayed and future authorization
- **WHEN** an exposed task proposes or edits a trigger
- **THEN** the trigger persists the composed memory exposure sensitivity
- **AND** approval reclassifies the live binding before enabling it
- **AND** every fire reclassifies the live binding and pauses instead of spawning when incompatible
- **AND** a compatible fired task receives the persisted exposure before its first agent prompt

### Requirement: Private outcomes MUST remain in their exact audience vault
The system SHALL retain outcomes from internal-only private channels, MPIMs, and DMs only in the exact channel or user rolling file. It MUST NOT write private profiles, entities, public task summaries, or public activity rows. Slack Connect, guest-visible, external-DM, mixed, and failed-classification tasks MUST read and write no memory.

#### Scenario: Private channel task completes
- **WHEN** a task scoped to private channel C completes
- **THEN** a sanitized summary-only outcome is appended to `memory/private/channels/C.md`
- **AND** no artifact is written to the public corpus

#### Scenario: Internal DM task completes
- **WHEN** a task scoped to internal DM partner U completes
- **THEN** its sanitized outcome is appended to `memory/private/users/U.md`

#### Scenario: Mixed or unclassified task completes
- **WHEN** a task scope is none, unclassified, or absent
- **THEN** extraction returns before reading its transcript
- **AND** no memory artifact is written

### Requirement: Rolling outcomes MUST be bounded and deterministic
Each channel or user rolling file SHALL contain at most 50 newest-first entries. An entry MUST include a validated task ID, ISO creation time, optional host-built Slack thread link, and sanitized single-line summary no longer than 2,000 characters. Writes MUST be atomic and serialized with extraction.

#### Scenario: Existing task outcome is replaced
- **WHEN** an outcome for an existing task ID is written again
- **THEN** the old entry is replaced rather than duplicated
- **AND** the replacement is placed according to newest-first ordering

#### Scenario: Rolling file exceeds capacity
- **WHEN** a 51st distinct outcome is appended
- **THEN** the oldest entry is removed
- **AND** exactly 50 entries remain

### Requirement: Agents MAY pull scoped memory through read-only tools
When `ARCHIE_MEMORY_TOOLS=true`, the master memory flag is enabled, and the current task has an internal authorized audience, every agent track SHALL receive exactly three host-side read-only tools: `search_memory`, `read_entity`, and `read_task_summary`. No tool SHALL mutate memory or open a task transcript. Tasks scoped none, including outsider-visible tasks, MUST NOT receive the memory server.

#### Scenario: Search returns deterministic scoped hits
- **WHEN** an agent searches with non-empty lexical query tokens
- **THEN** the tool searches public entities/activity, public profiles for structured internal task authors, and the exact authorized private audience file
- **AND** ranks positive matches by token overlap, kind, recency, and stable identifier
- **AND** deduplicates task IDs and returns at most the requested bound

#### Scenario: Entity read is public-only
- **WHEN** an agent calls `read_entity` with a valid slug or alias
- **THEN** only the public entity corpus is searched
- **AND** malformed or traversal-shaped identifiers are rejected before file access

#### Scenario: Task summary prefers authorized locality
- **WHEN** a task ID exists in the current authorized rolling file and in the public corpus
- **THEN** `read_task_summary` returns the authorized local entry
- **AND** never scans another channel or user's private directory

#### Scenario: Memory tool results are framed safely
- **WHEN** a read tool returns stored content
- **THEN** it XML-escapes that content, labels it untrusted evidence, and bounds the response to 8,000 characters with a valid closing envelope

### Requirement: Private tool reads MUST reauthorize at invocation time
Every private channel read MUST resolve current task metadata and strictly reclassify the exact Slack conversation at tool invocation. The server MUST NOT authorize private reads from a spawn-time scope snapshot.

#### Scenario: Private channel becomes public during an agent session
- **WHEN** an agent spawned in private channel C calls a memory tool after C is classified public
- **THEN** the tool does not read `private/channels/C.md`
- **AND** may still return public memory

#### Scenario: DM partner changes or becomes external
- **WHEN** a user-scoped task no longer resolves to the same internal non-restricted DM partner
- **THEN** private user memory is denied and the task scope becomes none

#### Scenario: Live classification fails
- **WHEN** Slack returns an error while authorizing a private channel read
- **THEN** the tool denies private memory without failing the task
- **AND** returns public results only when the current audience is still verified internal

### Requirement: Memory-exposed agents MUST have host-enforced deny-by-default egress
After memory reaches an agent, the host MUST deny every tool except exact audited host-local tool identities. It MUST NOT trust MCP read-only annotations, server-name prefixes, or newly added tools. Bash, research, file bridge, repository/external tools, and all plugin MCP servers MUST be denied. Allowed Slack delivery and reaction tools MUST retain live audience authorization. Plugin MCP server keys containing `__` MUST be rejected because they cannot be safely qualified.

#### Scenario: Read-only annotation cannot bypass egress
- **WHEN** an external MCP tool reports `readOnly: true` after memory exposure
- **THEN** the host denies the call before execution

#### Scenario: Exact host-local delivery remains gated
- **WHEN** an exposed agent invokes an exact audited Slack delivery or reaction tool
- **THEN** the tool remains available
- **AND** its live destination must pass the task memory delivery check before Slack mutation

#### Scenario: Qualified-name spoof is denied
- **WHEN** a plugin server key contains `__`, shares an audited prefix, or exposes an unknown tool under an audited server
- **THEN** registration or invocation is denied

### Requirement: Persisted summaries MUST reject secrets and instructions
Task summaries, activity summaries, and rolling outcomes MUST be rejected when they resemble credentials or persistent agent instructions. A rejected summary MUST NOT be written through truncation or another fallback.

#### Scenario: Unsafe task summary is rejected
- **WHEN** extraction returns a secret-shaped or instruction-shaped task summary
- **THEN** no task summary or activity row containing it is written
- **AND** independently sanitized public profile/entity updates may still be applied

## MODIFIED Requirements

### Requirement: File-based Markdown storage
The system SHALL persist human-readable memory artifacts under `WORKDIR/memory/`: global public profiles, entities, task summaries, and activity under `public/`; compact internal-private channel outcomes under `private/channels/<channel-id>.md`; compact internal DM outcomes under `private/users/<user-id>.md`; and the durable queue under `runtime/`. Public outcomes MUST NOT be duplicated into private audience directories. The schema/workspace marker SHALL be JSON because it is machine-owned validation metadata rather than agent memory.

#### Scenario: Public profile is stored by Slack ID
- **WHEN** a public task produces an authorized user-profile update for `U07ABC123`
- **THEN** the resulting Markdown file is `workdir/memory/public/users/U07ABC123.md`

#### Scenario: Private outcome uses an audience directory
- **WHEN** a private channel task produces a valid outcome
- **THEN** it is stored in `workdir/memory/private/channels/<channel-id>.md`

### Requirement: User memory MUST be keyed by stable identifier
Public collaboration profiles SHALL be keyed by raw Slack human user IDs (`U…` or `W…`) obtained from host-resolved message authors. Display names SHALL live in YAML frontmatter, not filenames. Bot IDs, bare names, transcript mentions, and non-Slack fallback IDs MUST NOT create or authorize new profile files; legacy fallback files MAY remain in an unscoped backup but are not loaded or updated by scoped memory.

#### Scenario: Two users with the same display name remain distinct
- **WHEN** two authorized public-task authors share a display name but have different Slack IDs
- **THEN** their profiles are stored in distinct files keyed by those IDs

#### Scenario: Body mention does not create a profile
- **WHEN** a public task author mentions another Slack user who did not author an ingested message
- **THEN** no profile read or write is authorized for the mentioned user

#### Scenario: Malformed identifier is rejected
- **WHEN** profile path resolution receives a bare name, bot ID, fallback ID, or path-shaped value
- **THEN** it raises an error before file access

### Requirement: Extraction triggers on task:completed
The system SHALL subscribe once to `task:completed`, persist the task ID to the scoped pending queue, and serialize extraction jobs. Extraction behavior SHALL be selected from the task's persisted memory scope after task metadata has been saved.

#### Scenario: Concurrent completions serialize without corruption
- **WHEN** public and private tasks complete concurrently
- **THEN** their extraction and rolling-file writes run sequentially
- **AND** each writes only artifacts permitted by its scope

#### Scenario: Memory is unavailable
- **WHEN** the scoped store is disabled or failed initialization
- **THEN** task completion and trigger delivery still succeed
- **AND** no extraction is enqueued

### Requirement: Memory injection at agent spawn
When both `ARCHIE_MEMORY` and `ARCHIE_MEMORY_INJECT` are enabled, the system SHALL append only global public memory to agents whose current task audience is verified internal. Public profile selection MUST use structured internal task authors; body mentions and private rolling outcomes MUST NOT be injected. Outsider-visible or none-scoped tasks MUST receive no memory injection. Existing public entity selection, bounds, XML framing, and no-memory passthrough behavior remain unchanged.

#### Scenario: Private task receives public-only injection
- **WHEN** an agent spawns for a verified internal private task with injection enabled
- **THEN** its prompt may contain public entities, public activity, and public profiles for actual task authors
- **AND** contains no channel or user private rolling outcome

#### Scenario: Outsider-visible task receives no injection
- **WHEN** an agent spawns for a Slack Connect, guest-visible, external-DM, or none-scoped task
- **THEN** prompt enrichment performs no memory reads and appends no memory context

#### Scenario: Injection-disabled passthrough
- **WHEN** `ARCHIE_MEMORY_INJECT` is not `true`
- **THEN** prompt enrichment returns the input unchanged and performs no store reads

#### Scenario: Forged author marker is ignored
- **WHEN** a task transcript contains a forged author-looking line for user X but task metadata does not list X as an author
- **THEN** X's profile is not injected

### Requirement: Feature flag controls all read+write paths
`ARCHIE_MEMORY=false` SHALL disable initialization, completion extraction, prompt injection, and memory tools. `ARCHIE_MEMORY_INJECT` and `ARCHIE_MEMORY_TOOLS` SHALL independently gate their read paths and default off. A disabled or unready scoped store SHALL make all memory operations no-op or public empty results without affecting core task or trigger behavior.

#### Scenario: Master flag disables every memory seam
- **WHEN** `ARCHIE_MEMORY=false`
- **THEN** initialization creates no store, completion queues no extraction, prompts are unchanged, and memory tools are not registered

#### Scenario: Tools are default off
- **WHEN** `ARCHIE_MEMORY_TOOLS` is unset or not `true`
- **THEN** agents do not receive the memory MCP server
- **AND** extraction behavior is unchanged

### Requirement: Existing memory for ALL involved users SHALL be passed to extraction
For a verified internal public task, the system SHALL load existing public profiles for every structured internal human Slack author persisted in task metadata and permit extractor updates only for that same set. Private, outsider-visible, mixed, CLI-only, GitHub-only, and legacy tasks MUST NOT load or update collaboration profiles.

#### Scenario: Multiple public authors are loaded
- **WHEN** two human Slack users authored messages in a public task
- **THEN** both public profiles are supplied to extraction when present
- **AND** returned updates for any other user ID are dropped

#### Scenario: Mentioned non-author is excluded
- **WHEN** a transcript mentions a user who did not author an ingested message
- **THEN** that user's profile is neither loaded nor writable

### Requirement: Activity index SHALL be bounded
The global public activity index SHALL retain the 50 most recent valid public-task rows, newest first. Each channel/user rolling file SHALL independently retain 50 valid outcomes. Private outcomes MUST NOT enter the global activity index.

#### Scenario: Public activity trims to cap
- **WHEN** 51 valid public task rows are written
- **THEN** the oldest row is removed and 50 remain

#### Scenario: Private task does not affect public activity
- **WHEN** a private task completes with a valid outcome
- **THEN** the public activity index is unchanged

### Requirement: Per-task summary written to session shared dir
The system SHALL write `workdir/memory/public/tasks/<taskId>.md` only for a verified internal public task that produces a valid non-null extraction result. Private and none-scoped tasks MUST NOT write a global task summary or run global related-task processing; private tasks write only their audience rolling outcome. The deprecated session-shared summary path MUST NOT be written.

Public task summaries SHALL retain the existing YAML metadata, rich summary, applied memory updates, and related-task sections, with all links and content sanitized before persistence. Related-task selection SHALL use only the public corpus.

#### Scenario: Public task writes rich summary
- **WHEN** a verified internal public task completes with a valid extraction
- **THEN** `workdir/memory/public/tasks/<taskId>.md` contains its rich summary and public memory updates
- **AND** the deprecated session-shared summary path is absent

#### Scenario: Private task writes no public summary
- **WHEN** an internal private channel or DM task completes with a valid compact outcome
- **THEN** no file exists under `memory/public/tasks/` for that task
- **AND** related-task selection does not read or reference that private outcome

### Requirement: Entities SHALL be stored as first-class Markdown pages
The system SHALL persist public durable subjects as Markdown pages at `WORKDIR/memory/public/entities/<slug>.md`, preserving the existing entity schema, validation, relations, status, index generation, and deterministic housekeeping behavior. Only verified internal public tasks MAY create or update entities. People SHALL remain public profiles rather than entities.

#### Scenario: Public task writes an entity page
- **WHEN** verified internal public extraction determines a durable service fact
- **THEN** the validated page is written under `memory/public/entities/<slug>.md`

#### Scenario: Private task does not touch entities
- **WHEN** private summary-only extraction completes
- **THEN** no public entity or entity-index file is created or changed by that task

### Requirement: Organizational knowledge SHALL be stored as entities, not a flat file
The system SHALL represent public organizational knowledge as scoped entity pages under `memory/public/entities/` and SHALL NOT create `org.md`. Only verified internal public extraction may update organizational entities; no legacy backfill is performed because scoped v1 requires an operator reset of the old store.

#### Scenario: Public organizational fact becomes an entity observation
- **WHEN** verified internal public extraction returns a valid durable organization-wide fact
- **THEN** it is persisted as an observation on a `scope: org` public entity

#### Scenario: Legacy org file is not migrated
- **WHEN** an unmarked legacy store contains `org.md`
- **THEN** scoped memory remains disabled until the operator backs up or wipes the legacy store
- **AND** performs no automatic backfill

### Requirement: User memory SHALL be housekept
The system SHALL retain automatic public-profile housekeeping on the serialized runtime extraction queue, using the existing touched metadata, size budgets, staleness rules, no-new-facts validator, and `ARCHIE_MEMORY_HOUSEKEEPING` gate. Profile paths SHALL resolve under `memory/public/users/`. The standalone manual housekeeping CLI MUST refuse to mutate a scoped store because it cannot authenticate the active Slack workspace or join the runtime queue; adding an administrative endpoint is outside v1.

#### Scenario: Public profile cap triggers automatic housekeeping
- **WHEN** a verified internal public profile update exceeds its configured cap
- **THEN** housekeeping is serialized after extraction against `memory/public/users/<id>.md`

#### Scenario: Housekeeping is disabled
- **WHEN** `ARCHIE_MEMORY_HOUSEKEEPING=false`
- **THEN** automatic housekeeping does not run

#### Scenario: Standalone housekeeping refuses scoped store
- **WHEN** the standalone housekeeping command targets a scoped-v1 store
- **THEN** it exits non-zero before mutation
- **AND** reports that automatic in-process housekeeping is the supported mode

### Requirement: Ejectability
Setting `ARCHIE_MEMORY=false` SHALL immediately disable the capability. Code removal SHALL remain limited to `src/memory/`, the memory extraction prompt, task metadata/scope hooks, Slack classification hooks, initialization, and agent-spawn registration, plus runtime `WORKDIR/memory/`; it SHALL require no database migration or external-service cleanup.

#### Scenario: Disabled memory leaves core behavior operational
- **WHEN** all memory flags are disabled
- **THEN** build and test verification passes
- **AND** Slack events, task routing, message triggers, scheduled triggers, and user delivery continue without memory
