## Context

The current memory layer writes profiles, entities, activity, and task summaries into one global Markdown store after every completed task. Author selection is inferred from textual mention markers in `knowledge.log`, prompt injection is the only retrieval path, and runtime startup does not bind the store to a Slack workspace. Slack tasks can span public channels, private channels, DMs, MPIMs, and Slack Connect channels, while scheduled triggers can start before a Slack thread exists.

The change must preserve task routing and triggers, remain file-based and ejectable, and be reviewable as a small extension of the existing memory subsystem. The approved rollout permits wiping the current runtime memory instead of migrating it.

## Goals / Non-Goals

**Goals:**

- Keep globally useful memory from public Slack tasks.
- Retain a bounded outcome history for the exact internal-only private channel or user that produced it.
- Make authorization depend on host-controlled Slack metadata and live private-scope checks.
- Add three feature-gated, read-only pull tools without exposing memory directories to agent sandboxes.
- Preserve current message-trigger, scheduled-channel-trigger, and user-trigger behavior when memory is unavailable.

**Non-Goals:**

- Automatic channel-history lookback, semantic/vector search, private profiles/entities, migration of the legacy store, agent mutation tools, or a new telemetry framework.
- Retroactively making public memory private when a channel changes visibility.
- Solving Slack channel-ID migration; an old projection may become orphaned.
- Supporting memory in Slack Connect channels, channels containing restricted guests, external-user DMs, or scheduled user bindings.

## Decisions

### Bind one scoped store to one Slack workspace

`memory/.scoped-v1.json` contains the schema version and `team_id`. Initialization moves until after Slack `auth.test` and before task recovery. A missing team ID, marker mismatch, or non-empty unmarked store disables memory while leaving Archie and trigger startup operational.

This is simpler than adding the team ID to every path and prevents cross-workspace channel/user ID collisions. The legacy store is backed up or wiped operationally rather than migrated.

### Persist a monotone task audience

`TaskMetadata` gains a discriminated `memory_scope` (`unclassified`, `public`, `channel`, `user`, or `none`) and a host-populated `memory_authors` map. New Slack ingestion classifies the conversation with strict conversation and member/user lookups. Slack Connect, pending external sharing, any restricted/external channel member, and any external/restricted DM partner classify as `none`; lookup failure also classifies as `none`. Every Slack delivery audience is classified and joined before delivery; non-Slack channel records are neutral.

The join preserves the same audience, collapses a private audience combined with any distinct Slack audience to `none`, keeps multiple internal public audiences public, and downgrades a single channel to private if its visibility tightens. `none` never widens. Legacy tasks missing scope behave as `none`. A channel-bound scheduled trigger is strictly classified from its approved host binding before its task starts; failure sets `none` without blocking the fire.

This avoids reconstructing authorization from forgeable transcript text and avoids attaching per-artifact ACLs to the rich public corpus.

### Split rich public memory from rolling private outcomes

The public corpus moves under `memory/public/`. Internal-only public tasks keep the existing profile/entity/task extraction, constrained to structured internal Slack authors. Public summaries retain their originating channel in metadata, but search does not duplicate them into channel-local files or give them a locality ranking boost.

Internal-only private channels, MPIMs, and DMs run summary-only extraction and append to one exact rolling file under `memory/private/channels/<channel-id>.md` or `memory/private/users/<user-id>.md`. Each file keeps 50 newest-first entries keyed by task ID. Private extraction never loads or writes profiles, entities, or global activity. Slack Connect, guest-visible, mixed, and failed-classification tasks read and write no memory.

This preserves the highest-value private context while avoiding a second rich memory graph and its authorization complexity.

### Authorize private reads at call time

The in-process memory MCP server receives a callback to current task metadata, not a spawn-time scope snapshot. Before reading a private channel or user file it reclassifies the exact Slack audience, including current channel membership or DM-partner trust. A lookup failure, outsider-visible transition, audience change, or public conversion denies private recall. Only internal audiences receive global public memory; external/guest-visible and `none` tasks receive no memory tools or prompt injection.

The tools are `search_memory`, `read_entity`, and `read_task_summary`, default-off behind `ARCHIE_MEMORY_TOOLS`. Results are escaped, framed as untrusted evidence, and bounded to 8,000 characters. Search uses deterministic lexical overlap; current-space membership is only a tie-break.

### Keep prompt injection public-only

Existing injection remains separately gated by `ARCHIE_MEMORY_INJECT`, reads the relocated public corpus, and obtains profile IDs from structured task authors. Private rolling outcomes are pull-only.

### Carry sensitivity through egress and automation

Once memory reaches a task, a host hook denies tools by default and permits only exact audited local identities. External MCP annotations and server-name prefixes are not authorization. Audited Slack mutations remain behind `prepareMemoryDelivery`.

Trigger content created or edited by an exposed task carries the composed exposure scope. The binding is reclassified at approval and on every fire. Incompatibility refuses approval or pauses an enabled trigger, and compatible fired tasks inherit exposure before prompt construction.

## Risks / Trade-offs

- **Slack API failure disables recall** → Fail closed for memory only; task execution and delivery continue.
- **Audience classification adds Slack requests** → Cache only host-resolved internal-user facts; conversation/member lookup failures disable memory rather than reusing stale trust.
- **A channel visibility or Slack Connect transition can orphan a path** → Preserve confidentiality and accept lost locality in v1 rather than migrate IDs.
- **Heuristic secret/instruction detection can reject useful summaries** → Skip the unsafe artifact while still applying independently sanitized public profile/entity updates.

## Migration Plan

1. Deploy code with `ARCHIE_MEMORY_TOOLS=false` and prompt injection unchanged.
2. Stop Archie and move the existing `WORKDIR/memory` to an operator backup.
3. Restart so the workspace-bound v1 marker and empty store are created.
4. Boot E2E with a fresh test-only directory mounted over the container memory subtree; do not move, wipe, or write the symlinked host memory directory.
5. Verify internal public, internal private-channel, DM, scheduled-channel, outsider-visible, tools-off, and lookup-failure scenarios using the change's verification matrix.
6. Enable `ARCHIE_MEMORY_TOOLS=true` and verify scoped reads through `archie-e2e` via Hookdeck.
7. Roll back by disabling `ARCHIE_MEMORY`; restoring the old binary requires restoring its matching legacy memory backup.

## Open Questions

None. Product defaults and privacy trade-offs are fixed by the approved plan.
