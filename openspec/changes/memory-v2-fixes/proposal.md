## Why

A max-effort review of the memory-v2 Phase-1 implementation (the org-injection bound + per-page observation cap) surfaced **four correctness bugs that silently lose memory**. They all defeat the very guarantees Phase 1 was built to provide — a freshly-extracted fact can be dropped the moment it is written, the cap is bypassed on the auto-merge path, the new kill-switch flags silently ignore `0`, and repeatedly-confirmed facts are the *most* likely to be evicted. These should land before Phase 1 injection is enabled in production.

This change sits **on top of `memory-v2-phase1`** (it strengthens requirements that change introduced) and should be implemented/archived after it.

## What Changes

- **Fix the observation-cap tie-break so the current task's fresh fact is never dropped.** The cap sorts `touched` descending with a stable sort and slices the first N; new observations are appended last, so on a same-day tie they sort to the bottom and get dropped. Retain the **most-recently-applied** observation on a `touched:` tie.
- **Enforce the cap on every write path, including the housekeeping merge.** Today the cap lives only in `applyEntityUpdate`; `runEntityHousekeeping`'s `mergeInto → writeEntity` appends a duplicate's observations and persists the merged page **uncapped** (up to ~2× the cap). Move enforcement to the single `writeEntity` persistence boundary via a pure helper so no write path can exceed the cap.
- **Refresh `touched:` when an observation is re-affirmed.** `applyEntityUpdate` dedupes a re-emitted observation by `(category, normalized text)` and `continue`s, leaving the original date. Since Phase 1 made `touched:` decide eviction (cap + staleness), a fact that agents keep confirming ages monotonically and becomes a prime drop candidate. Re-stamp the existing observation to today on a dedupe hit.
- **Honor `0` and reject malformed values for the injection/cap flags.** `envInt` discards any non-positive value, so `ARCHIE_MEMORY_ORG_INJECT_MAX=0` (an advertised "index-only" config) silently becomes `8`, and `parseInt` leniency accepts `8x` as `8`. Add a per-flag minimum (`0` for `ARCHIE_MEMORY_ORG_INJECT_MAX`), parse strictly, and **log a warning** when a set value is invalid instead of silently falling back.
- **Sync the stale doc comment.** `docs/architecture/memory.md` still annotates `scope:` with `(org ⇒ always injected)`, contradicting the bounded behavior Phase 1 shipped (required by `src/memory/CLAUDE.md`'s same-change doc-sync rule).
- **Cut two redundant hot-path costs the review flagged in the touched files (behavior-preserving):**
  - `applyEntityUpdate` calls `listEntities()` — a `readdir` + `readFile` + parse of *every* entity page — on **each** update, so a task touching K entities in a store of M pages does K×M reads/parses. Hoist a single `listEntities()` into the `lifecycle.ts` update loop and thread the in-memory records through, keeping the array coherent as updates create/modify entities.
  - `selectEntities` recomputes `lastTouched(r)` (a full scan of the record's observations) **inside** its sort comparator, i.e. O(n log n) times per spawn on the injection hot path. Precompute it once per record into a map before sorting.
- **Tests** for every fix: same-day tie, multi-observation batch over cap, undated observations, merge-path enforcement, re-affirmation re-stamp, the flag-parsing edge cases, and same-task resolution of a just-created entity (locks in the `listEntities()` hoist).
- **Out of scope (intentional Phase-1 design or deferred):** the org-page recall regression (bounded org injection is the intended Phase-1 behavior; Phase 2 embeddings improve selection), the extractor's narrower-scope bias, and leaving relations uncapped. See `design.md` Non-Goals.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `memory-layer`: strengthens the Phase-1 **per-page observation cap** requirement — it is broadened to apply on **all write paths** (including the housekeeping merge), to define the **tie-break** (most-recently-applied observation retained on a `touched:` tie, undated treated as oldest), and to specify that **re-affirming** an existing observation refreshes its `touched:` date so it is not aged out. (The `ARCHIE_MEMORY_ORG_INJECT_MAX=0` boundary needs no new normative text — `0` is simply the lower bound of the existing org-injection budget — so it is covered by the flag-parsing fix and a unit test, not a spec scenario.)

## Impact

- **Code:**
  - `src/memory/entities.ts` — extract a pure `applyObservationCap(record)` helper (sort by `touched:` desc, most-recently-applied retained on ties, undated treated as oldest); call it inside `writeEntity` so every persisted page is bounded; remove the now-redundant inline cap block in `applyEntityUpdate`; re-stamp `touched:` on the dedupe-hit path.
  - `src/memory/housekeeping.ts` — no new cap call needed once `writeEntity` enforces it (the merge path already routes through `writeEntity`); verify and test the merged page is bounded.
  - `src/memory/paths.ts` — `envInt` gains a `min` bound (default `1`), strict integer parsing, and a warning on invalid-when-set; `getOrgInjectMax()` uses `min: 0`.
  - `src/memory/entities.ts` — `applyEntityUpdate` takes the existing-records array as an (optional) parameter instead of calling `listEntities()` itself, and pushes a newly-created record into it.
  - `src/memory/lifecycle.ts` — hoist one `listEntities()` above the entity-update loop and pass the shared array into each `applyEntityUpdate`.
  - `src/memory/entity-index.ts` — precompute `lastTouched` into a `Map<slug,string>` before the `selectEntities` sort; the comparator reads the map.
- **Spec:** `openspec/specs/memory-layer/spec.md` (delta in this change; composes on top of the `memory-v2-phase1` delta — see Dependency note in `design.md`). The two efficiency fixes are behavior-preserving and add no normative requirement.
- **Docs (same change, per `src/memory/CLAUDE.md`):** `docs/architecture/memory.md` — replace the `(org ⇒ always injected)` comment.
- **Tests:** `src/memory/__tests__/entities.test.ts` (tie / batch / undated / re-stamp), `src/memory/__tests__/housekeeping.test.ts` (merge-path cap), `src/memory/__tests__/paths.test.ts` or inline (flag parsing).
- **No new flags, no data migration.** Over-cap legacy pages are trimmed lazily on their next write (now true for the merge path too). All behavior remains gated behind the existing default-off `ARCHIE_MEMORY_INJECT`.
