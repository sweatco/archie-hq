## Context

The memory layer (`src/memory/`) is a hardened v1: file-based Markdown, a Sonnet side-agent that extracts durable learnings on `task:completed`, and **push** injection of org + user + activity memory into every agent prompt at spawn (`context.ts` → `spawn.ts:252/381/479`). Three limits motivated this change:

- Organizational knowledge is one flat `org.md`; the recurring subjects of the work (services, systems, integrations, concepts) are buried in bullets, so the **whole file** is pushed regardless of relevance.
- "Related tasks" uses lexical token-overlap of one-line summaries (`lifecycle.ts:441`) — a weak proxy for shared subject matter.
- There is no canonical, accumulating page per subject.

We surveyed three file-based reference systems and deliberately mix-and-match rather than copy any one:

| System | What we take | What we reject |
|---|---|---|
| **Basic Memory** | page format: frontmatter + typed `[category]` observations + typed `relation [[Target]]` edges | free-form relation/category strings (synonym sprawl from an automated writer) |
| **cog** | `<!-- L0: … -->` cheap-scan line; per-file edit modes; housekeeping-rebuilt link index | stub→graduate split; hot/warm/glacier tiering (human-comfort features) |
| **LLM Wiki Agent** | graph/index is a *derived* artifact, never authoritative | a separate runtime graph build / `graph.html` |

The decisive constraint: **cog et al. assume a human writes and curates memory; Archie's writer is an automated side-agent over untrusted transcripts, and its reader is an agent at spawn.** So we keep the machine-parseable, constrainable ideas and drop the human-curation ones.

## Goals / Non-Goals

**Goals:**
- First-class entity pages for durable subjects, with a closed, sanitizable schema.
- Targeted, **push-based** retrieval: inject only the entities a task plausibly touches, with no agent-callable query tool.
- A real "related tasks" signal grounded in shared entities.
- Reuse every existing rail: `sanitize.ts` trust boundary, `annotations.ts` `touched:` staleness, the serialized housekeeping queue + consolidation side-agent, the `aliases:` pattern from user files.
- Stay file-based Markdown and fully ejectable.

**Non-Goals (this change):**
- An agent-callable `read_memory` / MCP query tool (true *pull*) — see Future Work.
- Embedding / vector selection — see Future Work.
- Full domain-**directory** splitting (e.g. `entities/engineering/…`) — domain is a frontmatter dimension, not a directory.
- Person entities — people stay in `users/<id>.md`, referenced by wikilink.

## Decisions

### D1. Entity page = Basic Memory model with **closed** vocabularies
Frontmatter (`entity`, `type`, `display_name`, `aliases`, `scope`, `repos`, `domain`, `status`) + `<!-- L0 -->` + `## Facts` (typed observations) + `## Relations` (typed edges over `[[wikilinks]]`).

- Observation categories: closed `[fact] [config] [decision] [caveat]`.
- Relation types: closed `depends_on integrates owned_by part_of touched_by related_to`.

*Why closed:* Basic Memory allows arbitrary relation/category strings — fine for a careful human, but an automated untrusted writer produces synonym sprawl (`uses`/`depends on`/`relies-on`) that makes the graph untraversable. Closed enums are checkable in `sanitize.ts` and keep queries deterministic. *Alternative rejected:* free-form edges; JSON sidecar (breaks the Markdown-only, human-diffable property).

### D2. One file per entity from the start (reject cog's stub→graduate)
cog keeps compact stubs in `entities.md` that graduate to thread files when heavy — because a human scans the registry file. Archie's registry is the **auto-generated index**, so a stub/graduate split only adds a "when to graduate" decision the extractor would have to make. *Decision:* `entities/<slug>.md` from first mention; the index is the registry.

### D3. No tiering (reject cog's hot/warm/glacier)
Tiering and "archive never delete" exist to reassure a human reader. Archie's push selection + recency ranking already answers "what's hot," and housekeeping's archive-not-delete (`status: archived`) covers the cold case. Importing three tiers would add machinery with no automated-system payoff.

### D4. The index is **derived, never authoritative** (LLM Wiki principle)
`entities/index.md` is rebuilt from the files by housekeeping. On conflict, files win; manual index edits may be overwritten. This keeps the source of truth in one place and the index cheap and disposable.

### D5. `scope: org | domain | repo` solves the orphan problem
Many important entities aren't repo-bound (people-by-reference, Stripe, postgres-prod, the release process). A pure repo filter would orphan them. `scope` gives cross-cutting entities a home (`org` = always selected) and lets selection be a union: `always(scope:org) ∪ match(repo) ∪ match(domain)`. *Alternative rejected:* repo-only tagging (orphans cross-cutting entities).

### D6. Retrieval = selective **push** (index-scoring + 1-hop graph), no pull tool
```
spawn ─▶ always inject <entity_index> (thin, all entities)
       ─▶ select full pages:
            score index rows against { repo/plugin, participating users, task title }
            ∪ all scope:org entities
            ∪ 1-hop expansion along [[wikilink]] relations from the selected set
          bound to ARCHIE_MEMORY_ENTITY_INJECT_MAX, inject top-N, LOG drops
       ─▶ agent runs (never asks for more)
```
Scoring needs **no embeddings**: the index carries `display_name` + `aliases` + one-line summary; a token/substring match against the spawn context is enough and degrades gracefully (no match → index + `scope:org` only). The 1-hop expansion is where the graph pays off (selecting `payment-service` pulls `postgres-prod` even if untagged). *Alternatives rejected/deferred:* push-everything (status quo, bloats); pull tool & embeddings (Future Work).

### D7. `touched_by [[taskId]]` auto-edge powers related-tasks
Every applied entity update auto-adds `touched_by [[taskId]]`. Related-task selection (`lifecycle.ts`) then prefers "tasks linked to the same entities," falling back to the existing lexical overlap. This replaces a weak signal with a strong one at near-zero cost.

### D8. People stay in `users/`; entities reference them
Reuse the hardened Slack-ID identity work. Entities link `owned_by [[U07ABC123]]`; we never create `entities/U07…md`. *Alternative rejected:* fold people into the entity graph (duplicates identity logic, re-opens the collision problem the hardening change just closed).

### D9. Slug-as-filename is the primary trust boundary
Entity slugs come from untrusted transcripts and become **paths**. `paths.ts`/`sanitize.ts` enforce `^[a-z0-9][a-z0-9-]{0,63}$`, reject separators / `.` segments / whitespace, and the entity count is soft-capped. A bad slug is dropped, never written. This is the sharpest new risk (a bad bullet corrupts a line; a bad slug can escape the directory).

### D10. Extraction: single-pass `entity_updates` for v1
The extractor gets the current index and emits `entity_updates` in the same `maxTurns: 1` call as `user_updates`. This keeps cost flat. If quality proves insufficient (entity identification + resolution is a lot to ask of one shot), a dedicated second entity pass is the fallback — see Open Questions. *(Superseded in part by D11: the `org_updates` channel this originally also emitted is removed.)*

### D11. Retire `org.md`; organizational knowledge becomes entities
With entities first-class, every org-level fact maps to a nameable subject and `scope: org` entities are always injected — so the flat `org.md`, the `org_updates` channel (D10), its `ARCHIE_MEMORY_ORG_CAP` soft cap, and its consolidation side-agent are redundant. We retire `org.md` rather than keep two competing homes for the same knowledge: the extractor prompt aimed `org_updates` and `scope: org` entities at an *identical* bar ("applies across the organization; durable; reusable"), forcing an arbitrary per-fact channel choice. Org-level facts become typed observations on `scope: org` entities; repo-specific facts become repo-scoped entities.

To preserve `org.md`'s one irreplaceable property — *always present, never selected away* — `scope: org` entities are **exempted from the `ARCHIE_MEMORY_ENTITY_INJECT_MAX` page bound** (as the thin index already is). This restores `org.md`'s always-on semantics, and with them its always-injected cost — now bounded by entity staleness-archival rather than a flat-file bullet cap.

*Alternative rejected:* keep `org.md` as a home for "subject-less" facts. Walking the extractor's own ORG examples, every one maps to a subject (Ruby/Postgres → `backend`, LaunchDarkly → an integration, fastlane-on-Tuesdays → a release-process concept), so the subject-less category is empty in practice — `org.md` would persist only as near-empty machinery with the layer's riskiest housekeeping (the consolidation side-agent + 40%-edit-distance trace-back validator) attached. *Timing:* decided after the entity layer was built but before it landed, so there is no accumulated dual-channel data to migrate — only the single seeded `org.md` bullet is backfilled. *Note:* the consolidation side-agent and trace-back validator are **not** deleted — `users/*.md` still uses them (see "User memory SHALL be housekept"); only the `'org'` target and `ARCHIE_MEMORY_ORG_CAP` go.

## Risks / Trade-offs

- **Slug → filesystem path (model output)** → hard slug validation + path-traversal rejection + entity soft cap (D9). Highest-severity risk.
- **Entity duplication** (`payments-api` vs `payment-service`) → supply the index to the extractor for alias resolution (D5/spec) + housekeeping merge-by-alias.
- **Extractor overload in one shot** → start single-pass (D10); measure; second pass as fallback. Open Question.
- **Selection misses a relevant entity** (weak repo/title signal) → `scope:org` always-on + 1-hop expansion + bounded top-N with **logged drops** so misses are observable, not silent.
- **Prompt bloat from over-selection** → page bound (`ARCHIE_MEMORY_ENTITY_INJECT_MAX`); index stays thin.
- **Index/file drift** → index is derived and rebuilt by housekeeping; files authoritative (D4).
- **Closed vocab too narrow** → bias toward dropping unknowns with a warning (observable), revisit the enum if drop-rate is high.

## Migration Plan

The entity layer is additive; `org.md` retirement is a small, in-place migration.

1. Bootstrap creates `workdir/memory/entities/` (no-op if `ARCHIE_MEMORY=false`).
2. New extractions populate entities; `users/`, `summaries/`, `recent-activity.md` are untouched and continue to work.
3. **Retire `org.md`:** backfill its single existing bullet (`Backend uses Ruby 3.4.9`) into a repo-scoped `backend` entity observation, then delete the file (n=1 — a one-off move, not a general pass). Remove the `org_updates` channel, `applyOrgUpdates`/`readOrg`/`writeOrg`, the `<organizational_knowledge>` block, `ARCHIE_MEMORY_ORG_CAP`, and the `'org'` consolidation target. Exempt `scope: org` entities from the inject bound.
4. Retrieval change is backward-compatible: with zero entities, no `<entity_index>`/`<entity>` blocks are emitted; organizational knowledge is simply absent until entities accrue.
5. **Rollback:** set `ARCHIE_MEMORY=false`, or delete `entities/` — the rest of the layer is unaffected; ejectability still holds (the whole `workdir/memory/` tree remains removable as a unit).
6. The canonical spec's Non-Goals / Glossary / Open-Questions prose (domain-split files; pull retrieval; `org.md` references) is updated at archive time, consistent with how `harden-memory-layer` handled spec prose.

## Future Work / Experiments to research

Captured deliberately so they're tried and measured, not assumed:

- **Hybrid pull (`read_memory` tool/MCP).** Add an agent-callable tool that fetches an entity page by slug from the index mid-task. **Experiment:** A/B selective-push (this change) vs push-index + pull-pages, measuring (a) entity selection precision/recall against a hand-labeled set, (b) prompt token cost, (c) task outcome quality. Gate: does pull recover the misses that push's bounded selection drops, and is the added latency/turn cost worth it? This is the explicit "thing to try" from the proposal.
- **Embedding / semantic selection.** Replace token-scoring of the index with embeddings when token-match recall plateaus. Prerequisite metric: measured miss-rate of the deterministic scorer.
- **Domain-directory splitting.** If `scope`/`domain` frontmatter selection proves insufficient at higher entity volume, split `entities/<domain>/`. Deferred until a volume threshold is hit.

## Open Questions

- **Single-pass vs two-pass extraction.** Does one `maxTurns: 1` call reliably identify *and* resolve entities, or do we need a dedicated entity pass? Resolve with an eval over real transcripts before committing.
- **Selection scoring weights.** Exact weighting of repo vs user vs title-token matches, and the value of `ARCHIE_MEMORY_ENTITY_INJECT_MAX`. Start conservative (e.g. 8), tune against logged drop rates.
- **`repo` entity type vs Archie's repo registry.** Should a `type: repo` entity duplicate what Archie already knows about repos, or only hold learned facts? Lean: only learned facts, linked to the registry.
- **Concept-entity proliferation.** Concepts (`type: concept`) are the fuzziest type and most prone to low-value entities; may need a higher extraction bar than services/systems.
