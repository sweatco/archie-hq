# Memory v2 — Research & Decision Doc

> **Status:** Living decision doc. Phase 1 ("stop the bleed") + hardening fixes **shipped 2026-06-30** (`memory-v2-phase1`, `memory-v2-fixes`); injection-bounds follow-ups **shipped 2026-07-02** (`memory-v2-injection-bounds`). Remaining phases **re-cut 2026-07-02** after a critical review — see §9.
> **Date:** 2026-06-29 · updated 2026-07-02 · **Branch:** `feature/memory-v2`
> **Purpose:** Diagnose the problems with the current memory layer, survey the state of the art, and lay out the concrete branches we can take — **adopt Claude's native memory tool** vs. **build it ourselves** vs. a **hybrid** — with enough detail to execute any of them.
> **Companion reading:** [`docs/architecture/memory.md`](../architecture/memory.md) (as-built design), [`src/memory/CLAUDE.md`](../../src/memory/CLAUDE.md).

---

## 0. TL;DR

- **The 381K is not organic growth.** It's four compounding amplifiers stacked on one old design choice: `scope:org` entities are injected **in full, uncapped, on every agent, every turn**. Extraction is even *biased* toward that uncapped bucket.
- **The core reframe:** we have **two different memories wearing one coat**. Org knowledge is a *wiki* (large, reference-like) being treated like a *user-preference preamble* (paste it all in). Inject the table of contents; let agents read articles on demand.
- **Egor's Slack proposal is the right instinct** (thin index + pull tools), under-specified in the important places (recall risk, PM-only relay, write path untouched).
- **The field already solved this**: in-context core + out-of-context archival with tool-based paging (MemGPT/Letta), LLM-driven ADD/UPDATE/DELETE/NOOP with semantic dedup (mem0), file CRUD + context editing native to our SDK (Anthropic memory tool).
- **Two high-leverage facts:** (1) embeddings **don't require a database** — a sidecar JSON of ~300 vectors with in-process cosine keeps the no-DB invariant; (2) we may **already own the runtime primitive** — the Claude Agent SDK ships a memory tool + context editing.
- **The fork:** **Branch A** (adopt native memory tool), **Branch B** (build ourselves), **Branch C** (hybrid — recommended). **Phase 1 ("stop the bleed") was identical under all three** — ✅ shipped; the rest is decided on evidence via the eval gate (§9).

---

## 1. Problem statement *(historical — as measured 2026-06-29, before Phase 1)*

The measured system prompt was **~424K tokens on every agent, every turn**, apportioned (from production telemetry):

| Component | Tokens | What |
|---|---:|---|
| 156 `scope:org` entity pages | ~381K | 1.38 MB of org memory, injected **uncapped** |
| entity index + 8 non-org pages + user prefs + recent-activity | ~43K | the capped / bounded part |
| **= system prompt** | **~424K** | on **every** agent, **every** turn |

Five issues raised:

1. **Entities eat ~381K of context** — huge. *(✅ fixed by Phase 1 + follow-ups)*
2. **No runtime memory tool** for (a) searching knowledge via an embedded index, (b) memorizing / rewriting / forgetting mid-task. *(open — Phase 2/4)*
3. **No built-in dedupe** for entities. *(open — Phase 3)*
4. **Tags like `[caveat]`, `[config]` seem useless.** *(open — Phase 4)*
5. **Critically evaluate Egor's Slack proposal** (see §5).

---

## 2. Diagnosis — four amplifiers on one design choice *(historical; read-path amplifiers fixed by Phase 1 + follow-ups)*

The 381K was a feedback loop where **every layer pushed the same direction**. All four were code-confirmed at the time (see Appendix A for the current state).

```
   WRITE PATH                                  READ PATH
   ─────────                                   ─────────
 extractor prompt:                          selectEntities():
 "Default to org for          ─┐            scope:org → SCORE_ORG = 1000
  anything not clearly         │            scope:org → EXEMPT from
  repo-specific"               ├──────▶                  ENTITY_INJECT_MAX (8)
 pickScope(): no repo given    │                ↓
            → 'org'           ─┘            ALL 156 org pages injected, FULL TEXT
                                                ↓
 applyEntityUpdate():                       each page has NO per-page cap
 observations only APPENDED   ────────▶     (contrast: users have USER_CAP=100,
 (dedup only, no cap)                        SECTION_CAP=30 — entities have none)
                                                ↓
 housekeeping archives a page               pages only ever grow; archived only
 only when ALL obs are stale  ────────▶     when 100% stale → effectively never
                                                ↓
                                    ≈ 381K in EVERY agent's system prompt, EVERY turn
```

| # | Amplifier | Mechanism (2026-06-29) | Status |
|---|---|---|---|
| 1 | **Extraction is biased to `org`** | The extractor prompt literally said "Default to `org` for anything not clearly repo-specific." | ✅ fixed (narrowest-applicable scope; `org` only as structural fallback) |
| 2 | **`pickScope` defaults to `org`** | If the model omitted scope and gave no repos → `org`. | ✅ defanged (structural last resort only; injection bound is the real protection) |
| 3 | **Org injection uncapped by design** | `selectEntities` gave org `SCORE_ORG=1000` **and** exempted it from `ENTITY_INJECT_MAX`. | ✅ fixed (two budgets, both **ceilings**; signal-gated candidacy; `SCORE_ORG` removed) |
| 4 | **Pages never shrink** | Observations append-only with no per-page cap; housekeeping archives only when **all** obs stale. | ✅ partially fixed (`ENTITY_OBS_CAP` at the `writeEntity` boundary; `touched_by` render cap); archive policy still all-stale-only |

> **The escape hatch was deliberate.** `scope:org` pages inherited the "always present" role of the old monolithic `org.md`. Fine at ~10 org pages; a fire at 156.

---

## 3. Reframe — two memories in one coat

| | **Org knowledge** (`scope:org` entities) | **User prefs + activity** |
|---|---|---|
| Size | Large, unbounded (156 pages → 381K) | Small, **capped** (100 bullets/user, 50 activity rows) |
| Nature | Reference material — a **wiki** | Per-person context |
| Right pattern | **Index + retrieve on demand** | Fine to inject in full |
| Current treatment | Index + bounded relevance-gated pages ✅ | Injected in full ✅ |

**The whole bug in one sentence:** org knowledge was being treated like a user-preference preamble when it's actually a wiki. You don't paste the whole wiki into every page header — you inject the table of contents and let readers open articles on demand. Everything in v2 follows from that.

---

## 4. Issue → root cause map

| # | Issue | Root cause (code-confirmed 2026-06-29) | Verdict |
|---|---|---|---|
| 1 | Entities ≈ 381K | `selectEntities` injected all `scope:org` in full, exempt from cap; pages uncapped; org-biased extraction | Real, structural — **✅ fixed** |
| 2 | No runtime memory tool | Zero memory tools in any of the 4 MCP servers (`tools.ts`); push-only at spawn; batch extraction only at `task:completed` | Real — by design (doc lists it as deferred "Future Enhancement") |
| 3 | No dedupe | `resolveEntity` = **exact** slug/alias match only; housekeeping merges **only** via explicit alias links; no semantic match. `payment-service` vs `payments-service` → two pages forever | Real — **open, Phase 3** |
| 4 | Tags `[caveat]`/`[config]` useless | Observation `category` is **read nowhere** — only a render prefix + part of the dedup key (which actually *worsens* dedup: same text + different category = not deduped). Pure cosmetic, mildly net-negative. | **Confirmed for observation categories** — open, Phase 4 |
| 4b | (nuance) | **Relation** types are **not** useless: `touched_by` → related-tasks, `owned_by` → +200 selection score, all types → 1-hop expansion. Keep these. | Keep |

**Principle for #4:** *structure that nothing downstream consumes is dead weight.* Either wire a field into retrieval / ranking / forgetting, or delete it. A `[caveat]` label that no code branches on costs tokens and buys nothing.

---

## 5. Egor's Slack proposal — summary & critique

**Source:** DM thread, 2026-06-26 (Egor Khmelev ↔ Igor). It's thinking-out-loud, not a written spec. Paraphrased:

1. Inject only a **thin memory index** — ~50 past-task one-liners + the entity index + people — **not** full entity pages.
2. Give the agent a small **pull toolset**: read entity / list entities; read a task's extended summary; read a task's detailed log (line-by-line or grep); read task meta to find which Slack threads to go read.
3. "Super simple and fast, quick effect **without polluting context**." Smart injection comes *later*.
4. **Concentrate memory on the PM**: PM gets the index + talks to users, fetches what it needs, and **logs the relevant bits into `knowledge.log`** so specialists don't touch memory at all. (Wobble: "…although maybe something engineering-relevant. idk. need to think.")
5. Igor: maybe leave "should I inject from memory?" entirely to PM discretion. "Want a dumb system that actually works."

### What's right ✅

- **The core pivot is correct and matches the whole field** — thin index + pull on demand is exactly issue #1's cure.
- **It's genuinely low-effort.** The substrate already exists: `summaries/<taskId>.md`, `recent-activity.md` (the 50 one-liners), `entities/index.md`, per-task `knowledge.log`. The "pull toolset" is mostly *exposing existing files as read tools* + trimming injection. That's why it feels cheap. It is.
- **Collect-only mode is already the default** (`ARCHIE_MEMORY_INJECT=false`, and Igor disabled injection in prod), so the read path can be redesigned without breaking a live one.

### What to push back on ⚠️

- **"Pull recovers what push drops" is an assumption, not a fact** — the architecture doc itself flags it. Pull only helps *if the agent knows to ask*. Push puts the wrong things in context; pull risks the right things *never being fetched*. Needs a selection precision/recall eval, not a leap of faith. *(→ promoted to the Phase 1.5 eval gate.)*
- **PM-centric memory + relay-via-`knowledge.log` is the weakest part** — it's a telephone game. PM is a *coordinator*, not a domain expert; it compresses memory → `knowledge.log` → specialist re-reads. Two lossy hops, and the agent that actually knows what it needs (the specialist) is cut off. Cleaner cut: **reading is cheap & safe → give specialists read/pull tools too; writing/forgetting is where you want a single funnel → keep that on PM/extractor.** Don't conflate "who may read" with "who may write."
- **It only fixes the read path.** Silent on #3 (dedupe) and the write path. A pull reader still sits on a store that mints near-duplicates and never forgets. Necessary, not sufficient.
- **The index itself becomes the next ceiling.** "Always inject the full index" at `ENTITY_CAP=300` is ~9K tokens — fine now, but it's the same uncapped-growth pattern one level up. Index needs scoping/tiering eventually.
- **Latency / turn cost.** Every pull is a tool round-trip → more turns, more latency. The field's answer (Letta) is *sleep-time compute* — async memory work off the hot path. Don't trade token-bloat for latency-bloat.

---

## 6. State of the art (file-based / agent memory)

| System | Core idea | What it fixes for us |
|---|---|---|
| **Anthropic memory tool + context editing** (native to our SDK; beta header `context-management-2025-06-27`) | File-based CRUD over a `/memories` dir the model drives itself; context editing auto-clears stale tool results. Reports **84% token cut** on a 100-turn search eval, **+39%** quality. | #1 + #2 in one primitive — and it's *buy not build*. |
| **MemGPT / Letta** | OS metaphor: small **core memory** in-context (RAM) + **archival** out-of-context (disk); agent self-edits via tools; **sleep-time compute** does memory work async. | The thin-index-vs-pull split done right; the async-write answer to the latency objection. |
| **mem0** | Extract → **semantic-similarity match** vs existing → LLM picks **ADD / UPDATE / DELETE / NOOP**. | Exactly our missing write path: #3 dedupe + runtime forget/rewrite. |
| **Zep / Graphiti** | Bi-temporal knowledge graph; new facts **invalidate** old edges (validity intervals) rather than date-based staleness. | A precise replacement for "drop after 180 days" — facts expire when *contradicted*, not when *old*. |
| **Generative Agents** | Retrieval = **recency × importance × relevance**; periodic reflection. | A real use for a salience score — the slot `[caveat]` is wasting. |
| **Basic Memory / Obsidian** | Wikilink markdown knowledge graph. | We're already *here* (`[[wikilinks]]`, derived index). Lean in, don't rebuild. |

### Two insights that change the design space

- **(a) Embeddings don't require a database.** The "stays ejectable, no DB" invariant is the usual objection to semantic search — but for ~300 entities, a sidecar `entities/index.embeddings.json` (~300 × 1536 floats ≈ 2 MB) with brute-force in-process cosine is instant and stays a deletable file. That one addition unlocks the "embedded knowledge index" (#2), **semantic dedupe** (#3, fixes `resolveEntity`'s exact-match blindness), **and** better selection (#1).
- **(b) We may already own the runtime primitive.** Archie runs on the Claude Agent SDK; the **native memory tool + context editing** could *be* Egor's "simple toolset" — without writing it. This is the heart of Branch A below.

---

## 7. The branches

> Each branch is written so it can be picked up and executed independently. Phase 1 (§9) was shared by all three and has shipped.

### Branch A — Adopt Claude's native memory tool + context editing

**What it is.** Turn on the SDK's `memory` tool (file-based create/read/update/delete over a memory directory we host) + context editing (auto-clears stale tool results mid-conversation). The model drives its own memory loop.

**Fixes:** #1 (context — large reported reductions), #2 (runtime read **and** write/forget — it's native CRUD), partial #4 (context editing reduces the cost of verbose memory).

**How it slots into Archie.** Our extraction side-agent keeps producing the entity files; the native memory tool gives running agents CRUD over `workdir/memory/`; context editing handles turn-level bloat. Archie's value-add (structured extraction + entity graph) stays as the substrate underneath generic file CRUD.

**Pros**
- Far less code; Anthropic maintains it; battle-tested loop.
- Context editing is a near-free token win even if we keep our own retrieval.
- Aligns with the SDK direction we're already on.

**Cons / risks**
- Generic **file CRUD** — no entity-schema/graph awareness, no semantic dedup out of the box. #3 and the entity model still need us.
- **Beta** (header-gated `context-management-2025-06-27`) — surface may change; couples ejectability to a beta API.
- We host the storage backend — still our `workdir/memory/`, our concurrency rules.
- The "model drives memory" agentic loop adds **turns / latency / cost** vs. a single push.
- **Multi-agent fit unknown:** per-agent memory dir vs. shared? How does it interact with our serialized extraction queue and the PM↔specialist split?

**Open questions**
- Does it compose with our entity-graph substrate, or does it want flat files?
- Per-agent vs. shared memory directory under our spawn model?
- How does runtime CRUD reconcile with the post-task extraction side-agent (two writers)?
- Token/latency cost of the agentic loop vs. today's push.

**Execution checklist**
- [ ] Spike behind a flag (e.g. `ARCHIE_MEMORY_NATIVE_TOOL`): wire the SDK memory tool to `workdir/memory/` for the PM track only.
- [ ] Enable context editing on agent `query()` calls; measure token reduction on a replayed task.
- [ ] Decide storage shape (keep entity markdown vs. tool-native files).
- [ ] Resolve the two-writers problem (runtime CRUD + extraction queue): single funnel or merge policy.
- [ ] Measure: prompt tokens, turns/latency, recall on a held-out task set vs. current push.

---

### Branch B — Build it ourselves (extend the existing layer)

**What it is.** Keep the bespoke file-based entity-graph and fill the gaps ourselves: thin-index injection + pull tools, a file-based embedding index, semantic dedup, an ADD/UPDATE/DELETE/NOOP write path, per-page caps, and kill/repurpose the cosmetic tags.

**Fixes:** all five, fully under our control.

**Pros**
- Full control; preserves the entity-graph value-add and the **ejectability invariant** (no DB, no beta dep).
- Retrieval tuned to our domain; no external API surface to track.
- Maps cleanly onto Egor's "dumb system that works" if scoped to phase 1.

**Cons / risks**
- More code to write and maintain; we reinvent pieces Anthropic ships.
- Embeddings need an embedding call (a dependency + cost) — though storage stays file-based.
- Semantic dedup = extra LLM calls on the write path.
- Larger test surface.

**Open questions**
- Embedding model/provider (Anthropic? local?) and how it fits the ejection story.
- Sidecar vector format (`index.embeddings.json` vs. per-page frontmatter).
- How aggressive the forget policy; contradiction-based vs. date-based.
- Read-tool surface and which agents get which tools.

**Execution checklist**
- [x] **Selection:** remove the `scope:org` inject-all exemption; bound + relevance-gate injection (`entity-index.ts`). *(Phase 1 + follow-ups)*
- [x] **Extraction:** stop defaulting to `org` (`prompts/memory-extractor.md`, `pickScope`). *(Phase 1)*
- [x] **Bounds:** per-page observation cap at the persistence boundary; `touched_by` render cap. *(Phase 1 + fixes + follow-ups)*
- [ ] **Embeddings:** add `entities/index.embeddings.json`; in-process cosine for select + dedup.
- [ ] **Dedup:** semantic `resolveEntity`; LLM ADD/UPDATE/DELETE/NOOP on write (`entities.ts`, `lifecycle.ts`).
- [ ] **Forgetting:** contradiction-based invalidation (`housekeeping.ts`).
- [ ] **Read tools:** `search_memory(query)`, `read_entity(slug)`, `read_task_summary(id)`, `grep_task_log(id)` as MCP tools (`tools.ts`).
- [ ] **Write tools (runtime):** `remember` / `forget` behind a single write funnel.
- [ ] **Tags:** delete observation `category` *or* repurpose the slot as a numeric **salience** consumed by ranking + forgetting.

---

### Branch C — Hybrid (recommended)

**Build the substrate, borrow the loop.**

- **Phase 1 was branch-agnostic** — ✅ shipped: unbiased extraction, bounded + relevance-gated org injection, thin index as safety net, per-page caps.
- **Spike Branch A early** (now Phase 2) for the runtime read/write loop and decide A vs. B on evidence (tokens, latency, recall, maintenance) — before investing in selection embeddings.
- **Keep the entity-graph + extraction** as our differentiated substrate either way; semantic dedup (mem0-style) and the embedding index are ours to own (Anthropic's tool won't do them).

**Why recommended:** it de-risked the urgent fire (phase 1) without prematurely committing to A or B, and keeps the parts that are genuinely our value-add.

---

## 8. Decision matrices

### Per-issue coverage

| Issue | Branch A (native tool) | Branch B (build) | Branch C (hybrid) |
|---|---|---|---|
| #1 context 381K | ✅ (context editing + CRUD loop) | ✅ (thin index + top-k) | ✅ (phase 1 fixed it) |
| #2 runtime read | ✅ native | ✅ our read tools | ✅ (native or ours) |
| #2 runtime write/forget | ✅ native CRUD | ✅ remember/forget tools | ✅ |
| #2 embedded search | ⚠️ not built-in | ✅ file embeddings | ✅ ours |
| #3 dedupe | ❌ still ours to build | ✅ semantic + ADD/UPDATE/DELETE | ✅ ours |
| #4 tags | ⚠️ indirect (context editing) | ✅ delete/repurpose | ✅ |

### Branch comparison

| Dimension | A — native tool | B — build | C — hybrid |
|---|---|---|---|
| Effort | Low–medium | High | Medium (phased) |
| Fixes all 5 alone | No (#3 gap) | Yes | Yes |
| Risk | Beta dependency, multi-agent fit | More code/tests | Lowest (incremental) |
| Ejectability | ⚠️ couples to beta API | ✅ preserved | ✅ preserved |
| Latency | ⚠️ agentic loop | tunable | tunable |
| Maintenance | Anthropic carries loop | we carry all | split |
| Time to relief | Medium (spike first) | Slow | **Fast (phase 1 — shipped)** |

---

## 9. Roadmap (re-cut 2026-07-02)

> Re-cut after a critical review of the shipped Phase 1: the eval harness is promoted from "open question" to the gate for enabling injection in prod; the buy-vs-build spike and read tools move **ahead of** embeddings (cheaper, and they de-risk the recall regression directly); semantic dedupe is split out from selection embeddings (write-path hygiene shouldn't wait on a read-path decision).

```
Phase 1 — STOP THE BLEED   ✅ shipped (memory-v2-phase1 + memory-v2-fixes + memory-v2-injection-bounds)
  • Org injection bounded (ARCHIE_MEMORY_ORG_INJECT_MAX) — and a CEILING, not a
    target: candidacy requires a relevance signal; zero-signal pages stay index-only
  • Thin entity index always injected = recall safety net
  • Extraction unbias (prompt + pickScope no longer default to org)
  • Per-page observation cap at the writeEntity persistence boundary
  • touched_by render cap (disk keeps full history)
  • (native context editing moved out of Phase 1 → part of the Branch A spike)
        │
        ▼
Phase 1.5 — EVAL GATE   (precondition for ARCHIE_MEMORY_INJECT=true in prod)
  • Selection precision/recall on replayed tasks (resurrect the stashed
    memory-eval tooling: scripts/memory-eval.ts, src/memory/eval/)
  • Injection-diversity / page-turnover metric — watch the recency feedback loop
    (re-stamp on re-affirmation + recency tiebreak can ossify the same pages)
  • Decides: ORG_INJECT_MAX default, relevance floor vs. recency-floor fallback
        │
        ▼
Phase 2 — RUNTIME READ + BUY-VS-BUILD SPIKE   (was Phase 3)
  • Spike Branch A (native memory tool + context editing) behind a flag — cheap,
    and may collapse the later phases; decide A vs. B on eval evidence
  • Read tools: search_memory / read_entity / read_task_summary / grep_task_log
  • reading: all agents · writing: stays funneled through the extractor
        │
        ▼
Phase 3 — SEMANTIC DEDUPE   (was half of old Phase 2; can start alongside Phase 2)
  • Semantic resolveEntity + ADD/UPDATE/DELETE/NOOP write path (mem0-style)
  • The only mechanism that actually shrinks the store — ENTITY_CAP has no teeth
    without it (housekeeping merges only alias-linked duplicates)
        │
        ▼
Phase 4 — SELECTION EMBEDDINGS + RUNTIME WRITE/FORGET
  • File-based embedding index (entities/index.embeddings.json) for selection —
    only if the eval shows push precision is still the bottleneck after pull lands
  • remember / forget tools; contradiction-based invalidation
  • kill or repurpose observation categories (salience) — note: categories are
    part of the dedupe/re-stamp key and a closed-vocabulary spec requirement
```

Egor's proposal ≈ **Phase 1 + Phase 2 (read tools)**. The full ask (#2 runtime write, #3 dedupe) needs **Phases 3–4**.

---

## 10. Open questions / threads to pull

- **Ambition fork:** "dumb system that works" (thin index + read tools, ship this week) vs. the full self-editing/semantic store (fixes all 5, weeks). Which are we signing up for? *Lean: Phase 1 shipped regardless; decide the rest on evidence.*
- **Buy vs build:** spike the native Claude memory tool before hand-rolling pull tools — it may collapse Phases 2–4. *(Now scheduled as the Phase 2 spike.)*
- **Who writes memory:** specialists *read* but only extractor/PM *write* — agree, or keep Egor's PM-only-touches-memory line?
- **Forgetting model:** date-based staleness (today) vs. contradiction-based invalidation (Zep).
- **Eval harness:** *promoted to Phase 1.5 — the gate for enabling injection in prod.* Without it, "pull recovers the drops" stays faith-based.
- **Index scaling:** does the always-injected index itself need scoping/tiering as entity count climbs toward the 300 cap?
- **Always-on org allowlist:** truly ubiquitous facts (e.g. "deploys ship Tuesdays") will never token-match; is the index `L0` line enough, or do we need a tiny allowlist? Deferred to the eval.

---

## Appendix A — Code reference map *(updated 2026-07-02)*

> Line numbers are approximate anchors; function names are stable. Verify before editing.

| Concern | Location | State |
|---|---|---|
| Org injection bounded + signal-gated | `src/memory/entity-index.ts` `selectEntities()` — two ceilings (`orgMax` / `max`), candidacy requires repo/owner/token/expansion signal; `SCORE_ORG` removed | ✅ shipped |
| Selection scoring | `entity-index.ts` — `SCORE_REPO=500`, `SCORE_OWNER=200`, `SCORE_PER_TOKEN=10`, `SCORE_EXPANSION=50`; `tokenize()` | current |
| Scope fallback | `src/memory/entities.ts` `pickScope()` — `org` only as the no-signal structural last resort | ✅ unbias shipped |
| Exact-match resolve (no dedupe) | `entities.ts` `resolveEntity()` — still exact slug/alias only | open (Phase 3) |
| Per-page observation cap | `entities.ts` `applyObservationCap()` enforced in `writeEntity()` (all write paths, incl. housekeeping merge); re-affirmation re-stamps `touched:` | ✅ shipped |
| Full-page injection render | `src/memory/context.ts` `renderEntityBlock()` — `touched_by` truncated to newest `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` at render time | ✅ shipped |
| Alias-only merge | `src/memory/housekeeping.ts` `planEntityMerges()` | open (Phase 3) |
| Archive only when fully stale | `housekeeping.ts` `isFullyStale()` | open |
| Caps / flags | `src/memory/paths.ts` — see Appendix B | current |
| Observation category = cosmetic | defined `types.ts`; consumed only as render prefix + dedup/re-stamp key + summary render | open (Phase 4) |
| Relation types = load-bearing | `touched_by` → related-tasks (`lifecycle.ts`); `owned_by` → +200 score (`entity-index.ts`) | keep |
| No memory tools for agents | `src/agents/tools.ts` — none in any of the 4 MCP servers | open (Phase 2) |
| Read path call sites | `src/agents/spawn.ts` `enrichPromptWithMemory()` (PM/repo/plugin tracks) | current |
| Write path | `src/memory/lifecycle.ts` `handleTaskCompleted` → `processExtraction` | current |
| Extraction scope guidance | `prompts/memory-extractor.md` — narrowest-applicable scope; "do NOT default to org" | ✅ shipped |

---

## Appendix B — Env flags *(updated 2026-07-02)*

| Flag | Default | Purpose |
|---|---|---|
| `ARCHIE_MEMORY` | `true` | Master switch (extraction + injection). |
| `ARCHIE_MEMORY_INJECT` | `false` | Read-path gate (default OFF). Currently disabled in prod; enablement gated on the Phase 1.5 eval. |
| `ARCHIE_MEMORY_HOUSEKEEPING` | `true` | Auto + manual consolidation. |
| `ARCHIE_MEMORY_USER_CAP` | `100` | Bullets per user file. |
| `ARCHIE_MEMORY_SECTION_CAP` | `30` | Bullets per `## Section`. |
| `ARCHIE_MEMORY_STALENESS_DAYS` | `180` | Drop-eligibility age. |
| `ARCHIE_MEMORY_ENTITY_CAP` | `300` | Soft cap on entity pages (no teeth until semantic dedupe — Phase 3). |
| `ARCHIE_MEMORY_ENTITY_INJECT_MAX` | `8` | **Ceiling** on full non-org pages per prompt (`0` → index-only). |
| `ARCHIE_MEMORY_ORG_INJECT_MAX` | `8` | **Ceiling** on full `scope:org` pages per prompt; only relevance-matched pages consume slots (`0` → index-only). |
| `ARCHIE_MEMORY_ENTITY_OBS_CAP` | `30` | Observations kept per entity page (newest-touched retained). |
| `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` | `10` | `touched_by` edges rendered per injected entity block (newest kept; disk unchanged). |

---

## Appendix C — Sources

- [Anthropic — Memory tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool)
- [Anthropic — Context management announcement](https://anthropic.com/news/context-management)
- [Letta — Agent memory](https://www.letta.com/blog/agent-memory/)
- [MemGPT — paper summary](https://www.leoniemonigatti.com/papers/memgpt.html)
- [mem0 — architecture overview](https://medium.com/@zeng.m.c22381/mem0-overall-architecture-and-principles-8edab6bc6dc4)
- [mem0 — repo](https://github.com/mem0ai/mem0)
- Internal: [`docs/architecture/memory.md`](../architecture/memory.md), Slack DM thread 2026-06-26 (Egor ↔ Igor).
