## 1. Selection: org budget becomes a ceiling

- [x] 1.1 `src/memory/entity-index.ts` — remove `SCORE_ORG` and the unconditional `scope: org` candidacy bump in `selectEntities`; org pages become candidates only via repo match, `owned_by` participant, token overlap, or one-hop expansion, and consume the org budget ranked by score with last-touched recency tiebreak; update the function doc comment (ceiling semantics, zero-signal pages are index-only and not logged as drops)
- [x] 1.2 `src/memory/__tests__/entity-index.test.ts` — update existing expectations that assume unconditional org injection; add: zero-signal org page is not selected and not in `dropped` despite spare org budget; signal-bearing org pages are selected up to the ceiling; org page reachable only via expansion is selected

## 2. Render-time touched_by bound

- [x] 2.1 `src/memory/paths.ts` — add `getTouchedByInjectMax()` (`ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX`, default 10, `min: 0`); change `getEntityInjectMax()` to `min: 0`
- [x] 2.2 `src/memory/context.ts` — `renderEntityBlock` renders from a shallow copy of the record with `touched_by` relations truncated to the newest N (trailing array entries); other relation types untouched; the stored record and disk file are never modified
- [x] 2.3 Tests — injected block contains only the newest N `touched_by` edges while other relation types render in full; the record passed in is not mutated; `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX=0` renders no `touched_by` edges; `ARCHIE_MEMORY_ENTITY_INJECT_MAX=0` is honored (flag parsing)

## 3. Canonical-spec editorial fixes (outside delta reach)

- [x] 3.1 `openspec/specs/memory-layer/spec.md` — update the `**Status:**` line to credit `memory-v2-phase1` / `memory-v2-fixes`; mark Open Question 1 (CLI identifier) resolved by the stable-identifier requirement (`cli:<sessionId>` fallback)

## 4. Docs

- [x] 4.1 `docs/architecture/memory.md` — selection section: org candidacy requires a relevance signal, budget is a ceiling; flags table: add `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX`, note `0` now valid for `ARCHIE_MEMORY_ENTITY_INJECT_MAX`; entity-page injection prose: `touched_by` truncated at render time, full history on disk
- [x] 4.2 `.env.example` — add `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX`
- [x] 4.3 `docs/proposals/memory-v2-roadmap.md` — commit a concise roadmap for the remaining phases: eval harness as prod-enablement gate; Branch-A spike + read tools before embeddings; semantic dedupe split from embedding-backed selection (the full research doc stays untracked)

## 5. Verify

- [x] 5.1 `npm run typecheck` passes
- [x] 5.2 `npx vitest run src/memory/__tests__/` passes
