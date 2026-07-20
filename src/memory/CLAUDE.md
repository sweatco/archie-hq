# Memory Layer — CLAUDE.md

`src/memory/` is a self-contained, ejectable subsystem for persistent cross-task knowledge. It stores organizational entities, public task summaries and activity, and author-scoped user preferences. The whole subsystem is gated by `ARCHIE_MEMORY`.

## Read before changing this directory

- `docs/architecture/memory.md` is the as-built source of truth.
- `docs/plans/20260719-memory-v2.md` records how the layer reached its current shape.
- `docs/proposals/memory-v2-roadmap.md` records future work and rollout gates.

The root `CLAUDE.md` rules also apply.

## Keep docs and tests synchronized

Any behavior, flow, storage, or flag change must update `docs/architecture/memory.md` in the same change. Flag changes also update `.env.example`. Any logic change needs a corresponding test under `src/memory/__tests__/` or the relevant Slack/task test directory.

## Invariants

- **Two core seams.** Core imports memory only in `src/index.ts` and `src/agents/spawn.ts`. Keep one-step ejection possible.
- **Task visibility is the write boundary.** `processExtraction` must stop before reading a transcript unless `metadata.visibility === 'public'`. Missing or unrecognized visibility is private. Private tasks write no user preferences, entities, summaries, or activity.
- **The store is public by construction.** Store-backed summaries, entities, and activity need no per-artifact access stamps. Do not add cross-task raw-log reads; `knowledge.log` is extraction input, not public memory.
- **User memory follows authorship.** User files are keyed by Slack ID or documented `cli:`/`local:` fallback. Only task authors may be written, injected, or returned as search hits. Body mentions grant nothing. Slack updates require evidence IDs authored by the target user.
- **Model output is untrusted.** Every extractor and housekeeper result passes through `sanitize.ts`. Side-agents remain one turn, tool-free, and minimally provisioned.
- **Writes are serialized.** Extraction and housekeeping share the sequential queue in `lifecycle.ts`. Telemetry's single-line fail-safe appends are the only exception.
- **Read tools are store-only and read-only.** Every identifier passes `paths.ts` guards. Do not add mutation tools or a tool that opens task transcripts.
- **Flag-safe.** With `ARCHIE_MEMORY=false`, initialization, injection, tools, and completion extraction no-op.

## Load-bearing files

- `paths.ts`: paths, ID guards, and flags.
- `sanitize.ts`: trust boundary for model output.
- `lifecycle.ts`: public-task gate, durable queue, and extraction pipeline.
- `tools.ts`: three read-only public-store tools.
- `store.ts`: user-memory update semantics.
- `prompts/memory-extractor.md` and `prompts/memory-housekeeper.md`: side-agent prompts.

## Verify

```bash
npm run typecheck
npx vitest run src/memory/__tests__/
```

Manual consolidation: `npm run memory:housekeeping -- --target <all|entities|U…>`.
