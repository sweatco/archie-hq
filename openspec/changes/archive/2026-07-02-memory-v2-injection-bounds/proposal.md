## Why

A critical review of the shipped memory-v2 Phase-1 work (org-injection bound + observation cap) found two design gaps that undercut Phase 1's own goal and two documentation defects. First, the org injection budget behaves as a **target, not a ceiling**: every `scope: org` page receives a flat `SCORE_ORG = 1000` candidacy bonus, so all org pages are always candidates and the budget of 8 is fully consumed on every spawn — even for tasks with zero org relevance, where ranking among tied pages degenerates to pure recency. That is precisely the "context pollution" Phase 1 set out to stop, merely bounded. Second, the auto-added `touched_by [[taskId]]` relations grow by one per touching task, forever, and `renderEntityBlock` serializes **all** relations into the injected block — the last unbounded growth vector in the system prompt after Phase 1 capped observations. Third, the canonical spec still asserts in two places that `scope: org` entities are "always injected", contradicting the bounded behavior Phase 1 shipped. These should land before injection is enabled in production.

## What Changes

- **Org injection budget becomes a ceiling, not a target.** `selectEntities` no longer grants `scope: org` pages unconditional candidacy via the flat `SCORE_ORG` bonus. Org pages become candidates the same way non-org pages do — by a relevance signal (repo match, `owned_by` participant, token overlap with the spawn context, or one-hop graph expansion) — and the highest-scoring signal-bearing org pages are injected up to `ARCHIE_MEMORY_ORG_INJECT_MAX`. An org page with no signal is not injected and is not logged as a drop; it remains discoverable via its `L0` row in the always-injected `<entity_index>`. `SCORE_ORG` is removed: with the two independent budgets introduced in Phase 1 there is no cross-class competition, and within the org class a uniform bonus never changes ranking — its only remaining effect was the unconditional candidacy this change removes.
- **Render-time cap on `touched_by` relations in injected entity blocks.** A new flag `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` (default 10, `0` allowed) bounds how many `touched_by` edges are rendered into an `<entity>` prompt block, keeping the newest (most recently appended). The on-disk page is unchanged — the full `touched_by` history is preserved for the related-tasks signal and provenance; only prompt rendering truncates. Curated relation types (`depends_on`, `integrates`, `owned_by`, `part_of`, `related_to`) are not capped — only the auto-growing `touched_by` is.
- **`ARCHIE_MEMORY_ENTITY_INJECT_MAX=0` becomes valid** (min 0, matching `ARCHIE_MEMORY_ORG_INJECT_MAX`), so an operator can configure index-only injection for non-org pages too.
- **Spec staleness fixes.** The "Organizational knowledge SHALL be stored as entities" requirement still says `scope: org` entities "are always injected" in its rationale and asserts "always injected at agent spawn" in a scenario — both contradict the bounded-org requirement Phase 1 shipped and are corrected. The spec status line is updated to credit the memory-v2 changes, and the resolved CLI-identifier open question (superseded by the stable-identifier requirement mandating `cli:<sessionId>`) is marked resolved.
- **Decision-doc sync.** `docs/proposals/memory-v2.md` (the memory-v2 research/decision doc, referenced by both archived memory-v2 changes but never committed) is updated to reflect shipped reality — Phase 1 + fixes done, appendices refreshed — and re-cut per the review: eval harness promoted to the gate for enabling injection in prod, Branch-A spike + read tools moved ahead of embeddings, semantic dedupe split out from embedding-backed selection — and committed so the archived changes' references resolve.
- **Out of scope:** the eval harness itself, pull/read tools, the Branch-A native-memory-tool spike, semantic dedupe, embeddings (all sequenced in the re-cut roadmap); any change to on-disk formats or the write path.
- No breaking API changes. All behavior remains gated behind the default-off `ARCHIE_MEMORY_INJECT`.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `memory-layer`: the **"Memory injection at agent spawn"** requirement changes — `scope: org` pages require a relevance signal to be injected (the org budget is a ceiling; zero-signal org pages stay index-only), and injected entity blocks bound the rendered `touched_by` relations to `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` newest edges without altering the stored page. The **"Organizational knowledge SHALL be stored as entities"** requirement is corrected editorially — its rationale and scenario no longer claim org entities are always injected (conformance with the Phase-1 bounded-injection requirement, not a behavior change).

## Impact

- **Code:**
  - `src/memory/entity-index.ts` — `selectEntities()`: remove `SCORE_ORG` and the unconditional org candidacy; org pages are scored by the same signals as non-org pages and consume the org budget only when they carry a signal.
  - `src/memory/context.ts` — `renderEntityBlock()`: render a copy of the record with `touched_by` relations truncated to the newest `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX`; never mutate or rewrite the stored record.
  - `src/memory/paths.ts` — `getTouchedByInjectMax()` accessor (default 10, min 0); `getEntityInjectMax()` gains `min: 0`.
- **Spec:** `openspec/specs/memory-layer/spec.md` (delta in this change; plus the editorial staleness fixes).
- **Docs (same change, per `src/memory/CLAUDE.md`):** `docs/architecture/memory.md` (selection semantics + flags table), `.env.example` (new flag), `docs/proposals/memory-v2.md` (status, phase re-cut, appendices).
- **Tests:** `src/memory/__tests__/entity-index.test.ts` (zero-signal org pages not injected; signal-bearing org pages injected up to the ceiling; existing always-inject expectations updated), `src/memory/__tests__/context.test.ts` or equivalent (touched_by render truncation, disk record untouched), flag-parsing cases for the new accessor and the min-0 change.
- **New flags:** `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` (default 10).
- **Expected effect:** prompts for tasks with no org-relevant context carry the index only (no recency-filler pages); hot entities stop re-inflating prompts through unbounded `touched_by` lists. Recall risk is unchanged from Phase 1's accepted trade-off (index L0 rows remain the safety net) and is the explicit subject of the eval-harness gate in the re-cut roadmap.
