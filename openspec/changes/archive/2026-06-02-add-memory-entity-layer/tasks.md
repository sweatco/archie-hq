# Implementation Tasks

Ordered by dependency. Each task is verifiable on its own; tests live with the module they cover (matching `src/memory/__tests__/`).

## 1. Types & paths (foundation)

- [x] 1.1 Add to `types.ts`: `EntityType` (`service|system|integration|concept|repo`), `EntityScope` (`org|domain|repo`), `ObservationCategory` (`fact|config|decision|caveat`), `RelationType` (`depends_on|integrates|owned_by|part_of|touched_by|related_to`).
- [x] 1.2 Add `EntityRecord` (frontmatter + L0 + observations + relations), `EntityObservation`, `EntityRelation`, and `EntityUpdate` (resolve-or-create shape) to `types.ts`.
- [x] 1.3 Add to `paths.ts`: `getEntityPath(slug)`, `getEntityIndexPath()`, `getEntitiesDir()`.
- [x] 1.4 Add `isValidEntitySlug(slug)` to `paths.ts` enforcing `^[a-z0-9][a-z0-9-]{0,63}$`, rejecting separators/`.`/whitespace; `getEntityPath` asserts shape (mirrors `isAllowedUserId`).
- [x] 1.5 Add flag/cap accessors to `paths.ts`: `getEntityCap()` (`ARCHIE_MEMORY_ENTITY_CAP`), `getEntityInjectMax()` (`ARCHIE_MEMORY_ENTITY_INJECT_MAX`).
- [x] 1.6 Unit tests in `__tests__/paths.test.ts`: valid slugs accepted; traversal/whitespace/uppercase/over-length rejected; cap/inject-max defaults.

## 2. Sanitization (trust boundary)

- [x] 2.1 Add `sanitizeEntitySlug()` to `sanitize.ts` (drop-with-warning on invalid; no coercion that could mask traversal).
- [x] 2.2 Add closed-vocabulary guards: `isAllowedObservationCategory()`, `isAllowedRelationType()`; reject unknowns.
- [x] 2.3 Add `sanitizeEntityObservation()` and `sanitizeEntityRelation()` (single-line, length-bounded, valid `[[wikilink]]` target, reuse existing injection/secret heuristics).
- [x] 2.4 Unit tests in `__tests__/sanitize.test.ts`: unknown relation/category dropped; traversal slug dropped; injection/secret-shaped observation dropped; valid items pass.

## 3. Entity store (read/write/parse)

- [x] 3.1 New `entities.ts`: `readEntity(slug)` / `writeEntity(record)` parsing & serializing frontmatter + `<!-- L0 -->` + `## Facts` + `## Relations`.
- [x] 3.2 `listEntities()` and `entityCount()` over `entities/`.
- [x] 3.3 `resolveEntity(slugOrAlias)` — match by canonical slug or any `aliases` entry across existing entities.
- [x] 3.4 `applyEntityUpdate(update, taskId)` — resolve-or-create, append sanitized observations with `<!-- touched: YYYY-MM-DD -->` (reuse `annotations.ts`), add typed relations, auto-add `touched_by [[taskId]]`; returns soft-cap-exceeded boolean.
- [x] 3.5 Unit tests in `__tests__/entities.test.ts`: round-trip read/write; alias resolution updates existing file (no duplicate); auto `touched_by`; observation gets `touched:` annotation.

## 4. Entity index (derived) & selection

- [x] 4.1 New `entity-index.ts`: `rebuildIndex()` regenerates `entities/index.md` (one row per entity: `[[slug]]`, type, scope, L0 summary, last-touched) — derived, overwrites prior.
- [x] 4.2 `readIndex()` returning parsed rows for scoring.
- [x] 4.3 `selectEntities({repo, plugin, users, taskTitle})`: score rows against context (token/substring over display_name+aliases+summary), union `scope:org`, 1-hop expand along relations, bound to `getEntityInjectMax()`, return selected + dropped slugs.
- [x] 4.4 Unit tests in `__tests__/entity-index.test.ts`: rebuild reflects files & drops deleted entity; repo+org selection; 1-hop expansion pulls linked entity; bound returns top-N and reports drops.

## 5. Extraction (entity_updates)

- [x] 5.1 Extend `ExtractionResult` with `entity_updates: EntityUpdate[]`; parse in `extractor.ts` (happy/fenced/missing-field paths).
- [x] 5.2 Pass the current entity index into the extraction prompt as resolution context (new `{{ENTITY_INDEX}}` substitution).
- [x] 5.3 Update `prompts/memory-extractor.md`: high-bar entity criteria, closed category/relation vocab, "resolve against index — do not duplicate," untrusted-data reminder; document `entity_updates` JSON shape.
- [x] 5.4 Unit tests in `__tests__/extractor.test.ts`: `entity_updates` parsed; `{{ENTITY_INDEX}}` substituted; malformed entity update tolerated.

## 6. Lifecycle wiring

- [x] 6.1 In `lifecycle.ts` `processExtraction()`: load + supply entity index to extraction; apply `entity_updates` via `applyEntityUpdate`; collect touched entity slugs.
- [x] 6.2 Enqueue entity housekeeping when entity soft cap exceeded (reuse the serialized housekeeping queue).
- [x] 6.3 Replace/augment related-tasks selection: prefer tasks sharing a `touched_by` entity with the current task; fall back to existing domain + lexical overlap; reflect in `## Memory Updates` (entity files appear as a target group).
- [x] 6.4 Trigger `rebuildIndex()` after applying entity updates.
- [x] 6.5 Unit tests in `__tests__/lifecycle.test.ts`: end-to-end entity write from a transcript; related-task chosen by shared entity; lexical fallback when no entity overlap.

## 7. Retrieval injection at spawn

- [x] 7.1 In `context.ts` `buildMemoryContext()`: add `<entity_index>` (when entities exist) and `<entity slug="..." ...>` blocks for selected pages; keep disabled-flag passthrough byte-for-byte.
- [x] 7.2 Extend `enrichPromptWithMemory()` signature to accept the spawn selectors (repo/plugin + users + task title); thread them from `spawn.ts` at the three call sites (PM/repo/plugin).
- [x] 7.3 Log dropped entity slugs when injection bound is exceeded.
- [x] 7.4 Unit tests in `__tests__/context.test.ts`: index always present when entities exist; repo+org pages injected; 1-hop page injected; bound logs drops; disabled passthrough unchanged.

## 8. Housekeeping (entities)

- [x] 8.1 In `housekeeping.ts`: detect alias-overlapping entities and run a merge pass (fold observations/relations/aliases into one canonical slug; remove the merged-away file; no orphan).
- [x] 8.2 Archive (not delete) entities whose observations are all stale beyond the staleness window (`status: archived`).
- [x] 8.3 Rebuild `entities/index.md` at end of pass; apply the trace-back validator so merges introduce no new facts.
- [x] 8.4 Update `prompts/memory-housekeeper.md` with entity merge/prune rules and the no-new-facts constraint.
- [x] 8.5 Unit tests in `__tests__/housekeeping.test.ts`: two alias entities merge to one; fully-stale entity archived not deleted; index rebuilt; consolidator introduces no new fact.

## 9. Bootstrap & config

- [x] 9.1 In `index.ts` `initMemory()`: create `entities/` directory on bootstrap (skipped when disabled).
- [x] 9.2 Add `ARCHIE_MEMORY_ENTITY_CAP` and `ARCHIE_MEMORY_ENTITY_INJECT_MAX` to `.env.example` with sensible defaults and comments.
- [x] 9.3 Verify ejectability: `entities/` removal and `ARCHIE_MEMORY=false` leave a clean tree; core modules import only the public surface.

## 10. Docs & spec sync

- [x] 10.1 Update `docs/architecture/memory.md`: storage layout (`entities/`, `entities/index.md`), entity schema, retrieval-selection narrative + diagram, entity housekeeping, "Future directions" (hybrid pull / embeddings / domain-dir split).
- [x] 10.2 At archive time, revise the canonical spec Non-Goals prose (domain-split files; pull retrieval) per the proposal, and merge the requirement deltas.
- [x] 10.3 Full gate: `npm run typecheck && npm test` green; manual smoke — complete a task, confirm an entity page + index row are produced and injected on the next spawn.

## 11. Retire org.md (collapse organizational knowledge into entities)

Organizational knowledge moves to `scope: org` entities; `org.md` and its parallel channel + housekeeping are removed. User-file housekeeping is untouched — only the org-specific pieces go.

- [x] 11.1 Backfill the existing `org.md` content into entities: migrate the one bullet (`Backend uses Ruby 3.4.9`) to a `backend` entity observation (repo scope, `repos: [backend]`), then delete `workdir/memory/org.md`. n=1 — a one-off move, not a general migration pass.
- [x] 11.2 Remove the `org_updates` channel: drop `org_updates` from `ExtractionResult` (`types.ts`) and from `parseExtractionResponse` (`extractor.ts`); delete the "ORGANIZATION KNOWLEDGE" section and `{{ORG_MEMORY}}` substitution from `prompts/memory-extractor.md`, folding its high bar into the entity criteria (org-level fact → `scope: org` entity observation) and removing `org_updates` from the JSON contract.
- [x] 11.3 Remove org storage: delete `applyOrgUpdates`, `readOrg`, `writeOrg` (`store.ts`) and `getOrgPath` + the `ARCHIE_MEMORY_ORG_CAP` accessor (`paths.ts`); remove the `applyOrgUpdates(...)` call and `### org.md` summary group from `processExtraction` (`lifecycle.ts`).
- [x] 11.4 Remove the `<organizational_knowledge>` block from `buildMemoryContext` (`context.ts`).
- [x] 11.5 Exempt `scope: org` entities from `ARCHIE_MEMORY_ENTITY_INJECT_MAX` in `selectEntities` (`entity-index.ts`): always return all `scope: org` pages in full; apply the bound only to the repo/domain/title-scored + graph-expanded remainder; keep logging dropped non-org slugs.
- [x] 11.6 Narrow housekeeping to user files: remove the `'org'` `runHousekeeping` target and `consolidateFile('org.md', …)` (`housekeeping.ts`, `scripts/memory-housekeeping.ts`); update `prompts/memory-housekeeper.md` to user files only. **Keep** the consolidation side-agent, the 40%-edit-distance trace-back validator, `ARCHIE_MEMORY_USER_CAP`, `ARCHIE_MEMORY_SECTION_CAP` (still used by user files), and `ARCHIE_MEMORY_STALENESS_DAYS` — only `ARCHIE_MEMORY_ORG_CAP` is org-only and removed.
- [x] 11.7 Update tests: drop org-only cases (`store.test.ts` org read/write/apply, `housekeeping.test.ts` org cap + org consolidation, `context.test.ts` `<organizational_knowledge>`), repoint shared cases (`paths.test.ts`, `extractor.test.ts`, `lifecycle.test.ts`) off org, add a `selectEntities` test proving `scope: org` pages bypass the inject bound, and an extractor test asserting no `org_updates` / `{{ORG_MEMORY}}`.
- [x] 11.8 Docs & config (same-commit sync per `src/memory/CLAUDE.md`): update `docs/architecture/memory.md` — drop `org.md` from the storage layout, diagrams, formats, and flags table; document org-knowledge-as-`scope:org`-entities and the inject-bound exemption; remove the "org.md → entity backfill" future item. Remove `ARCHIE_MEMORY_ORG_CAP` from `.env.example`. At archive, apply the free-prose canonical-spec edits `openspec archive` won't merge automatically (`openspec/specs/memory-layer/spec.md`): drop the Glossary `Org memory` line, reword the `Domain-split files` Non-Goal off "a single `org.md`", and resolve Open Question 2 as "`org.md` retired."
- [x] 11.9 Gate: `npm run typecheck && npm test` green; `openspec validate add-memory-entity-layer --strict` green; manual smoke — complete a task, confirm an org-level fact lands as a `scope: org` entity (always injected) and no `org.md` is written.
