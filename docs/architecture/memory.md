# Memory Layer

Archie stores durable knowledge under `WORKDIR/memory/`. The store is bound to one authenticated Slack workspace and separates organization-wide memory from exact private conversation history.

The implementation lives in `src/memory/`. Slack audience classification is in `src/connectors/slack/client.ts`; fixed task-destination checks are in `src/tasks/`.

## Safety model

Memory access comes from live Slack API metadata, never transcript text or model output.

- The first Slack channel fixes `memory_destination.channel_id`. Public and private tasks remain in that exact channel; DM tasks remain in that exact `D…` conversation.
- Legacy tasks derive the destination from their home channel, default Slack thread, or one unambiguous linked Slack channel. Ambiguous tasks fail closed.
- Internal public channels authorize public memory. Internal private channels and MPIMs authorize public memory plus their exact private channel directory. Internal DMs authorize public memory plus their exact DM directory. Verified bots and app users from the home workspace do not disqualify channel membership, but they remain ineligible as memory authors and DM partners.
- Slack Connect, pending external sharing, restricted guests, external users, missing provenance, and lookup failures deny memory authorization.
- Public/private conversion changes live authorization at the fixed destination; it does not rewrite persisted task metadata.
- Slack delivery checks only the task's fixed destination. New memory reads and extraction still use live audience authorization, but messages, files, reactions, status updates, approval cards, PR cards, and `post_to_channel` are not vetoed by memory readiness or audience classification.
- When the scoped store is unavailable or `ARCHIE_MEMORY=false`, destination restrictions remain but normal Slack and trigger delivery continues. Context already loaded into an SDK session is not revoked when memory is disabled or the audience later becomes ineligible; subsequent reads and extraction are denied.

Slack authors are resolved by the host. Only internal, non-restricted human `U…` or `W…` IDs enter `memory_authors`; `memory_message_authors` maps each ingested Slack timestamp to its author. A profile update is accepted only when its cited source timestamp belongs to that profile owner. Body mentions, quoted text, model output, bot IDs, and fallback IDs cannot authorize profile reads or writes.

Private task memory is never injected into prompts or copied into the public corpus. The sole explicit exception is an author-approved preference, whose previewed text enters that author's shared workspace profile. Memory reads and extraction writes reclassify the fixed destination while memory is active. Extraction authorizes before reading the transcript and again before persistence; DM persistence also requires the partner user to remain unchanged between those checks.

The task destination is the privacy boundary. A public task reads public memory. A private-channel task reads public memory plus that exact channel. A DM task reads public memory plus that exact `D…` conversation. An authorized task without recorded authors still receives public entities and activity, but no profiles.

Task messages, files, reactions, status updates, approval cards, PR cards, and `post_to_channel` use the same fixed-destination check without consulting memory authorization. Transport acknowledgements and trigger lifecycle announcements carry no task memory. Repository writes, GitHub operations, plugins, and other external tools are outside this Slack-memory boundary.

Trigger proposals and content edits must target the authoring task's destination. Existing user-bound triggers separately verify that the fixed destination is a DM with the exact recipient; this check does not depend on memory eligibility. Pausing, resuming, and deleting a visible trigger do not copy task context. A fired trigger creates a fresh task whose memory scope comes from its live Slack destination; no creator-task memory state is propagated. Existing triggers need no migration.

## Workspace binding and startup

After Slack `auth.test`, initialization validates `WORKDIR/memory/.scoped-v1.json` against the authenticated Slack team ID.

- An absent or empty memory directory is initialized for that team.
- A matching marker enables memory and registers the completion listener once.
- A mismatched or malformed marker disables memory reads and writes.
- A non-empty unmarked directory is reset in place and initialized as a fresh scoped store.
- Missing team identity disables memory.

Memory initialization failure does not stop Slack events, task recovery, or scheduled triggers. There is no automatic migration or old-layout reader.

## Storage layout

```text
WORKDIR/memory/
├── .scoped-v1.json
├── public/
│   ├── users/<user-id>.md
│   ├── entities/
│   │   ├── <slug>.md
│   │   └── index.md
│   ├── <channel-id>/
│   │   ├── <task-id>.md
│   │   └── rolling-summary.md
│   └── recent-activity.md
├── private/
│   └── <channel-id>/
│       ├── <task-id>.md
│       └── rolling-summary.md
└── runtime/pending-extractions.md
```

`public/users/` contains public profiles, not DM history. Every task directory uses its Slack conversation ID; DMs therefore use `D…`, while public/private channels and MPIMs use `C…` or `G…`.

Every public and private task has one canonical Markdown file with trusted task ID, channel ID, status, quoted creation/extraction timestamps, and a sanitized `# Summary`. Public files additionally retain links, domain, applied profile/entity updates, related task IDs, and housekeeping projections. Private files end after the summary.

`rolling-summary.md` is a derived inspection table rebuilt from that channel directory after each canonical replacement. It lists the newest 50 records by extraction time and task ID, with relative links and normalized excerpts of at most 200 characters. Older canonical files remain indefinitely and stay available to tools. Overviews are neither injected nor searched.

Canonical task and overview writes use temporary files followed by rename in the destination directory. If canonical replacement succeeds but overview replacement fails, the extraction remains in `runtime/pending-extractions.md`; replay replaces the same task file and rebuilds a deduplicated overview. Canonical files, not overviews, are authoritative.

## Extraction flow

```text
task completion → authorize → extract → reauthorize → canonical task file → channel overview
                                          ├─ public: profiles/entities/activity + housekeeping
                                          └─ private: summary only
```

Public extraction loads profiles only for structured task authors plus the complete persisted entity index. It applies attributed profile updates, sanitized entity updates, and the existing activity/housekeeping behavior. Entity pages retain the last 30 stored observations. The persisted entity index remains complete, including archived entities.

After the first authorization check, extraction reads the completed task's `knowledge.log` through `readKnowledgeLog()`. The log remains a write-only audit/extraction record for the running PM: inbound content is delivered to the PM inline, and neither extraction path depends on removed participant or task-owner metadata.

Private-channel and DM extraction passes empty profile and entity context to the extractor and writes only the sanitized canonical task file and derived overview for its exact destination. It does not update public profiles, entities, activity, related tasks, or housekeeping projections.

Rejected summaries produce no task file and no overview row. Tasks with no destination or denied live authorization return before transcript access.

## Agent recall

```text
prompt → bounded active-entity catalogue ─┐
                                         ├→ search_memory → read_entity/read_task_summary
full authorized on-disk corpus ──────────┘
```

### Prompt injection

`ARCHIE_MEMORY_INJECT=true` enables public profile/activity context plus an active-entity catalogue. The catalogue uses the persisted entity reader, excludes archived records, sorts by latest observation touch descending then slug, and contains complete rows until its next row would exceed the limit. Its XML wrappers, table header, omission notice, and tool guidance are included in the 4,000-character JavaScript string-length limit.

Each task runs one PM SDK session. `src/agents/spawn.ts` performs live task authorization once during that session's setup, appends authorized injection once, and attaches the task-bound memory MCP server once. Native workers run inside the same session and any memory-tool call is evaluated against the same task metadata and live destination; there are no worker-specific memory attachments or specialist spawn branches.

Audience changes and flag changes affect the next authorization check. They do not remove memory already present in the SDK session's context, and the session is not replaced solely to revoke that context.

No full entity page is injected, including `org` pages. Scope and repository metadata no longer drive automatic full-page selection. When memory tools are enabled, the catalogue tells agents to use `search_memory` for omitted knowledge and `read_entity` for details. No catalogue is emitted when there are no active entities.

Private task files and channel overviews are never injected.

### Memory tools

`ARCHIE_MEMORY_TOOLS=true` attaches five host-side MCP tools after live authorization. The read tools are:

- `search_memory` performs deterministic lexical search across complete entity contents including archived entities, public activity, profiles for structured task authors, all canonical public task files, and canonical task files in the exact authorized private directory. It does not search overviews.
- `read_entity` resolves a public entity by slug or alias, including archived records.
- `read_task_summary` checks the exact authorized private directory first, then valid immediate public channel directories, and returns the canonical Markdown file.

Task search scans full files and returns excerpts of at most 400 characters around the earliest matching term. Public task hits have weight 2 and private task hits retain weight 4. Existing tokenization, token-overlap scoring, source weights, recency ordering, task-ID deduplication, and result limits remain unchanged.

The shared task reader accepts only valid immediate channel directories and regular canonical task Markdown files. It skips symlinks, temporary files, overviews, invalid identifiers, unrelated directories, and malformed or location-mismatched frontmatter. Missing directories are empty; other I/O errors surface. It never reads task transcripts or unrelated private destinations.

All tool responses are XML-escaped, labelled as untrusted evidence, and limited to 8,000 characters.

### Explicit memory writes

The same `ARCHIE_MEMORY_TOOLS` gate attaches `remember_preference` and `remember_fact`. Both require the originating Slack message timestamp; the host resolves its author from task metadata and checks the live audience again when the write runs on the existing memory lifecycle queue. Tool input cannot select another user or destination. `ARCHIE_MEMORY=false` disables writes too.

`remember_preference` saves a descriptive bullet to that author's public workspace profile. In public channels it saves immediately. In DMs and private channels, the host posts the exact proposed bullet and saves only after the author clicks **Save across conversations**. The pending request is stored in task metadata for up to one hour. Other viewers cannot approve it. The private extractor still writes only an exact-conversation task summary; it does not publish private facts or surrounding DM context.

`remember_fact` adds one observation to an existing public entity or creates an entity when given its type and summary. It accepts only authorized public conversations. The existing entity index is rebuilt after a save. Both tools report a successful save only after their memory writer succeeds, and identical retries return unchanged. Explicit memories follow ordinary housekeeping and entity observation retention.

The SDK transcript is not consumed by extraction, `events.jsonl` has no memory consumer, and `knowledge.log` is extracted only after completion with a bounded transcript. The originating message is already in the task log; explicit saves use the existing memory writers directly.

## Limits and flags

| Surface | Limit or behavior |
|---|---|
| Canonical task files | Retained indefinitely |
| Channel overview | Newest 50 task records |
| Overview excerpt | 200 characters |
| Entity observations | Last 30 stored per entity |
| Injected entity catalogue | 4,000 characters including wrappers/instructions/notices |
| Injected full entity pages | None |
| Tool response | 8,000 characters |
| Search results | 10 by default, 20 maximum |

| `ARCHIE_MEMORY_INJECT` | `ARCHIE_MEMORY_TOOLS` | Recall behavior |
|---|---|---|
| off | off | Collection only |
| on | off | Public profiles/activity plus bounded entity catalogue |
| off | on | Full authorized corpus through tools; no injected memory |
| on | on | Catalogue-assisted tool recall plus existing profiles/activity |

`ARCHIE_MEMORY` is the master switch and defaults enabled; exact `false` disables initialization, extraction, injection, and tools. Injection and memory tools default off independently. `ARCHIE_MEMORY_HOUSEKEEPING` defaults enabled. Existing profile, section, staleness, and entity soft-cap variables remain unchanged. The catalogue limit is fixed and applies only to each injected catalogue block, not the whole prompt or conversation.

## Reset, rollout, and rollback

This layout requires a fresh memory store.

1. Stop Archie.
2. Move `WORKDIR/memory/` to a backup outside the active workdir, then reset the active directory.
3. Deploy and restart Archie.
4. Verify `.scoped-v1.json` has the expected Slack team ID and new task files appear under channel directories.
5. Start with injection and tools disabled; enable either independently after inspecting collected output.

Never automatically erase an existing marked store. Current startup behavior still resets a non-empty unmarked store. Never copy private task files into `public/`, edit the workspace marker to bypass a mismatch, or reuse a scoped store with another Slack workspace.

Rolling back to an older binary requires restoring its matching store backup. Setting `ARCHIE_MEMORY=false` stops memory use but leaves the new store on disk and does not restore the prior layout.
