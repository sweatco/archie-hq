# Memory Layer — CLAUDE.md

`src/memory/` is a self-contained, ejectable subsystem for persistent cross-task knowledge. It stores organizational entities, public task summaries and activity, and author-scoped collaboration profiles. The whole subsystem is gated by `ARCHIE_MEMORY`.

## Read before changing this directory

- `docs/architecture/memory.md` is the as-built source of truth.
- `docs/plans/20260719-memory-v2.md` records how the layer reached its current shape.
- `docs/proposals/memory-v2-roadmap.md` records future work and rollout gates.

The root `CLAUDE.md` rules also apply.

## Keep docs and tests synchronized

Any behavior, flow, storage, or flag change must update `docs/architecture/memory.md` in the same change. Flag changes also update `.env.example`. Any logic change needs a corresponding test under `src/memory/__tests__/` or the relevant Slack/task test directory.

## Invariants

- **Two core seams.** Core imports memory only in `src/index.ts` and `src/agents/spawn.ts`. Keep one-step ejection possible.
- **Task visibility is the write boundary.** `processExtraction` must stop before reading a transcript unless `metadata.visibility === 'public'`. Missing or unrecognized visibility is private. Private tasks write no collaboration profiles, entities, summaries, or activity.
- **The store is public by construction.** Store-backed summaries, entities, and activity need no per-artifact access stamps. Do not add cross-task raw-log reads; `knowledge.log` is extraction input, not public memory.
- **Collaboration profiles follow Slack authorship.** Files remain under `users/<id>.md`, but only actual Slack message authors are writable. `cli:`/`local:` fallback files may remain as legacy data but are never loaded for extraction or updated. Body mentions grant nothing. Every candidate needs at least one resolvable `msg:<ts>` evidence ID, all authored by the target user; summaries show only updates the store confirmed it wrote.
- **Profile sections are closed.** New adds and updates may target only `Communication`, `Deliverables`, `Workflow`, `Decision Making`, or `Constraints`. Updates replace bullets only inside their declared section. Existing legacy sections remain readable and housekeepable.
- **Model output is untrusted.** Every extractor and housekeeper result passes through `sanitize.ts`. Side-agents remain one turn, tool-free, and minimally provisioned.
- **Runtime writes are serialized.** Extraction and automatic housekeeping share the sequential queue in `lifecycle.ts`. Telemetry's single-line fail-safe appends are the only runtime exception. Manual housekeeping runs out of process and requires the server to be stopped.
- **Read tools are store-only and read-only.** Every identifier passes `paths.ts` guards. Do not add mutation tools or a tool that opens task transcripts.
- **Flag-safe.** With `ARCHIE_MEMORY=false`, initialization, injection, tools, and completion extraction no-op.

## Load-bearing files

- `paths.ts`: paths, ID guards, and flags.
- `sanitize.ts`: trust boundary for model output.
- `lifecycle.ts`: public-task gate, durable queue, and extraction pipeline.
- `tools.ts`: three read-only public-store tools.
- `store.ts`: collaboration-profile update semantics and applied-update reporting.
- `prompts/memory-extractor.md` and `prompts/memory-housekeeper.md`: side-agent prompts.

## Verify

```bash
npm run typecheck
npx vitest run src/memory/__tests__/
```

Manual consolidation, with the Archie service stopped: `npm run memory:housekeeping -- --target <all|entities|U…>`.
