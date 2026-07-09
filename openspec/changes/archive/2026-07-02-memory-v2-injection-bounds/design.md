## Context

Phase 1 (`memory-v2-phase1`) bounded `scope: org` injection with `ARCHIE_MEMORY_ORG_INJECT_MAX` and `memory-v2-fixes` hardened the observation cap. A follow-up review found the bound is a **target, not a ceiling**: `selectEntities` (`src/memory/entity-index.ts`) gives every org page a flat `SCORE_ORG = 1000`, making all org pages unconditional candidates. The org budget is therefore always fully consumed — for a task with zero org relevance, the 8 slots are filled by recency among pages tied at 1000. Separately, `renderEntityBlock` (`src/memory/context.ts`) serializes the full page including **all** relations, and every applied update auto-appends a `touched_by [[taskId]]` edge (`entities.ts:327`) — one line per touching task, forever, injected into every prompt. Observations are capped at 30; relations are the remaining unbounded prompt vector. Finally, the canonical spec still claims in the org-knowledge requirement's rationale and one scenario that org entities are "always injected", contradicting the Phase-1 bounded-injection requirement.

Constraints (from `src/memory/CLAUDE.md`): file-based, no DB, single-step ejectable; writes serialized through the `lifecycle.ts` queue; docs/spec/tests updated in the same change. Injection is gated by the default-off `ARCHIE_MEMORY_INJECT`, so the read path changes dark.

## Goals / Non-Goals

**Goals:**
- The org injection budget is a ceiling: only relevance-signal-bearing org pages consume slots; a task with no org-relevant context gets the index only.
- No injected `<entity>` block grows without bound through its `touched_by` list; the on-disk page keeps full history.
- Operator flags are symmetric: index-only (`0`) is valid for both entity-injection budgets.
- The canonical spec no longer contradicts itself about org injection.
- The re-cut roadmap for the remaining memory work is committed as a concise doc.

**Non-Goals:**
- The eval harness, pull/read tools, the Branch-A native-memory-tool spike, semantic dedupe, and embedding-backed selection — sequenced in `docs/proposals/memory-v2-roadmap.md`, not built here.
- Any change to on-disk entity format, the write path, extraction, or housekeeping.
- Capping curated relation types (`depends_on`, `integrates`, `owned_by`, `part_of`, `related_to`) — only the auto-growing `touched_by` is bounded, and only at render time.

## Decisions

### 1. Candidacy-by-signal replaces the flat `SCORE_ORG` bonus — remove the constant
Org pages become candidates exactly like non-org pages: repo match (`SCORE_REPO`), `owned_by` participant (`SCORE_OWNER`), token overlap (`SCORE_PER_TOKEN`), or one-hop expansion (`SCORE_EXPANSION`). The two Phase-1 budgets are unchanged; org pages with at least one signal compete for `ARCHIE_MEMORY_ORG_INJECT_MAX` slots, ranked by score with last-touched recency as tiebreak.
- **Why remove `SCORE_ORG` entirely:** with independent budgets there is no cross-class competition, and within the org class a uniform +1000 never changes relative ranking — its only remaining effect was unconditional candidacy, which is the bug. A dead constant invites the next reader to assume it does something.
- **Alternative — keep `SCORE_ORG` and require score > 1000:** behaviorally identical but preserves a constant whose only role is to be subtracted back out; rejected for clarity.
- **Alternative — relevance-primary with a small recency-filled floor (e.g. always top-2 by recency):** rejected for now; it reintroduces zero-relevance filler on every prompt to hedge a recall risk we have not measured. The index `L0` rows remain the safety net (Phase-1 Decision 3), and the eval-harness gate in the re-cut roadmap is the instrument for revisiting this with evidence.
- **Consequence:** zero-signal org pages are not candidates, so they are not "dropped" — drop logging keeps its Phase-1 meaning (qualified but over budget). Injected block ordering changes cosmetically (org pages no longer sort above every non-org page).

### 2. `touched_by` is bounded at render time, on a copy — never at write time
`renderEntityBlock` renders from a shallow copy of the record whose `touched_by` relations are truncated to the newest `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` (default 10); other relation types pass through untouched. `serializeEntity` and `writeEntity` are unchanged.
- **Why render-time:** non-lossy. The full `touched_by` history on disk feeds related-task selection (`lifecycle.ts:521`) and provenance; truncating at write time would silently degrade both. Render-time truncation bounds the prompt at the exact point the cost is incurred.
- **Why "newest = last in array":** `addRelation` appends, so array order is insertion order; task IDs embed timestamps but relying on lexicographic ID sort would couple the cap to the ID format. Take the trailing N.
- **Why only `touched_by`:** it is the only relation type written automatically per task; curated types are authored by extraction at a human-meaningful rate and carry graph semantics (expansion, scoring) that truncation would distort.
- **Alternative — cap in `serializeEntity` behind a flag parameter:** rejected; a dual-personality serializer is exactly how the write path regresses. The copy lives in `context.ts`, the only render call site.

### 3. Flag plumbing reuses `envInt` with `min: 0`
`getTouchedByInjectMax()` (default 10, `min: 0` — rendering zero `touched_by` edges is a legitimate config) and `getEntityInjectMax()` changes to `min: 0` for symmetry with `getOrgInjectMax()`. The `memory-v2-fixes` `envInt` already provides strict parsing, per-flag minimums, and warn-on-invalid.

### 4. Editorial spec fixes go directly into the canonical spec
The stale rationale/scenario text inside the org-knowledge requirement travels as a MODIFIED requirement in this change's delta (normative surface, even though the fix is editorial). The status header and the resolved CLI-identifier open question live outside requirement blocks, where delta composition cannot reach — they are edited directly in `openspec/specs/memory-layer/spec.md` in the same commit.

### 5. Commit a concise roadmap, keep the research doc untracked
The re-cut phase plan (eval harness as the prod-enablement gate, Branch-A spike + read tools ahead of embeddings, semantic dedupe split from embedding-backed selection) is committed as `docs/proposals/memory-v2-roadmap.md`. The full research/decision doc (`docs/proposals/memory-v2.md`) stays untracked — per the author, only the actionable roadmap is worth carrying in the repo.

## Risks / Trade-offs

- **[Most tasks may inject zero full org pages]** (task titles often share no tokens with entity names) → Intended ceiling semantics; the always-injected index carries every entity's `L0` line; `owned_by`/repo/expansion signals still fire; injection stays default-off until the eval-harness gate measures recall. If recall suffers, the recorded alternative (small recency floor) is the fallback, now as a measured decision.
- **[`touched_by` truncation hides older provenance from agents]** → Only in the prompt; disk retains all edges and related-task selection reads disk. Raise the flag if agents demonstrably need deeper history.
- **[Existing tests assert unconditional org injection]** → Updated in the same change; the spec delta rewrites the affected scenarios so spec and tests stay aligned.
- **[Prompt block ordering changes]** → Cosmetic; no consumer parses order.

## Migration Plan

- Purely additive flag + selection-semantics change behind the default-off `ARCHIE_MEMORY_INJECT`; no data migration, no on-disk format change.
- **Rollout:** land dark → replay a representative task set and compare injected block size and org-page composition against pre-bounds behavior → the enablement pre-flight (roadmap Phase 1) decides prod enablement.
- **Rollback:** revert the commit or set `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` high / adjust budgets; no schema to revert.
- **Verify:** `npm run typecheck`; `npx vitest run src/memory/__tests__/`.

## Open Questions

- `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` default — 10 is a guess; the replay measurement should confirm whether agents ever use `touched_by` context at all (if not, default lower).
- Should a tiny always-on org allowlist exist for genuinely ubiquitous facts (e.g. "deploys ship Tuesdays") that will never token-match? Deferred to the eval; the index `L0` line is assumed sufficient until measured otherwise.
