# Tasks: memory-v2-pull-and-eval

## 1. Read tools (pull path)

- [x] 1.1 Add `ARCHIE_MEMORY_TOOLS` flag accessor to `src/memory/paths.ts` (default off, exact-`true` gate, `ARCHIE_MEMORY=false` overrides) + `.env.example` entry
- [x] 1.2 Implement `src/memory/tools.ts`: `search_memory` (lexical, `selectEntities`' tokenizer over active entity pages, user files, task summaries, recent-activity; ranked thin hits — identifier, kind, one-liner — max-hit bounded), `read_entity` (slug guard, render with `touched_by` truncation as injection does, archived pages readable and marked), `read_task_summary` (task-ID guard, reads `memory/tasks/<id>/summary.md`), `grep_task_log` (task-ID guard, line-numbered matches, count-bounded, untrusted-data framing wrapper); export a `createMemoryToolsMcpServer()` factory; every identifier goes through existing `paths.ts`/`sanitize.ts` guards, no hand-built paths, zero mutating tools
- [x] 1.3 Register the server for all three tracks in `src/agents/tools.ts` when the flag is on (the deliberate third core→memory seam); verify flag-off leaves tool lists byte-identical
- [x] 1.4 Tests (`src/memory/__tests__/tools.test.ts`): registration gating, search ranking + zero-result, slug/task-ID guard rejections, result bounds, archived-entity marking, no-write surface

## 2. Pull sensor

- [x] 2.1 Extract the shared telemetry appender from `recordSelection` (`src/memory/context.ts`) into a small module both sensors use; existing selection-record shape unchanged (kind-less lines remain selection records)
- [x] 2.2 Record one `kind: "pull"` line per tool invocation with a known taskId (tool name, args/query, returned identifiers, result count, zero-result flag); fail-safe: sensor errors log a warning and never affect the tool result; no taskId → skip silently
- [x] 2.3 Tests: record shape, mixed-kind file partitioning, fail-safe on unwritable path, no records when tools disabled

## 3. Eval harness v0

- [x] 3.1 Write `scripts/memory-eval.ts` + `memory:eval` npm script: `ARCHIE_WORKDIR`-addressed snapshot, refuse without `memory/` subtree, read-only (report written outside the snapshot; default `~/archie-snapshots/reports/`)
- [x] 3.2 Store-health section: entity count vs cap, observation/page-size distributions, staleness distribution, archived count, versioned near-duplicate rate (normalized lexical similarity over names/aliases/L0s); deltas (growth, duplicate trend, turnover) when `--prev` snapshot/report supplied
- [x] 3.3 Telemetry-aggregation section over `memory/tasks/*/telemetry.jsonl`: selection records (spawn counts, injection/zero-injection rates, budget-drop frequency, rendered-token distribution) and pull records (calls per task, hit/zero-result rates, store-gap query list); absent kinds reported as absent, unparseable lines counted and skipped
- [x] 3.4 Golden-set format + harvester: versioned JSON case `{v, harvested_at, snapshot_date, ctx, expected}`; harvest subcommand reading live selection records (post-enablement); goldens stored outside the repo (`~/archie-snapshots/golden/`)
- [x] 3.5 Selection-regression section (mechanical): replay golden `ctx`s through production `selectEntities` against the snapshot, per-case selected/dropped diffs vs `expected`, snapshot-date mismatch warning, zero-diff self-check for same-code-same-store goldens
- [x] 3.6 Enablement-gate outputs: worst-case injected-token bound from the snapshot via the exported production render path (index + org/non-org largest × ceilings + summed user blocks + recent-activity, tagged with budget flag-accessor values); `--report` store-review reading list covering entities (by connectedness/size/staleness) and every injected non-entity block (`users/*.md`, `recent-activity.md`, `entities/index.md`) with sizes + suspicious-content flags (URLs, imperative override phrasing, base64-like blobs)
- [x] 3.7 Read-only verification test for the eval: full tree listing + file hashes identical before/after a `--report` run, no new files (no telemetry under `memory/tasks/`, no `plugins-data/`)
- [x] 3.8 `scripts/snapshot-memory.sh`: wrap `pull-remote-data.sh -m` into `~/archie-snapshots/archie-memory-YYYYMMDD.tgz` (host/dir via env/args), skip if today's exists, pass the container name explicitly (auto-detect uses `mapfile`, absent from macOS `/bin/bash` 3.2 under launchd's `PATH`), append outcome to `snapshot.log`; header documents the `launchd` `StartCalendarInterval` (daily `Hour`/`Minute`, not `StartInterval`), plist `PATH`, and SSH-key assumptions; no repo-committed plist

## 3f. Functional eval tier

- [x] 3f.1 Question-set format `{v, question, gold, evidenceEntities[], sourceTranscriptRef}`; loader + validation; store off-repo (`~/archie-snapshots/questions/`)
- [x] 3f.2 Benchmark adapter: import a LongMemEval-style public set (or a small vendored subset) as the portable regression anchor — wire it to the same runner so the harness can be smoke-tested before any prod data exists
- [x] 3f.3 Surfaced-context builder: given a question, run the production `selectEntities` + injection render (+ optional pull-tool agent loop) over the snapshot to produce the context — reuse the real code path, no reimplementation; emit surfaced-context recall/precision vs `evidenceEntities` (no model)
- [x] 3f.4 Fixed-reader + arms runner: no-memory / memory / Oracle (evidence-only) arms, reader model pinned and identical across arms; per-arm answer collection; seeds pinned
- [x] 3f.5 Rubric judge + governance: per-question-type rubric; judge model from a different family than the extractor; a `memory:eval --validate-judge` mode computing Cohen's κ + position bias against a human-labeled sample; stamp reader/judge/κ/bias in the report header; mark results non-gating when unvalidated or same-family
- [x] 3f.6 Over-injection sweep: re-score the memory arm at tighter injected-token budgets, report answer-correctness delta per budget
- [x] 3f.7 Prod-transcript question synthesis subcommand: LLM generates `{question, gold, evidenceEntities}` from pulled task transcripts, store supplies distractors natively; emit a human-validation worklist (sample to label); the label sample, not the generator, is the trust anchor
- [x] 3f.8 Tests: recall/precision math on a fixture question + fixture store; arm wiring (Oracle ≥ memory ≥ no-memory sanity on a constructed case); judge-gating flag logic (unvalidated/same-family → non-gating); read-only over the snapshot

## 4. Spec + docs cleanup

- [x] 4.1 Apply the delta to `openspec/specs/memory-layer/spec.md` (new requirements; org-entities requirement present-tense rewrite, backfill scenario dropped; storage-requirement path fix; summary-requirement rename) — `openspec validate` clean
- [x] 4.2 Canonical-spec prose cleanup in the same edit: Non-Goals (pull tool non-goal superseded, edits-via-tools non-goal retained/reworded), Glossary task-summary path, Observability (drop org-update and Slack-post lines, add tool-call + pull-record lines), Dependencies (drop `postSlackMessage`), Open Questions (delete resolved 1–2, resolve 3 per this change)
- [x] 4.3 `docs/architecture/memory.md`: read-tools section (surface, guards, flag), pull sensor in Telemetry, eval harness note, flags table + ejection recipe + seam count updated
- [x] 4.4 `src/memory/CLAUDE.md`: seam invariant (two → three, named), drop stale `org.md` write-queue mention
- [x] 4.5 Remove leftover empty change/archive skeleton directories under `openspec/changes/` (dirs only, no files) so the tree is clean

## 5. Roadmap revision (companion)

- [x] 5.1 Roadmap already restructured on this branch alongside the proposal (two-track view; Phase 2 = this change; Phase 3 = write-path rewrite subsuming dedupe + forgetting with the selective-forgetting eval gate and the re-homed buy-vs-build spike; Phase 4 = embeddings, conditionally triggered; Phase 5 = judgment eval) — during apply, sync item statuses as tasks land and fix any drift

## 6. Rollout (human, after merge)

- [ ] 6.1 Enablement gate → flip injection: install `snapshot-memory.sh` on the laptop launchd and land one snapshot; run `memory:eval --report` for the worst-case token bound + store-review reading list; do the ~1–2h human store review and clean flagged pages on the prod store (only while the app is stopped or verifiably idle; rebuild the index after manual edits); run the functional eval on the benchmark for a selection-quality sanity check; if all acceptable, flip `ARCHIE_MEMORY_INJECT=true` in its own PR carrying that evidence. Rollback = flag off
- [ ] 6.2 Flip `ARCHIE_MEMORY_TOOLS=true` with or after the injection flip (design D8), own PR carrying the first full `memory:eval` report; optionally verify on a booted branch instance first via the `archie-e2e` harness (seed store → task → assert pull records). **Precondition: the `memory-v2-authz` change (confidentiality gate + pull-tool authorization) must be merged first — the pre-authz tool surface serves any task's transcript and any user's preferences to any agent**
- [ ] 6.25 After 6.2 (folded from memory-v2-authz §8): watch `deniedRate`/`denyReasons`, `extraction-skip`, `extraction-prefs-only`, and `user-update-dropped` counts in `memory:eval` — high denial rates mean agents probe the boundary; skip/prefs-only counts quantify the policy's memory loss. The 6.1 store review should additionally eyeball entity pages for pre-policy private-derived facts (cleanup postponed — authz design D9)
- [ ] 6.3 After 2–3 weeks of records: run `memory:eval` on a fresh snapshot, review pull rates + store-gap list, harvest the first golden set from live selection records, and synthesize a first prod question set for the functional eval
