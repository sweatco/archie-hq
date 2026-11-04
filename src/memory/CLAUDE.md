# Memory Layer — CLAUDE.md

`src/memory/` is Archie's file-based, workspace-bound memory subsystem. It keeps a global public corpus plus canonical task summaries for exact public and private Slack conversations. All behavior is gated by `ARCHIE_MEMORY`.

## Read before changing this subsystem

- `docs/architecture/memory.md` is the as-built architecture and operator guide. The root repository instructions still apply.

## Keep documentation and tests in the same change

- Flow, storage, privacy, or rollout changes require an update to `docs/architecture/memory.md`.
- Flag changes require updates to both the architecture document and `.env.example`.
- Logic changes require focused tests under `src/memory/__tests__/` or the owning core subsystem's test directory.

## Invariants

- **Workspace-bound store.** `memory/.scoped-v1.json` binds the store to the authenticated Slack team. Missing identity, mismatched identity, and malformed metadata fail closed for memory without stopping Archie or its triggers. An unmarked store is reset in place.
- **Host-controlled authorization.** Task scope and author IDs come only from resolved Slack metadata. Transcript text, body mentions, display names, and model output never grant memory access.
- **One task, one destination.** The first Slack destination fixes the task audience. Public/private tasks stay in that exact channel; DM tasks stay in that exact DM. Public/private conversion changes live authorization, not persisted task metadata.
- **One PM attachment.** The single PM session authorizes memory once during spawn, receives at most one injection block, and attaches at most one task-bound memory MCP server. Native workers share that session's task authorization.
- **Extraction source.** Completion extraction reads `knowledge.log` with `readKnowledgeLog()` after authorization. It does not use participant or task-owner metadata, and the running PM still receives inbound content inline rather than reading the log.
- **Strict storage split.** Rich profiles, entities, activity, and public task summaries live under `memory/public/`. Private task summaries live only under `memory/private/<channel-id>/`. Runtime queue state lives under `memory/runtime/`.
- **Destination-only delivery, live memory authorization.** Slack delivery checks only the fixed destination. New memory reads and extraction reclassify that destination while memory is active; lookup failures and external/guest visibility deny scoped access. Verified home-workspace bots may be channel members but remain ineligible as memory authors and DM partners. Already loaded SDK context is not revoked after an audience or flag change.
- **Exact trigger recipients.** Existing user-bound triggers verify that the fixed destination is a DM with the exact recipient independently of memory eligibility.
- **Public profiles use human Slack IDs only.** New profile and DM paths accept `U…` or `W…` IDs. Bot IDs, fallback IDs, display names, and path-shaped values cannot create or authorize scoped profile files.
- **Model output is untrusted.** Extraction output passes through `sanitize.ts` before persistence. Memory tool responses are escaped, marked as untrusted evidence, and size-bounded.
- **Writes are serialized.** Extraction, canonical task replacement, overview rebuilding, pending recovery, and automatic housekeeping use the lifecycle queue. Do not add an independent writer to scoped memory.
- **Flags are independent and default safe.** `ARCHIE_MEMORY=false` disables every seam. `ARCHIE_MEMORY_INJECT` gates prompt injection and `ARCHIE_MEMORY_TOOLS` gates read and explicit write tools; both default off.
- **No migration or external dependency.** Scoped v1 remains Markdown/JSON on disk. An unmarked old store is wiped instead of migrated.

## Load-bearing files

- `paths.ts` — scoped paths, identifier guards, readiness, and flags.
- `index.ts` — workspace marker initialization and completion-listener registration.
- `lifecycle.ts` — serialized public/private extraction routing.
- `task-summaries.ts` — canonical task readers, atomic writers, and derived channel overviews.
- `task-authors.ts` — structured-author filtering.
- `tools.ts` and `explicit.ts` — memory MCP tools, explicit writes, and live authorization.
- `sanitize.ts` — persistence trust boundary.
- `context.ts` — public profile/activity and bounded entity-catalogue injection.

## Verify

```bash
npx vitest run src/memory/__tests__/ --testTimeout=10000
npm run typecheck
npm run build
```
