# Memory v2 — Roadmap

> **Status:** Phases 1–2 shipped on `feature/memory-v2` ([PR #135](https://github.com/sweatco/archie-hq/pull/135)), including the pull tools, the two-tier eval harness, and the authz confidentiality layer. The rollout gates below are still open — injection and tools both default-off in prod. Later phases are proposals, not commitments — each needs its own proposal.
> **As-built:** [`docs/architecture/memory.md`](../architecture/memory.md) · **History (what shipped, per stage):** [`docs/plans/20260719-memory-v2.md`](../plans/20260719-memory-v2.md) · **External evidence:** 2026-07 verified research sweep (digest untracked alongside this file; conclusions baked into the shipped design)

## The plan in one view

Two tracks. The **capability track** grows what memory can do; the **measurement track** grows what we know about it — and every capability step past Phase 2 is gated by the measurement track's numbers, because the 2026-07 research sweep's clearest finding is that nobody's published numbers transfer (vendor memory systems underperform their own backbone's long-context baseline on third-party benchmarks, and there is **no** published playbook for QA-ing agent memory on prod data — ground truth has to be home-grown).

| | Capability track | Measurement track |
|---|---|---|
| **Phase 1** (shipped) | push injection, bounded + relevance-gated | selection sensor |
| **Phase 2** (shipped; rollout gates open) | pull: read tools for all agents; authz confidentiality layer; injection enablement (gated) | snapshots + pull sensor + eval harness (mechanical **and functional** — real impl scored on a benchmark + prod-derived question set) + enablement gate + the prod-QA loop |
| **Phase 3** | write-path rewrite: dedupe + forgetting/modifying | selective-forgetting eval slice gates the forget capability |
| **Phase 4** (only if evidence demands) | selection embeddings as hybrid signal | golden regression set is the bar to beat |
| **Phase 5** | — | judgment eval: does memory earn its tokens |

## Phase 1 — Push injection, safely built (shipped)

Compressed history — details live in the archived changes and `docs/architecture/memory.md`:

- Org injection bounded and relevance-gated (budgets are ceilings; zero-signal pages stay index-only), extraction unbiased from `org`, per-page observation cap, `touched_by` render cap, always-injected thin entity index as the recall net, and the permanent **selection sensor** (per-spawn JSON record of what was injected and why, in `memory/tasks/<taskId>/telemetry.jsonl`).
- Injection is bounded and instrumented but still default-off in prod. Turning it on is Phase 2's enablement gate — the evidence (worst-case token bound, store review, a functional selection-quality check) comes from the eval Phase 2 builds, so enablement rides with it rather than ahead of it.

## Phase 2 — Pull + measure (shipped; rollout gates open)

Shipped on the same branch as Phase 1 — everything the current state can honestly support:

**Runtime tools (appropriate to the current state — read-only).** `search_memory`, `read_entity`, `read_task_summary`, `grep_task_log` for all agent tracks behind `ARCHIE_MEMORY_TOOLS` (default off, independent of the injection flag). Writes stay funneled through the extractor, and reads are governed by the authz confidentiality layer (extraction gate, `access: org`-or-self episodic reads, authorship-scoped user memory, ext-shared/unknown lockdown — see `docs/architecture/memory.md` § Confidentiality & Authorization). Search is lexical with the selector's own tokenization — pull-vs-push deltas then indict budgets, not scorer skew. File/grep read granularity is where the field converged: Anthropic's GA memory tool is six file operations with no search command, Letta v2 replaced embedding archival search with `open_file`/`grep_file`, and three independent 2026 studies have grep/file agents matching or beating dense retrieval (evidence: the research digest; decision record in `docs/plans/20260719-memory-v2.md`).

**Evals (start now, accumulate forever).** Two permanent sensors + one harness:

- Pull sensor: every read-tool call logged as a `kind:"pull"` line next to the selection records. Pull calls are revealed ground truth — a pulled-but-not-injected page is a measured push-recall miss; a zero-result search is a measured store gap.
- `npm run memory:eval`, two tiers. **Mechanical** (no model calls, every snapshot): store health with a versioned near-duplicate rate, selection/pull telemetry aggregation, and a golden-set selection-regression benchmark (recorded contexts replayed through the production `selectEntities`). **Functional** (the tier the mechanical-only plan was missing — it ships now, not in Phase 5): runs the *real* implementation as system-under-test — ingest transcripts through extraction, surface context through production `selectEntities` + injection render (+ optionally pull) — and scores what it surfaces on the LongMemEval/MemoryAgentBench pattern: surfaced-context recall against evidence labels, plus answer correctness by a *fixed reader* with an *Oracle* upper-bound arm. Question sets: a portable public benchmark (regression anchor) and a prod-transcript-synthesized set (the "over my own data" half). Any judge is governed — validated by Cohen's κ + position bias <0.10, and a *different model family than the extractor* (writer/same-family-judge preference leakage ~28.7%). Rationale it can't wait: mechanical store-health does **not** predict functional quality — under a real harness, commercial memory products scored *below trivial BM25* (MemoryAgentBench). Goldens/questions/reports are prod-derived and stay out of git.

**Enablement gate + flip.** Turning injection on rides with this change, gated on evidence the eval produces: a worst-case injected-token bound computed from the real store, a `--report` store-review reading list (entities + every injected non-entity block, flagged for suspicious content) for the ~1–2h human content review, and a functional-eval sanity pass on the benchmark. Snapshots come from `scripts/snapshot-memory.sh` (laptop launchd). With the bound acceptable and the store clean, flip `ARCHIE_MEMORY_INJECT=true` in its own PR carrying that evidence; rollback is the flag; budgets tune later from live sensor data.

**QA on prod actual data (the recurring loop).** Pull snapshot (`pull-remote-data.sh -m`, scheduled) → `memory:eval` → read the report → act (tune budget flags, clean store pages, harvest fresh goldens). The human store review slots into the same loop; live E2E memory scenarios via the `archie-e2e` harness are the rollout QA for this change itself. The judge audit and on/off interleaving wait for Phase 5.

**Docs.** The memory documentation is consolidated in markdown: the as-built behavior contract is `docs/architecture/memory.md`, the shipped-stage history is `docs/plans/20260719-memory-v2.md` (the per-stage openspec spec/proposal files were retired in favor of these two).

**Rollout checklist (human, after merge):**

1. **Enablement gate → injection flip:** install `snapshot-memory.sh` on the laptop launchd and land one snapshot; run `memory:eval --report` for the worst-case token bound + store-review reading list; do the ~1–2h human store review and clean flagged pages on the prod store (only while the app is stopped or verifiably idle — out-of-band edits bypass the serialized write queue; rebuild the index after manual edits); run the functional eval on the benchmark as a selection-quality sanity check; if all acceptable, flip `ARCHIE_MEMORY_INJECT=true` in its own PR carrying that evidence. Rollback = flag off.
2. **Tools flip:** `ARCHIE_MEMORY_TOOLS=true` with or after the injection flip (without the injected `<entity_index>` agents have no catalogue of what's pullable, and early pull telemetry would misread as "no demand"), in its own PR carrying the first full `memory:eval` report; optionally verify on a booted branch instance first via the `archie-e2e` harness (seed store → task → assert pull records). The authz layer shipping first was the hard precondition — done.
3. **Post-flip monitoring:** watch `deniedRate`/`denyReasons`, `extraction-skip`, `extraction-prefs-only`, and `user-update-dropped` counts in `memory:eval` — high denial rates mean agents probe the confidentiality boundary; skip/prefs-only counts quantify the policy's memory loss. The store review should also eyeball entity pages for pre-policy private-derived facts (retroactive cleanup stays postponed).
4. **After 2–3 weeks of records:** run `memory:eval` on a fresh snapshot, review pull rates + the store-gap list, harvest the first golden set from live selection records, and synthesize the first prod question set for the functional eval.

## Phase 3 — Rewrite the write path: dedupe + forgetting/modifying (one phase, one mechanism)

Today the write path only appends: `resolveEntity` is exact slug/alias match, housekeeping merges only alias-linked duplicates, and forgetting is a 180-day date sweep. This phase replaces append-only with classify-then-write — dedupe and forgetting are the same mechanism, so they ship as one phase, not two:

- **ADD/UPDATE/DELETE/NOOP classifier** in the extraction funnel, on the mem0 pattern (per candidate fact, retrieve ~10 most-similar existing memories, LLM picks the operation; arXiv 2504.19413 Algorithm 1). At ~300 pages the candidate step can be token-overlap similarity — no embedding dependency. UPDATE/NOOP is the dedupe; DELETE-on-contradiction is the forgetting.
- **`remember` / `forget` agent tools** behind the same single write funnel — agents propose, the funnel classifies and sanitizes; no second writer.
- **Forgetting ships gated:** every evaluated memory system scores ≤7% on multi-hop selective forgetting (MemoryAgentBench, ICLR 2026; ceiling confirmed across 22 systems, arXiv 2606.01435). So: deterministic freshness/recency rules wherever LLM judgment isn't forced, and DELETE/invalidation enabled only once a selective-forgetting slice in the Phase 2 harness shows it revising the right facts. Contradiction-based invalidation (Zep/Graphiti-style validity intervals) remains the aspiration — but no primary claim about its real performance survived verification, so it's earn-in, not default.
- **Buy-vs-build spike here, not earlier:** the SDK-native memory tool (GA `memory_20250818` — six file-CRUD commands, no search; context editing separately still beta) is a write-capable loop, so this phase is its real comparison target. Judge the spike on the Phase 2 harness (tokens, turns, regression-set recall), never on vendor numbers.
- Success metric: Phase 2's near-duplicate rate trending down across snapshots; store size stabilizing under `ENTITY_CAP` with teeth.
- Kill or repurpose observation categories while in here (consumed only as a render prefix and part of the dedupe key).

## Phase 4 — Selection embeddings (only if the numbers demand it)

Not scheduled — conditionally triggered. Enter only when Phase 2 telemetry shows push precision/recall is still the bottleneck *after* pull lands (frequent budget-drops of pages agents then pull, misses lexical scoring can't close). Shape when triggered:

- File-based sidecar (`entities/index.embeddings.json`, in-process cosine — no DB, ejectability intact), also upgrading Phase 3's dedupe candidate recall.
- Embeddings enter as **one fused signal in a hybrid ranker** alongside the lexical score — the production pattern even at embedding-centric vendors (mem0 v3 fuses vector + BM25 + entity matching; reranking opt-in behind a latency warning) — never a wholesale scorer swap.
- Gate: any new selector must beat the token-overlap one on the golden regression set before it ships.

## Phase 5 — The judgment eval (on accumulated real data)

Months of sensor data answer "does memory earn its tokens." The mechanical *and* functional harness both exist since Phase 2 (functional = answering a labeled question set); what stays for here is the *live-task outcome* judgment — a different question ("did memory change how real completed tasks went") that needs accumulated pull/selection records, not a question set:

- Push value: injected-but-never-referenced pages = measured over-injection; reference rates from knowledge logs.
- Push recall, revealed: pages pulled that push didn't inject; user corrections repeating facts already stored.
- Store health trend: growth, duplicate rate (Phase 3's metric), injection concentration / page turnover — recency ossification is only observable here.
- Sampled *live-task* outcome audit: LLM judge over ~20–30 real completed tasks — did memory help, mislead, or sit unused; every "misled" root-caused. (Distinct from Phase 2's functional eval, which scores answering a question set — this scores real task trajectories.)
- Output: the health report grows a judgment section; decisions on index tiering and any Phase 4 trigger come from here.

> The 2026-05 eval harness (pre-entity `org_updates` target, no-ship defects) was dropped 2026-07-08; its accumulation-test idea lives on as the duplicate-rate trend. A pre-enablement replay eval was likewise rejected: injection-off baseline means no incumbent recall to protect, and proxy labels can't gate anything.

## Open questions

- Who writes memory: specialists read (Phase 2); Phase 3 lets agents *propose* writes through the funnel — is PM-proposed enough, or do specialists propose too?
- Index tiering: the always-injected index (~9K tokens at the 300-entity cap) becomes the dominant fixed cost once injection is on; Phase 5's reference-rate data decides.
- Outcome attribution: sampled judge audit vs. on/off interleaving — no verified published method for either on prod agent-memory; first-principles territory.
- Privacy for prod-derived eval data: snapshots/goldens/reports stay laptop-local and out of git (they embed task titles and Slack IDs); no published pattern survived verification — revisit if eval artifacts ever need sharing or CI.
