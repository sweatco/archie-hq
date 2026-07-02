# Memory v2 — Roadmap

> **Status:** Phase 1 shipped 2026-06-30/07-02 (`memory-v2-phase1`, `memory-v2-fixes`, `memory-v2-injection-bounds`); injection still default-off in prod. Remaining phases below are proposals, not commitments — each needs its own OpenSpec change.
> **As-built:** [`docs/architecture/memory.md`](../architecture/memory.md) · **Spec:** [`openspec/specs/memory-layer/spec.md`](../../openspec/specs/memory-layer/spec.md)

## Phases

### Phase 1 — Stop the bleed ✅ shipped

Org injection bounded and relevance-gated (budgets are ceilings; zero-signal pages stay index-only), extraction no longer biased toward `org`, per-page observation cap at the persistence boundary, `touched_by` render cap. The always-injected thin entity index is the recall safety net.

### Phase 1.5 — Eval gate (precondition for `ARCHIE_MEMORY_INJECT=true` in prod)

- Selection precision/recall on replayed tasks (resurrect the stashed memory-eval tooling: `scripts/memory-eval.ts`, `src/memory/eval/`).
- Injection-diversity / page-turnover metric — watch the recency feedback loop (re-stamp on re-affirmation + recency tiebreak can ossify the same pages).
- Decides: `ORG_INJECT_MAX` default; whether zero-signal exclusion needs a small recency floor or an always-on org allowlist.

### Phase 2 — Runtime read + buy-vs-build spike

- Spike the SDK-native memory tool + context editing behind a flag; decide buy-vs-build on eval evidence before investing further in bespoke retrieval.
- Read tools for agents: `search_memory`, `read_entity`, `read_task_summary`, `grep_task_log`. All agents read; writes stay funneled through the extractor.

### Phase 3 — Semantic dedupe (can run alongside Phase 2)

- Semantic `resolveEntity` + ADD/UPDATE/DELETE/NOOP write path (mem0-style).
- The only mechanism that actually shrinks the store — `ENTITY_CAP` has no teeth while housekeeping merges only alias-linked duplicates.

### Phase 4 — Selection embeddings + runtime write/forget

- File-based embedding index (`entities/index.embeddings.json`, in-process cosine — no DB) for selection, only if the eval shows push precision is still the bottleneck after pull tools land.
- `remember` / `forget` tools behind the single write funnel; contradiction-based invalidation instead of date-only staleness.
- Kill or repurpose observation categories (they are consumed only as a render prefix and part of the dedupe/re-stamp key).

## Open questions

- Who writes memory: specialists read, only extractor/PM write — or PM-only end to end?
- Forgetting model: date-based staleness (today) vs. contradiction-based invalidation.
- Index tiering: the always-injected index (~9K tokens at the 300-entity cap) is the next growth ceiling.
