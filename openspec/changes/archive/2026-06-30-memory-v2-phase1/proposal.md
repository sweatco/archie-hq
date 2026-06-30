## Why

The memory layer injects **every** `scope: org` entity page, in full, into **every** agent's system prompt — uncapped. That is ~381K of the measured ~424K system prompt, on every agent, every turn. The behavior is mandated by the spec ("Org-scoped entities … SHALL always be injected in full and SHALL NOT be subject to the page bound"), a holdover from the retired monolithic `org.md`. Combined with append-only entity pages that have no per-page bound, the cost grows without limit.

This is **Phase 1 of the memory-v2 plan** ([`docs/proposals/memory-v2.md`](../../../docs/proposals/memory-v2.md)): the branch-agnostic, no-new-infrastructure fix that stops the context bleed now, before we commit to the larger build-vs-buy direction (native Claude memory tool vs. building retrieval ourselves).

## What Changes

- **Bound org-entity injection.** `scope: org` pages are no longer exempt from a budget. The system injects only the top-N most relevant org pages (new flag `ARCHIE_MEMORY_ORG_INJECT_MAX`), selected by the same relevance scoring used for other entities, with last-touched recency as tiebreak. Dropped slugs are logged (mirroring the existing non-org drop logging).
- **Index becomes the always-on catalogue.** The thin `<entity_index>` remains injected in full. A dropped full org page still leaves its one-line `L0` summary visible in the index — the partial-recall safety net until Phase 2 (embeddings) and Phase 3 (pull tools) land.
- **Per-page observation cap.** New flag `ARCHIE_MEMORY_ENTITY_OBS_CAP`: on write, an entity page keeps its newest-touched N observations and drops (with a log) the oldest, so individual pages can't grow unbounded and re-inflate even a bounded selection.
- **Stop biasing extraction toward `org`.** The extractor prompt no longer instructs "default to `org` for anything not clearly repo-specific," and `pickScope` no longer treats `org` as the catch-all default. This aligns implementation with the *existing* spec requirement that org scope is reserved for genuinely cross-cutting facts (a conformance fix, not a new requirement).
- **Out of scope (deferred to later phases):** native context editing (beta-SDK lever → Branch A spike), embeddings / semantic selection (Phase 2), semantic entity dedupe (Phase 2), runtime pull/write/forget tools (Phase 3–4), removing/repurposing observation-category tags (Phase 4).
- No breaking API changes. The behavior change is reachable only when `ARCHIE_MEMORY_INJECT=true` (already default-off), so rollout stays gated.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `memory-layer`: the **"Memory injection at agent spawn"** requirement changes — `scope: org` entities are bounded and relevance-selected rather than always-injected-and-exempt, and the `<entity_index>` is reaffirmed as the always-injected catalogue. A new requirement adds a **per-page observation cap** bounding the size of any single entity page.

## Impact

- **Code:**
  - `src/memory/entity-index.ts` — `selectEntities()`: remove the org exemption; add an org budget + relevance/recency selection; keep drop-logging.
  - `src/memory/entities.ts` — `applyEntityUpdate()`: enforce the per-page observation cap (keep newest N, drop+log oldest); `pickScope()`: drop the implicit `org` default for the no-repo/no-scope case.
  - `src/memory/paths.ts` — accessors + defaults for the two new flags.
  - `prompts/memory-extractor.md` — remove the "default to `org`" guidance; instruct narrowest-applicable scope.
- **Spec:** `openspec/specs/memory-layer/spec.md` (delta in this change).
- **Docs (same change, per `src/memory/CLAUDE.md`):** `docs/architecture/memory.md` (injection section + flags table), `.env.example` (two new flags).
- **Tests:** `src/memory/__tests__/entity-index.test.ts` (org bound + drop logging), `src/memory/__tests__/entities.test.ts` (per-page cap, scope default).
- **New flags:** `ARCHIE_MEMORY_ORG_INJECT_MAX` (default 8), `ARCHIE_MEMORY_ENTITY_OBS_CAP` (default 30).
- **Expected effect:** with injection enabled, system-prompt memory drops from ~424K toward ~40–60K (≈16 full pages × ~2.4K + index + user/activity), with org knowledge still discoverable via the always-injected index.
