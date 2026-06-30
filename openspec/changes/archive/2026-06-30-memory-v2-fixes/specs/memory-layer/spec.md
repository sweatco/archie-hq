<!--
  Dependency: this delta composes on top of `memory-v2-phase1`, which ADDS the
  "Entity pages SHALL be bounded by a per-page observation cap" requirement.
  Archive memory-v2-phase1 before this change. Until then the requirement is not
  yet in openspec/specs/memory-layer/spec.md and strict validation will flag the
  MODIFIED block below.
-->

## MODIFIED Requirements

### Requirement: Entity pages SHALL be bounded by a per-page observation cap

The system SHALL bound the number of observations stored on any single entity page by a configurable soft cap (`ARCHIE_MEMORY_ENTITY_OBS_CAP`, default 30). The cap SHALL be enforced at the entity persistence boundary, so that **no write path** — including the housekeeping merge that folds a duplicate page into its canonical page — can persist a page whose observation count exceeds the cap. When a write would push a page's observation count above the cap, the system SHALL retain the newest-touched observations up to the cap and SHALL drop the oldest-touched surplus, logging the number dropped. Dropping SHALL be deterministic, ordered by the `touched:` annotation (newest retained, undated treated as oldest); when two observations share the same `touched:` date the system SHALL retain the **most-recently-applied** one, so observations written by the current update are never dropped in favor of equally-dated pre-existing ones. Capping SHALL NOT invoke a side-agent. Relations SHALL NOT be subject to this cap.

When an applied update re-emits an observation that already exists on the page (matched by category and normalized text), the system SHALL refresh that observation's `touched:` date to the update's date rather than adding a duplicate, so that a repeatedly re-affirmed fact is not aged out of the cap (or the staleness sweep).

**Rationale:** Entity observations are append-only and only deduplicated, never bounded per page. Without a per-page cap a single page grows without limit and re-inflates the injected system prompt even when the *number* of injected pages is bounded. Enforcing at the persistence boundary closes every write path at once. The cap mirrors the per-section bullet cap already enforced on user memory files.

#### Scenario: Over-cap page keeps the newest observations

- **WHEN** an entity page already holds `ARCHIE_MEMORY_ENTITY_OBS_CAP` observations
- **AND** an applied update adds a further distinct observation
- **THEN** the page retains exactly `ARCHIE_MEMORY_ENTITY_OBS_CAP` observations
- **AND** the retained observations are the newest by `touched:` date
- **AND** the number of dropped observations is logged

#### Scenario: Same-day tie retains the freshly-applied observation

- **WHEN** an entity page already holds `ARCHIE_MEMORY_ENTITY_OBS_CAP` observations all dated today
- **AND** an applied update adds a further distinct observation dated today
- **THEN** the newly-applied observation is among the retained `ARCHIE_MEMORY_ENTITY_OBS_CAP` observations
- **AND** the oldest-positioned same-dated observation is the one dropped

#### Scenario: Cap is enforced on the housekeeping merge path

- **WHEN** entity housekeeping merges a duplicate page into its canonical page
- **AND** the combined observation count exceeds `ARCHIE_MEMORY_ENTITY_OBS_CAP`
- **THEN** the persisted canonical page retains exactly `ARCHIE_MEMORY_ENTITY_OBS_CAP` observations
- **AND** the number of dropped observations is logged

#### Scenario: Re-affirming an observation refreshes its touched date

- **WHEN** an applied update emits an observation whose category and normalized text already exist on the page
- **THEN** no duplicate observation is added
- **AND** the existing observation's `touched:` date is updated to the update's date

#### Scenario: Relations are not affected by the observation cap

- **WHEN** an entity page has more relations than `ARCHIE_MEMORY_ENTITY_OBS_CAP`
- **AND** an entity update is applied to it
- **THEN** no relations are dropped by the observation cap
