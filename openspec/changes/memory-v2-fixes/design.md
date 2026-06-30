## Context

`memory-v2-phase1` (unarchived, in the working tree) bounded `scope: org` entity injection and added a per-page observation cap (`ARCHIE_MEMORY_ENTITY_OBS_CAP`, default 30). A max-effort review found that the cap and the new flags lose data in ways that defeat their own purpose:

- **Same-day tie drops the fresh fact.** `applyEntityUpdate` appends new observations at the end of `record.observations` with today's date, then runs `[...obs].sort((a,b) => (b.touched ?? '').localeCompare(a.touched ?? '')).slice(0, cap)`. `Array.prototype.sort` is stable, so on a `touched:` tie the original order is preserved and the just-appended (last) entries sort to the bottom — exactly the ones `.slice` drops. A hot entity already holding `cap` observations dated today silently discards the current task's `[decision]`/`[caveat]`.
- **Merge path bypasses the cap.** The cap lives only in `applyEntityUpdate`. `runEntityHousekeeping` → `mergeInto` appends a duplicate's observations into the canonical record and persists via `writeEntity` (`src/memory/housekeeping.ts:187`) with no cap, so a merged page can carry ~2× the cap and re-inflate every prompt it lands in.
- **Re-affirmation doesn't refresh recency.** A re-emitted observation is deduped by `(category, normalized text)` and `continue`d, keeping its original `touched:`. Phase 1 made `touched:` decide eviction (the cap here, and the staleness pass in `housekeeping.ts`), so a fact agents keep confirming ages monotonically and becomes the *first* to be dropped.
- **`envInt` eats the kill-switch.** `envInt` (`src/memory/paths.ts:38`) returns the fallback unless `Number.isFinite(n) && n > 0`, so `ARCHIE_MEMORY_ORG_INJECT_MAX=0` (the advertised "inject no full org pages, rely on the index" config) silently becomes `8`. `parseInt` also accepts `8x` as `8`.

Constraints (from `src/memory/CLAUDE.md`): file-based, no DB, single-step ejectable; writes serialized through the `lifecycle.ts` queue; model output stays sanitized; docs/spec/tests updated in the **same** change. Injection is gated by the default-off `ARCHIE_MEMORY_INJECT`, so the read path can still change dark.

## Goals / Non-Goals

**Goals:**
- No write path can persist an entity page above the observation cap.
- The current task's freshly-extracted observation is never the one dropped on a tie.
- A repeatedly-confirmed observation does not age out of the cap or staleness window.
- Operator-set flag values are honored (including `0` where meaningful) or loudly rejected — never silently overridden.
- Remove two redundant hot-path costs in the touched files **without changing behavior**: the per-update full entity-store re-read in `applyEntityUpdate`, and the per-comparison recency rescan in `selectEntities`.
- Docs/spec/tests move in lockstep with the code.

**Non-Goals (intentional Phase-1 design or deferred):**
- **Org-page recall regression** — bounding org injection (lowest-scoring org pages become index-only past `ARCHIE_MEMORY_ORG_INJECT_MAX`) is the *intended* Phase-1 behavior; better selection is Phase 2 (embeddings). Not reverted here.
- **Extractor's narrower-scope bias** — also intentional Phase 1; left as is.
- **Capping relations** — the auto `touched_by` edge grows unbounded and is serialized into the injected block; acknowledged Phase-1 choice, deferred to a later phase (would need a relation-eviction policy).
- **Broader perf rework** — only the two specific O(K×M) / O(n log n × obs) costs the review flagged are addressed; no caching layer, index format change, or other restructuring.

## Decisions

### 1. Enforce the cap inside `writeEntity`, via a pure helper — not at each call site
Add a pure `applyObservationCap(record): number` (returns dropped count) in `entities.ts` and call it at the top of `writeEntity`, before `serializeEntity`. Remove the now-redundant inline cap block from `applyEntityUpdate`.
- **Why:** `writeEntity` is the single persistence choke point and has exactly two production callers (`applyEntityUpdate`, the housekeeping merge loop) — both of which *want* the page bounded. Enforcing here gives the strongest, regression-proof invariant ("no persisted page exceeds the cap, regardless of path") and closes the merge-path hole for free, including any future write path.
- **Trade-off:** `writeEntity` goes from a pure serializer to "bound-then-serialize." Acceptable: the cap is a system-wide invariant on the on-disk format, so the persistence boundary is its natural home. The helper stays pure and unit-testable in isolation.
- **Alternative — add a cap call only in the merge path:** rejected; fixes the one known bug but the next write path that forgets it regresses silently, and it keeps two copies of the cap logic.

### 2. Tie-break = retain the most-recently-applied observation (undated = oldest)
In `applyObservationCap`, decorate with array index and sort by `touched:` descending, then by **index descending**, then `slice(0, cap)`:
```
record.observations = record.observations
  .map((o, i) => ({ o, i }))
  .sort((a, b) => (b.o.touched ?? '').localeCompare(a.o.touched ?? '') || b.i - a.i)
  .slice(0, cap)
  .map((x) => x.o);
```
- **Why:** array position is insertion order. `applyEntityUpdate` appends the current task's observations last, and `mergeInto` appends the merged-in ones last; "later index wins on a date tie" guarantees the freshest write survives. Undated (`?? ''`) sort below any date and are dropped first, matching the existing doc comment.
- **Alternative — sub-day timestamp precision on `touched:`:** rejected; `touched:` is date-only by storage format (`YYYY-MM-DD`) across the layer and the docs/spec. Widening it is a much larger change for no additional correctness here.

### 3. Re-stamp `touched:` on a dedupe hit
In `applyEntityUpdate`'s observation loop, when `hasObservation` matches, update the existing entry's `touched:` to today instead of `continue`-ing without effect.
- **Why:** `touched:` now means "last time this fact was relevant," and that is exactly what a re-affirmation establishes. This keeps durable, repeatedly-confirmed facts at the top of the retain set (composes with Decision 2) and out of the staleness sweep.
- **Alternative — a separate `affirmed:` field:** rejected; `touched:` already carries the recency semantics the cap and staleness pass read, and adding a field touches the storage format, serializer, parser, and spec.

### 4. `envInt` gains a `min` bound, strict parsing, and a warn-on-invalid
Signature becomes `envInt(name, fallback, min = 1)`. Trim the raw value; if unset → fallback silently (env simply not provided). If set: parse strictly (reject non-integer strings like `8x`); if it parses and is `>= min`, use it; otherwise **`logger.warn`** and return the fallback. `getOrgInjectMax()` passes `min: 0`.
- **Why:** `0` is a legitimate, advertised value for the org budget (index-only); the current `> 0` guard makes that the inverse of intent. The warn turns every other silent-fallback (`0`, `8x`, `-5`) into an operator-visible signal.
- **`ARCHIE_MEMORY_ENTITY_OBS_CAP` keeps `min: 1`.** With Decision 1, a `0` cap would nuke *all* observations on every write — destructive misconfiguration. So `0` warns and falls back rather than being honored. (Documented as an open question below.)
- **Import:** `paths.ts` does not currently import the logger; add `import { logger } from '../system/logger.js'` (already used elsewhere in `src/memory`, so ejection-safe).
- **Alternative — allow `0` globally:** rejected; `0` for `USER_CAP`/`SECTION_CAP`/`ENTITY_CAP`/`OBS_CAP` is degenerate. A per-flag floor is the precise fix.

### 5. Hoist `listEntities()` out of the per-update loop and thread the records through
`applyEntityUpdate` gains an **optional** trailing parameter for the existing-records array; when supplied it uses that instead of `await listEntities()`. `lifecycle.ts` reads the store once above the `for (const update of result.entity_updates)` loop and passes the same array into every call. To stay coherent across iterations: `resolveEntity` already returns a *reference into* the array, so updates to existing entities are reflected automatically; `applyEntityUpdate` must additionally **push a newly-created record** into the array so a later update to that same entity in the same task resolves it (today that works only because each call re-reads from disk).
- **Why:** turns K×M `readFile`+parse per task into M once. The disk round-trip per update existed only to re-discover entities the loop itself just wrote.
- **Backward-compatible:** the parameter is optional and defaults to `await listEntities()`, so other callers and existing tests are unaffected.
- **Alternative — a module-level cache in `entities.ts`:** rejected; hidden cross-call state is harder to reason about and risks staleness against the housekeeping/merge writes. Passing the array explicitly keeps the data flow visible and scoped to one task's loop.

### 6. Precompute `lastTouched` before the `selectEntities` sort
Build a `Map<slug, string>` of each candidate's `lastTouched` once, then have the sort comparator read the map instead of recomputing.
- **Why:** a comparator runs O(n log n) times; calling `lastTouched` (a full observation scan) inside it multiplies the scan by log n for no reason. Decorate-then-sort makes it one scan per record. Purely mechanical — identical ordering.
- **Alternative — store `lastTouched` on the record at parse time:** rejected for this change; it widens `EntityRecord` and the parser for a localized hot-loop fix. The map is local to `selectEntities`.

## Risks / Trade-offs

- **[`writeEntity` is now lossy on over-cap pages]** → It only trims pages that already exceed the cap, which is the system-wide invariant regardless of caller; existing test fixtures are small (audit `housekeeping.test.ts` writes for any >cap page before relying on read-back).
- **[Housekeeping now trims every record it rewrites, not just merged ones]** → This is a feature (lazy trim of legacy over-cap pages, matching the Phase-1 migration note "trimmed lazily on their next write"), but it means a housekeeping pass can drop observations from untouched pages. Logged per page; acceptable.
- **[Re-stamping keeps a reaffirmed-but-otherwise-stale fact alive indefinitely]** → Intended: a fact a task just reconfirmed is by definition not stale.
- **[Tie-break reorders same-date observations]** → Cosmetic only (serialization order); does not change which survive beyond the intended "freshest applied wins."
- **[`listEntities()` hoist breaks same-task entity resolution]** → The real risk of Decision 5: if a newly-created record isn't pushed into the shared array, a second update to that entity in the same task would create a duplicate instead of resolving it. Mitigation: push-on-create plus an explicit test (two updates to one just-created entity in a single `handleTaskCompleted`); existing entities resolve via the array reference unchanged.
- **[Spec delta references a requirement not yet in the base spec]** → This change stacks on `memory-v2-phase1`; see Dependency. `openspec validate` may flag the MODIFIED requirement until phase1 archives.

## Dependency & Migration Plan

- **Stacked on `memory-v2-phase1`.** The spec delta MODIFIES the observation-cap requirement that phase1 *adds*. Implement and **archive `memory-v2-phase1` first**, then this change; its delta composes on top. Until phase1 archives, the requirement is absent from `openspec/specs/memory-layer/spec.md`, so strict validation of this delta is expected to warn.
- **No new flags, no data migration.** Over-cap pages (including merged ones) are trimmed lazily on their next write.
- **Rollout/rollback:** all behavior stays behind the default-off `ARCHIE_MEMORY_INJECT` (read path) and the existing cap flags; adjust the flags or unset injection to revert. No schema change.
- **Verify:** `npm run typecheck`; `npx vitest run src/memory/__tests__/`.

## Open Questions

- **Fold into `memory-v2-phase1` instead of a stacked change?** Since phase1 has not shipped/archived, amending it would avoid a "fix a change that never shipped" follow-up and the cross-change spec dependency. This change is authored as requested (`/opsx:propose`); flagging the cleaner alternative for the author to decide before `/opsx:apply`.
- **`ARCHIE_MEMORY_ENTITY_OBS_CAP=0`** — warn + fall back to 30 (chosen, since `0` is destructive under Decision 1), or honor it as "no observations persisted"? Confirm warn+fallback is the desired contract.
- **Should the housekeeping pass cap *all* records or only merged canonicals?** Decision 1 caps all records it rewrites (simplest, lazily fixes legacy). Confirm that broad lazy-trim is acceptable, or scope the cap to merged pages only.
