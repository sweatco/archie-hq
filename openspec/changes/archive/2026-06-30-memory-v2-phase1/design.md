## Context

Phase 1 of the memory-v2 plan ([`docs/proposals/memory-v2.md`](../../../docs/proposals/memory-v2.md); see `proposal.md`). Today `selectEntities()` (`src/memory/entity-index.ts`) gives every `scope: org` entity a flat `SCORE_ORG = 1000` and exempts org from `ARCHIE_MEMORY_ENTITY_INJECT_MAX`, so **all** org pages are injected in full — ~381K of the measured ~424K system prompt. Entity pages are append-only with no per-page bound (`applyEntityUpdate` in `src/memory/entities.ts`), so even a bounded selection re-inflates over time. Extraction is biased toward org: `prompts/memory-extractor.md` says "Default to `org` for anything not clearly repo-specific," and `pickScope()` defaults the no-repo/no-scope case to `org`.

Injection is gated by `ARCHIE_MEMORY_INJECT` (default **off**, and currently disabled in prod), so the read path can change without a live consumer. The layer must remain file-based, no database, single-step ejectable, and writes serialized through the existing queue (invariants in `src/memory/CLAUDE.md`).

## Goals / Non-Goals

**Goals:**
- Bound system-prompt memory to a configurable budget regardless of org-entity count.
- Preserve discoverability of *all* org knowledge via the always-injected `<entity_index>`.
- Bound the size of any single entity page.
- Reduce org-scope inflation at the source (extraction).
- No new infrastructure, no new dependency; behavior reachable only behind the existing default-off injection flag.

**Non-Goals:**
- Embeddings / semantic selection (Phase 2).
- Semantic entity dedupe / `resolveEntity` fuzzy matching (Phase 2).
- Runtime pull / write / forget tools (Phase 3–4).
- Native context editing or the Claude memory tool (Branch A spike).
- Removing or repurposing observation-category tags (Phase 4).
- Any change to user-memory or recent-activity injection.

## Decisions

### 1. Two separate injection budgets (org vs. non-org), not one combined budget
Add `ARCHIE_MEMORY_ORG_INJECT_MAX` (default 8) for `scope: org` pages; keep `ARCHIE_MEMORY_ENTITY_INJECT_MAX` (default 8) for repo/domain/title/graph-expanded pages.
- **Why:** org knowledge is the primary value; a single combined top-N could be fully consumed by repo/expansion pages (or vice-versa), starving the other class. Separate budgets guarantee a floor of org context while still bounding it.
- **Alternative — single combined top-N:** rejected; unpredictable mix and reintroduces the "which class wins" ambiguity the current design tried to avoid with the exemption.

### 2. Select org pages by relevance, recency as tiebreak — drop the "always-in-full" semantics
Org pages compete on the existing token-overlap relevance score; `touched:` date breaks ties; take the top `ARCHIE_MEMORY_ORG_INJECT_MAX`.
- **Why:** once org is bounded we want the *most relevant* org pages, not arbitrary ones. The flat `SCORE_ORG = 1000` made all org pages indistinguishable. Org MAY keep a modest base bonus so a relevant org page outranks a weak non-org match within its own budget — but the bonus no longer implies "inject all."
- **Alternative — pure recency:** rejected; ignores task relevance. Relevance-primary with recency tiebreak is strictly better.

### 3. The `<entity_index>` is the Phase-1 recall safety net
Keep `<entity_index>` always injected in full (already the case). A dropped full org page still leaves its `L0` one-liner in the index.
- **Why:** until Phase 2 (embeddings) and Phase 3 (pull tools), the index is the only mechanism by which an agent learns a dropped org entity exists. We accept the detail/precision loss; *existence* is preserved.
- **Accepted risk:** an "always-relevant" org fact (e.g. "deploys ship Tuesdays") with no token overlap may fall to index-only. Its `L0` summary usually carries the fact; Phase 2/3 recover full detail.

### 4. Per-page observation cap = hard cap at write time, keep newest-touched
In `applyEntityUpdate`, after dedup/append, if observations exceed `ARCHIE_MEMORY_ENTITY_OBS_CAP` (default 30), sort by `touched:` descending and truncate, logging the dropped count. Relations are uncapped.
- **Why:** deterministic, immediate, no side-agent, and structurally satisfies the no-new-facts guarantee (we only drop existing observations). Mirrors the user-memory `SECTION_CAP = 30`.
- **Alternative — enqueue entity housekeeping to prune within-page:** rejected for Phase 1; housekeeping currently operates at entity granularity (merge/archive), not observation granularity. A write-time hard cap is the minimal durable bound; smarter consolidation can come in a later phase.

### 5. Extraction unbias is a conformance fix, not a spec change
Edit `prompts/memory-extractor.md` to remove "default to `org`" and instruct narrowest-applicable scope (`repo` when repo-specific; `org` only for genuinely cross-cutting facts). Stop `pickScope()` from *actively* defaulting ambiguous cases to org.
- **Why:** the existing spec ("Organizational knowledge SHALL be stored as entities…") already reserves org scope for cross-cutting facts — the prompt contradicted it. Aligning the implementation needs no spec delta.
- **Caveat:** `pickScope()` still needs *a* fallback when the model supplies neither scope nor repos. We keep `org` as the structural last resort (a fact with no repo association is plausibly cross-cutting) but remove the prompt's active encouragement. The injection bound (Decision 1) is the real protection; extraction unbias only slows the growth rate.

## Risks / Trade-offs

- **[A relevant org fact drops to index-only]** → The always-injected index preserves its `L0` summary; Phase 2 embeddings + Phase 3 pull recover full detail. Raise `ARCHIE_MEMORY_ORG_INJECT_MAX` if recall complaints surface.
- **[Per-page cap drops a still-useful old observation]** → Cap is high (30) and only the oldest-touched surplus is dropped; the drop is logged for audit. Dedupe/merge in later phases reduces pressure on the cap.
- **[Token-overlap relevance is weak for picking N of 156]** → Known and expected; this is precisely why Phase 2 adds embeddings. Phase 1 only needs "good enough to rank," and the index backstops misses.
- **[Behavior change to live agents]** → Injection is default-off and currently disabled in prod, so the change lands dark and is measured before enabling.

## Migration Plan

- Purely additive flags with safe defaults; entity files on disk are unchanged → **no data migration**.
- Existing over-cap pages are trimmed lazily on their next write. (Optional: extend `npm run memory:housekeeping` to trim all pages once — not required for Phase 1.)
- **Rollout:** land behind default-off injection → replay a representative task and measure the `## Organizational Memory` block size (expect ~424K → ~40–60K) → enable `ARCHIE_MEMORY_INJECT=true` in a canary.
- **Rollback:** adjust the two new flags, or unset `ARCHIE_MEMORY_INJECT`. No schema to revert.

## Open Questions

- `ARCHIE_MEMORY_ORG_INJECT_MAX` default — is 8 enough, or start higher (e.g. 12) given org is the primary knowledge class? Decide from the replay measurement.
- `pickScope()` fallback for the no-scope/no-repo case — keep `org` as the structural last resort, or introduce a non-injected "holding" scope to force deliberate promotion?
- Is a tiny always-on org allowlist (for truly ubiquitous facts) worth it, or is index-only acceptable until Phase 2?
- `ARCHIE_MEMORY_ENTITY_OBS_CAP` default — confirm 30 is right; should it match `SECTION_CAP` exactly or be independent?
