## 1. Observation cap — fix tie-break & enforce on all write paths (`src/memory/entities.ts`)

- [x] 1.1 Add a pure exported helper `applyObservationCap(record: EntityRecord): number` that, when `record.observations.length > getEntityObsCap()`, sorts by `touched:` descending **then by original array index descending** (most-recently-applied wins a same-date tie; undated `?? ''` sorts last), truncates to the cap **in place** on `record.observations`, and returns the number dropped.
- [x] 1.2 Call `applyObservationCap(record)` at the top of `writeEntity()` (before `serializeEntity`); when it returns `> 0`, log `applyEntityUpdate`-style: `${record.entity} exceeded observation cap ${cap} — dropped N oldest`.
- [x] 1.3 Remove the now-redundant inline cap block in `applyEntityUpdate()` (the `[...record.observations].sort(...).slice(...)` at ~lines 283-290), since `writeEntity` now enforces it.
- [x] 1.4 Confirm the two production `writeEntity` callers (`applyEntityUpdate`, `runEntityHousekeeping`) need no per-call cap logic afterward, and that no caller relied on `writeEntity` being non-lossy.

## 2. Re-affirmation refreshes recency (`src/memory/entities.ts`)

- [x] 2.1 In `applyEntityUpdate()`'s observation loop, on a `hasObservation()` dedupe hit, update the matching existing observation's `touched:` to `date` instead of `continue`-ing with no effect (find the entry by category + normalized text and set its `touched`).
- [x] 2.2 Ensure this composes with 1.1 — a re-affirmed observation, now dated today, is retained by the cap.

## 3. Honor `0` / reject malformed flag values (`src/memory/paths.ts`)

- [x] 3.1 Change `envInt(name, fallback)` to `envInt(name, fallback, min = 1)`: trim raw; if unset return fallback silently; parse strictly (reject non-integer strings such as `8x`); if parsed and `>= min` use it, else `logger.warn` (name + raw value) and return fallback.
- [x] 3.2 Add `import { logger } from '../system/logger.js'` to `paths.ts` (first logger use in this file).
- [x] 3.3 Pass `min: 0` from `getOrgInjectMax()`; leave `getEntityObsCap()` (and the other cap accessors) at the default `min: 1` (a `0` obs cap is destructive under task 1.2 — warn + fall back).

## 4. Cut redundant hot-path work (behavior-preserving)

- [x] 4.1 `src/memory/entities.ts`: add an **optional** trailing param to `applyEntityUpdate` for the existing-records array (default `await listEntities()` so other callers/tests are unaffected); use it in place of the internal `listEntities()` call (~line 212).
- [x] 4.2 `src/memory/entities.ts`: when a new record is created (`created === true`), push it into that records array before returning, so a later update to the same entity in the same task resolves it (existing entities already resolve via the array reference).
- [x] 4.3 `src/memory/lifecycle.ts`: hoist a single `const records = await listEntities()` above the `for (const update of result.entity_updates)` loop and pass `records` into each `applyEntityUpdate(update, taskId, undefined, records)`.
- [x] 4.4 `src/memory/entity-index.ts`: in `selectEntities`, build a `Map<slug, string>` of `lastTouched` over the candidate records once, before the `.sort(...)`, and have the comparator read the map instead of calling `lastTouched(a)`/`lastTouched(b)`. Identical ordering.

## 5. Docs (same change, per `src/memory/CLAUDE.md`)

- [x] 5.1 In `docs/architecture/memory.md`, replace the stale `scope: repo # org | domain | repo (org ⇒ always injected)` inline comment so it reflects bounded, relevance-selected org injection (the index remains the always-on catalogue).

## 6. Tests (`src/memory/__tests__/`)

- [x] 6.1 `entities.test.ts`: a single update that adds several distinct observations to a page already at the cap retains exactly `cap` and keeps the **newly-applied** ones (multi-observation batch over cap).
- [x] 6.2 `entities.test.ts`: same-day tie — a page full of today-dated observations plus one new today-dated observation retains the new one and drops the oldest-positioned same-dated entry.
- [x] 6.3 `entities.test.ts`: undated/legacy observations are dropped before dated ones when over cap.
- [x] 6.4 `entities.test.ts`: re-emitting an existing observation does not duplicate it and updates its `touched:` to the new date (re-affirmation), and the re-affirmed entry survives a subsequent over-cap write.
- [x] 6.5 `housekeeping.test.ts`: merging two near-cap duplicates yields a persisted canonical page bounded to the cap, with the drop logged (merge-path enforcement). Existing merge fixtures are well under the cap, so no read-back assertion was affected.
- [x] 6.6 `paths.test.ts`: `ARCHIE_MEMORY_ORG_INJECT_MAX=0` resolves to `0`; an invalid value (`8x`, `-1`) warns and falls back; `ARCHIE_MEMORY_ENTITY_OBS_CAP=0` warns and falls back to 30.
- [x] 6.7 `entities.test.ts`: two updates targeting the **same new entity** in one task (shared records array) resolve to a single page (locks in the records-array hoist — guards against a duplicate-create regression).

## 7. Verify

- [x] 7.1 `npm run typecheck` is clean.
- [x] 7.2 `npx vitest run src/memory/__tests__/` is green — 314 passed (includes the existing Phase-1 cap and selection tests; the two efficiency refactors changed no assertion).
- [x] 7.3 `ARCHIE_MEMORY_ORG_INJECT_MAX=0` → no full `scope: org` pages injected, all still listed in the index. Verified with a unit test (`entity-index.test.ts`: orgMax=0 → 0 selected, all 3 dropped, all 3 present with summaries in `renderIndex`) rather than a full app boot, since the behavior composes from `getOrgInjectMax()` (tested in `paths.test.ts`) and the already-tested `selectEntities` org budget.
