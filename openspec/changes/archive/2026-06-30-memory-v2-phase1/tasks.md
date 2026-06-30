## 1. Flags & configuration

- [x] 1.1 Add a `getOrgInjectMax()` accessor in `src/memory/paths.ts` (env `ARCHIE_MEMORY_ORG_INJECT_MAX`, default `8`), alongside the existing flag accessors.
- [x] 1.2 Add a `getEntityObsCap()` accessor in `src/memory/paths.ts` (env `ARCHIE_MEMORY_ENTITY_OBS_CAP`, default `30`).
- [x] 1.3 Document both new flags in `.env.example` next to the existing `ARCHIE_MEMORY_ENTITY_*` entries.

## 2. Bound org-entity injection (`src/memory/entity-index.ts`)

- [x] 2.1 In `selectEntities()`, remove the org exemption so `scope: org` pages no longer bypass a budget (the `r.scope === 'org' || nonOrgBudget > 0` shortcut).
- [x] 2.2 Give org pages their own budget `ARCHIE_MEMORY_ORG_INJECT_MAX`, separate from the non-org `ARCHIE_MEMORY_ENTITY_INJECT_MAX`; select org pages by relevance score (not the flat `SCORE_ORG` always-win).
- [x] 2.3 Use last-touched (`touched:`) recency as the tiebreak when ranking org pages within their budget.
- [x] 2.4 Extend drop-logging to cover dropped `scope: org` slugs (mirroring the existing non-org drop log).
- [x] 2.5 Verify `context.ts` still injects the full `<entity_index>` unconditionally (no page bound on the index); adjust only if needed.

## 3. Per-page observation cap (`src/memory/entities.ts`)

- [x] 3.1 In `applyEntityUpdate()`, after observation dedup/append, enforce `ARCHIE_MEMORY_ENTITY_OBS_CAP`: order observations by `touched:` descending, retain the newest N, drop the oldest surplus.
- [x] 3.2 Log the number of observations dropped; leave the relations list untouched (relations are not capped).

## 4. Unbias extraction scope

- [x] 4.1 Edit `prompts/memory-extractor.md`: remove "Default to `org` for anything not clearly repo-specific"; instruct the extractor to use the narrowest applicable scope (`repo` when repo-specific; `org` only for genuinely cross-cutting facts).
- [x] 4.2 In `pickScope()` (`src/memory/entities.ts`), stop actively defaulting ambiguous no-scope/no-repo cases to `org` beyond the documented structural last-resort fallback (per design Decision 5).

## 5. Tests (`src/memory/__tests__/`)

- [x] 5.1 `entity-index.test.ts`: when org count exceeds `ARCHIE_MEMORY_ORG_INJECT_MAX`, only the top-N org pages are injected, chosen by relevance with recency tiebreak, and dropped org slugs are logged.
- [x] 5.2 `entity-index.test.ts`: an org entity dropped from full injection still appears as a row (with its `L0`) in the `<entity_index>`.
- [x] 5.3 `entity-index.test.ts`: the non-org bound (`ARCHIE_MEMORY_ENTITY_INJECT_MAX`) and 1-hop wikilink expansion still behave as before.
- [x] 5.4 `entities.test.ts`: a page over `ARCHIE_MEMORY_ENTITY_OBS_CAP` keeps exactly N newest-touched observations, drops the oldest, logs the count, and does not drop relations.
- [x] 5.5 `entities.test.ts`: `pickScope()` no longer auto-promotes the ambiguous case per the chosen fallback behavior.

## 6. Docs (same change, per `src/memory/CLAUDE.md`)

- [x] 6.1 Update the "Read Path — Memory Injection at Spawn" section of `docs/architecture/memory.md`: org entities are bounded and relevance-selected (not always-injected/exempt); the index is the always-on catalogue and Phase-1 recall safety net.
- [x] 6.2 Add `ARCHIE_MEMORY_ORG_INJECT_MAX` and `ARCHIE_MEMORY_ENTITY_OBS_CAP` to the flags table in `docs/architecture/memory.md`.

## 7. Verify & measure

- [x] 7.1 `npm run typecheck` is clean.
- [x] 7.2 `npx vitest run src/memory/__tests__/` is green.
- [x] 7.3 With `ARCHIE_MEMORY_INJECT=true`, replay a representative task and capture the `## Organizational Memory` block size; confirm the drop and record the measured number in the change.
  - **Verified live** (Docker, `npm run docker:dev`) against the real exported store `archie-data-20260622-183112` (139 entities, **128 `scope:org`**), injection on, Phase-1 code mounted. A real PM task ("How does our Adjust attribution integration work…") logged `[memory] entity selection dropped 120 over inject cap` → only **8 org pages injected in full**. Entity-injection tokens on this store: **~257K (all 128 org, pre-Phase-1) → ~41K (index ~6K + bounded pages ~35K) ≈ 84% cut.** A/B: flipping `ARCHIE_MEMORY_ORG_INJECT_MAX` 8↔999 on the same running system moved org injection 8↔128 (drop line present vs absent). The PM still produced a correct Adjust summary, pulling the dropped `adjust` detail via search (index-as-catalogue + fetch working).
  - **Finding:** the lexical scorer dropped the *most query-relevant* entity (`adjust`) from full injection — the always-injected index covered it and the agent fetched the detail, but this is the selection-precision gap that Phase 2 (embeddings) is meant to close.
