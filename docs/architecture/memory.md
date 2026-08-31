# Scoped memory architecture

Archie stores durable knowledge under `WORKDIR/memory/`. Scoped memory is bound to one authenticated Slack workspace and separates organization-wide facts from private channel and DM outcomes.

The implementation lives in `src/memory/`. Slack audience classification is in `src/connectors/slack/client.ts`; task destination checks are in `src/tasks/`.

## Safety model

Memory access is derived from Slack API data, never from transcript text or model output.

- The first Slack channel fixes `memory_destination.channel_id` for the task. It never changes.
- Legacy tasks derive the destination from their home channel, default Slack thread, or one unambiguous linked Slack channel. Ambiguous tasks fail closed instead of binding to the next attempted post.
- Internal public channels produce public authorization.
- Internal private channels and MPIMs produce exact-channel authorization.
- An internal DM produces authorization for that channel's current partner-user vault.
- Slack Connect, pending external sharing, restricted guests, external users, missing provenance, and lookup failures deny memory authorization.
- Public and private tasks can deliver only to their fixed channel. A DM task can deliver only to its fixed DM channel. Use a separate task for another destination.
- Public/private conversion changes the live memory available at that same destination; it does not mutate task metadata.
- When the scoped store is unavailable or `ARCHIE_MEMORY=false`, the destination restriction remains but normal Slack and trigger delivery does not depend on memory authorization.

Slack message authors are resolved by the host. Only internal, non-restricted human `U…` or `W…` IDs are stored in `memory_authors`. Body mentions, source-looking text, bot IDs, and CLI fallback IDs cannot authorize profile reads or writes.

Private memory is local to its exact audience. It is never injected into prompts and never copied into the public corpus. Memory reads, extraction writes, and task-authored Slack deliveries reclassify the fixed destination before proceeding while memory is active.

The task destination is the privacy boundary. A public task reads public memory. A private-channel task reads public memory plus that channel's outcomes. A DM task reads public memory plus that user's outcomes. Because the destination cannot change, Archie does not track which individual memory results reached the agent.

Task messages, files, explicit reactions, status updates, approval cards, PR cards, and `post_to_channel` share the same destination check. Transport acknowledgements and trigger lifecycle announcements carry no task memory and remain outside the task output path.

Trigger proposals and content edits must target the authoring task's destination. Pausing, resuming, and deleting a visible trigger do not copy task context. A fired trigger creates a fresh task whose memory scope comes from its live Slack destination; no creator-task memory state is propagated. Existing triggers need no migration.

## Workspace binding and startup

After Slack `auth.test`, initialization validates `WORKDIR/memory/.scoped-v1.json` against the authenticated Slack team ID.

- An absent or empty memory directory is initialized for that team.
- A matching marker enables memory and registers the completion listener once.
- A mismatched marker disables all memory reads and writes.
- A non-empty unmarked directory is treated as legacy data and disables memory.
- Missing team identity disables memory.

Memory initialization failure does not stop Slack events, task recovery, or scheduled triggers.

There is no automatic migration. Back up or remove the old memory directory, then restart Archie to initialize scoped v1.

## Storage layout

```text
WORKDIR/memory/
├── .scoped-v1.json
├── public/
│   ├── users/<slack-user-id>.md
│   ├── entities/<slug>.md
│   ├── entities/index.md
│   ├── tasks/<task-id>.md
│   └── recent-activity.md
├── private/
│   ├── channels/<slack-channel-id>.md
│   └── users/<slack-user-id>.md
└── runtime/pending-extractions.md
```

`public/` is organization-wide internal memory. Public channel outcomes are not duplicated into private audience directories.

`private/channels/<id>.md` and `private/users/<id>.md` are rolling, summary-only outcome files. Each keeps at most 50 newest-first entries, deduplicated by task ID and written atomically.

`runtime/pending-extractions.md` makes completion extraction recoverable after restart.

## Extraction

`task:completed` queues extraction on one serialized in-process queue.

Public tasks:

1. Load profiles only for structured internal task authors.
2. Load the public entity index.
3. Run the extractor against the task transcript.
4. Apply sanitized profile and entity updates.
5. Write a rich public task summary containing only sanitized, applied update projections.
6. Append a sanitized public activity row and retain the newest 50.

Private channel and DM tasks run summary-only extraction and write one sanitized outcome to the exact audience vault. They do not read public profiles for extraction or write public profiles, entities, task summaries, activity rows, or related-task data.

Tasks with no destination or a denied live authorization return before reading the transcript.

Task summaries, activity summaries, private outcomes, profile updates, entity fields, and extraction domains are validated before persistence. Secret-shaped and instruction-shaped content is dropped rather than truncated into another artifact.

## Agent read paths

### Prompt injection

`ARCHIE_MEMORY_INJECT=true` enables bounded public context injection. Before reading the store, spawn-time authorization reclassifies the fixed task destination.

Eligible agents receive public entity context, public activity, and public profiles for structured task authors. They never receive private rolling outcomes through prompt injection.

### Read-only tools

`ARCHIE_MEMORY_TOOLS=true` attaches exactly three host-side MCP tools to every agent track on an authorized internal task:

- `search_memory`: deterministic lexical search over public entities, public activity, structured-author profiles, and the exact authorized private vault.
- `read_entity`: public entity lookup by slug or alias.
- `read_task_summary`: exact authorized private outcome first, then a public task summary.

Tool results are XML-escaped, labelled as untrusted evidence, and bounded to 8,000 characters. Entity and task identifiers are validated before memory file access. Tools never open task transcripts or mutate memory content.

Reads use the fixed task scope and fresh Slack conversation membership. Both positive and negative `users.info` trust results are cached for 60 seconds. Slack `user_change` and `team_join` events invalidate that user's result. Lookup errors fail closed. Channel membership accepts internal non-restricted humans plus Archie's exact authenticated bot user; third-party bot and app users are rejected.

## Housekeeping

Automatic profile and entity housekeeping runs inside Archie on the serialized extraction queue. It respects the configured caps, staleness window, no-new-facts checks, and `ARCHIE_MEMORY_HOUSEKEEPING`.

## Feature flags

| Variable | Default | Effect |
|---|---:|---|
| `ARCHIE_MEMORY` | enabled | Master switch for initialization, extraction, injection, and tools. Exact `false` disables all memory seams. |
| `ARCHIE_MEMORY_INJECT` | off | Exact `true` enables public prompt injection. |
| `ARCHIE_MEMORY_TOOLS` | off | Exact `true` enables the three read-only tools. |
| `ARCHIE_MEMORY_HOUSEKEEPING` | enabled | Exact `false` disables automatic housekeeping. |
| `ARCHIE_MEMORY_USER_CAP` | `100` | Public profile bullet soft cap. |
| `ARCHIE_MEMORY_SECTION_CAP` | `30` | Per-section bullet soft cap. |
| `ARCHIE_MEMORY_STALENESS_DAYS` | `180` | Staleness threshold for eligible facts. |
| `ARCHIE_MEMORY_ENTITY_CAP` | `300` | Public entity soft cap. |
| `ARCHIE_MEMORY_ENTITY_INJECT_MAX` | `8` | Maximum non-org entity pages injected into one prompt. |

The safe rollout posture is collect-only: leave injection and tools off while extraction builds a test corpus, inspect it, then enable either read path independently.

## Reset and rollback

To reset memory:

1. Stop Archie.
2. Move `WORKDIR/memory/` to a backup outside `WORKDIR` or remove it if no backup is required.
3. Start Archie and verify that `.scoped-v1.json` contains the expected Slack team ID.

To roll back immediately, set `ARCHIE_MEMORY=false` and restart. Core task routing, Slack delivery, and scheduled triggers continue without memory. The store remains on disk and no database or external-service cleanup is required.

Never copy private vault files into `public/`, edit the workspace marker to bypass a mismatch, or reuse a scoped store with another Slack workspace.
