## Why

The memory layer shipped on `feature/memory-layer` with a clean MVP shape (file-based Markdown, side-agent extraction, prompt injection at spawn). Reviewing it against operational needs surfaced two classes of gap:

**Hardening gaps** — defects surfaced by review of the shipped code that block confident rollout:

- Identity collisions when multiple users share a first name.
- Model output written unsanitized; newlines, pipes, or `##` headers can corrupt files.
- Unmatched `update` actions silently become orphan bullets.
- `task:completed` followed by process exit loses the extraction (in-memory queue).
- Extractor prompt does not demarcate transcript as untrusted; validator does not reject instruction-shaped content.
- "Learned from this task" Slack post fires on every completion, including those with no learnings.
- Only the first mentioned user's existing memory is loaded into extraction context.

**Refinements** that change spec-level behavior beyond pure hardening:

- Filenames should be raw full Slack IDs (`U…`, `W…`, `B…`, `T…`) for one-to-one mapping with Slack admin tools — operators need to grep without transformation.
- The "Learned from this task" Slack post does not justify its cost: it adds noise to user threads, exposes operational details that don't belong in the user-facing channel, and any debug value is already covered by structured logs and the per-task summary. Remove it from the code entirely.
- `org.md` and `users/*.md` grow monotonically; without housekeeping (caps, staleness tracking, consolidation) the layer rots over time.
- The per-task summary lives under the session directory (mixed with runtime artifacts) and contains only the prose summary; to be the "what did we learn" artifact, it should live alongside the rest of memory and capture the actual memory diff plus links back to the originating Slack thread / GitHub PR.

Each item is independently fixable, but they share one owner area (`src/memory/`) and benefit from being shipped together so the layer reaches a coherent "v1 hardened and refined" state in a single merge rather than nine trickle-fixes.

This change aligns implementation with the canonical `memory-layer` spec across nine requirements: user-memory identifier, durable extraction, sanitization, prompt-injection defense, the Slack-notification requirement (removed), multi-user extraction context, unmatched-update handling, per-task summary, and a new housekeeping requirement.

## What Changes

Spec deltas:

- **MODIFIED** _User memory MUST be keyed by stable identifier_. Tighten from "stable identifier" to **raw full Slack ID** (`U…`/`W…`/`B…`/`T…`) used verbatim as the filename, with a documented non-Slack fallback (`cli:<sessionId>`, `local:<osUser>`). Display name persisted inside the file as YAML frontmatter.
- **MODIFIED** _Extraction MUST be durable across restarts_. A Markdown pending-extraction queue persists across restarts and is drained at startup.
- **MODIFIED** _Sanitization MUST run before any Markdown write_. All extracted update fields are validated and sanitized before any Markdown write.
- **MODIFIED** _Prompt-injection defense in extractor_. Extractor prompt explicitly marks transcript as untrusted; validator rejects instruction-shaped content, role-play directives, and secret-shaped tokens.
- **REMOVED** _Learned-from-this-task Slack post SHALL only fire on durable learnings_. The "Learned from this task" Slack post is deleted from the system. `postLearnings()` and its message-format logic are removed; the lifecycle stops calling it; the Slack-thread enumeration code that supports it is removed; related tests are removed. **BREAKING** for anyone relying on the post as a signal, but evidence suggests no one is: structured logs already cover the debug path, and the per-task summary in `workdir/memory/summaries/` covers the audit path.
- **MODIFIED** _Existing memory for ALL involved users SHALL be passed to extraction_. Existing memory for every involved user is loaded and labelled in the extraction prompt; updates returned are constrained to that set.
- **MODIFIED** _Unmatched update actions SHALL NOT silently append_. `update` actions whose `old` is not found are skipped and logged, never silently converted to `add`.
- **MODIFIED** _Per-task summary written to session shared dir_. **BREAKING** path move from `workdir/sessions/<taskId>/shared/summary.md` to `workdir/memory/summaries/<taskId>.md`. Content extended to include applied memory updates (with before/after diffs) and links back to originating channels.
- **ADDED** _Org and user memory SHALL be housekept_. Soft size budgets (200 bullets org / 100 per user / 30 per section), per-bullet last-touched annotation (inline HTML comment), and a triggerable side-agent consolidation pass with a trace-back validator that forbids the consolidator from introducing new facts. Auto-runs when budgets are exceeded; controllable via `ARCHIE_MEMORY_HOUSEKEEPING` (default `true`).

No requirements are removed. No new capabilities are introduced.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `memory-layer`: 7 requirements modified (user identifier; durable extraction; sanitization; prompt-injection defense; multi-user extraction context; unmatched-update handling; per-task summary), 1 requirement removed (Slack-notification post), 1 requirement added (housekeeping).

## Impact

- **Spec**: `openspec/specs/memory-layer/spec.md` — 8 requirements get their content updated; 1 added. Once this change archives, the `*(Currently violated — see harden-memory-layer.)*` markers in the canonical spec are removed.
- **Architecture doc**: `docs/architecture/memory.md` — storage-layout section updated for `summaries/`, raw Slack IDs, and frontmatter shapes; feature-flag section gets `ARCHIE_MEMORY_HOUSEKEEPING` and the four cap/staleness variables; the "Learned from this task" Slack post is removed from the extraction-pipeline diagram and its narrative; new "Housekeeping" section; "Known Gaps" table removed.
- **Source**:
  - `src/memory/paths.ts` — `getUserPath()` takes raw `U…` ID and asserts shape; new `getSummaryPath()` resolves to `workdir/memory/summaries/<taskId>.md`; new `isNotifyLearningsEnabled()` and `isHousekeepingEnabled()` flag helpers.
  - `src/memory/store.ts` — `applyUpdate` skips unmatched updates; adds `<!-- touched: YYYY-MM-DD -->` annotation; routes all writes through sanitizer; emits soft-cap-exceeded events.
  - `src/memory/lifecycle.ts` — `extractUsernames`/`extractTaskUsernames` return raw IDs; multi-user memory loaded in parallel; `postLearnings()` and its caller in `processExtraction()` removed; `buildSummaryMarkdown` extended with memory-diff + related-tasks sections; new path used.
  - **New** `src/memory/sanitize.ts` — centralised validation/sanitization.
  - **New** `src/memory/pending-queue.ts` — durable extraction queue (`workdir/memory/pending-extractions.md`).
  - **New** `src/memory/housekeeping.ts` — soft-cap detection, side-agent consolidation, trace-back validator.
  - **New** `prompts/memory-housekeeper.md` — consolidation prompt.
  - `prompts/memory-extractor.md` — explicit untrusted-data preamble; tighter examples around `update` actions.
  - `src/memory/index.ts` — bootstrap creates `summaries/` directory; subscribes housekeeping to soft-cap events; drains pending queue at startup.
  - `.env.example` — adds `ARCHIE_MEMORY_HOUSEKEEPING`, `ARCHIE_MEMORY_ORG_CAP`, `ARCHIE_MEMORY_USER_CAP`, `ARCHIE_MEMORY_SECTION_CAP`, `ARCHIE_MEMORY_STALENESS_DAYS`.
- **Tests**: ~25 new test cases distributed across the affected modules.
- **Migration**: Existing first-name-keyed user files (if any in dev workdirs) are logged at startup as legacy and left in place — no auto-rename. Existing `workdir/sessions/<taskId>/shared/summary.md` files are left in place — no automated migration. New writes use new paths.
- **Risks**:
  - Aggressive sanitization could over-reject legitimate content → bias toward escape, log every drop.
  - Consolidator might paraphrase past the trace-back validator → tight edit-distance threshold + explicit "no paraphrasing" prompt rules.
  - HTML-comment metadata visible only when grepping → document the Markdown-lint exclusion.
  - Removing the "Learned" Slack post means new operators have no in-channel signal that learning is happening → covered by structured logs and the per-task summary file; both will be highlighted in `docs/architecture/memory.md`.

## Out of Scope

- **Eval tooling decision.** The stashed `scripts/memory-eval.ts` + `src/memory/eval/` work uses JSON fixtures and JSON model contracts. The Markdown-only-scope question stays open (see spec "Open Questions" #3); not addressed by this change.
- **Pull retrieval / MCP server.** Future direction, not in this change.
- **Channel-based access control.** Not in this change.
- **Domain-split `org.md`.** Single-file org memory is fine at current volume.
- **Embedding search over task summaries.** Not warranted yet.
- **Slack reaction → revert flow.** Useful but separate UX work.
- **CLI / non-Slack canonical user identifier resolution.** Today's fallback discipline is documented but a richer per-CLI-user identity model is a separate change.
- **Automated migration of existing first-name user files or session-dir summaries.** Manual cleanup if needed.
