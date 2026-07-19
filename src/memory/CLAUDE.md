# Memory Layer — CLAUDE.md

`src/memory/` is a self-contained, ejectable subsystem that gives agents persistent
cross-task knowledge: organizational facts, user preferences, a rolling activity index,
and per-task summaries. Gated entirely by the `ARCHIE_MEMORY` flag.

## Read these before changing anything here

- **`docs/architecture/memory.md`** — the as-built design (source of truth): two-path
  read/write flow, confidentiality policy, storage formats, flags, eval harness, and the
  ejection recipe. The code must match it.
- **`docs/plans/20260719-memory-v2.md`** — how the layer got this shape (the five
  memory-v2 stages and their key decisions); **`docs/proposals/memory-v2-roadmap.md`** —
  what comes next and what gates it.

The root `CLAUDE.md` rules (logging, git workflow, dev setup) apply here too — this file
only adds what's specific to the memory layer.

## Keep the docs in sync — in the same change, not "later"

When you change behavior in `src/memory/`, update the docs in the **same commit**:

- Flow / storage / behavior changed → update `docs/architecture/memory.md`.
  **Delete the stale prose; don't bolt on a "now it also…" note.** A doc that contradicts
  the code is worse than no doc.
- Added / renamed / removed a flag → update the flags table in `memory.md` **and**
  `.env.example`.
- Any logic change → add or update a test under `src/memory/__tests__/`.

If you're unsure whether a change is big enough to document: it is.

## Invariants — don't break these

- **One coupling, two seam files.** `src/memory/` imports freely from core. Core imports *from*
  memory in exactly two files — `initMemory()` in `src/index.ts`, and in `src/agents/spawn.ts`
  the read paths: `enrichPromptWithMemory()` / `isMemoryEnabled()` (push) plus
  `isMemoryToolsEnabled()` / `createMemoryToolsMcpServer()` (pull tools). Keep it that way;
  a new seam file breaks one-step ejection.
- **Stays ejectable.** No database, no migrations, no new external service, no memory types
  leaking into core. If a change adds coupling or a new persistence backend, fix the
  "Ejection" section of `memory.md` to match — or reconsider the change.
- **Flag-safe.** With `ARCHIE_MEMORY=false`, `initMemory` / `enrichPromptWithMemory` /
  `handleTaskCompleted` must all no-op. Never add a path that runs when the flag is off.
- **Model output is untrusted.** Everything the extraction/housekeeping side-agents emit
  passes through `sanitize.ts` before it touches a file; transcripts are a prompt-injection
  surface. Don't persist extracted content unsanitized. The side-agents run `maxTurns: 1`,
  `allowedTools: []`, minimal env — don't loosen that.
- **User files are keyed by Slack ID** (`U…/W…/B…/T…`) or a `cli:` / `local:` fallback,
  never by display name. Always go through the `paths.ts` guards (`getUserPath`,
  `isAllowedUserId`); never hand-build a memory path.
- **Writes are serialized.** Extraction and housekeeping share one sequential queue in
  `lifecycle.ts`. Don't write `users/*.md` / `recent-activity.md` / entity pages outside it —
  concurrent task completions will corrupt the files. (Telemetry appends in `telemetry.ts`
  are the one exception: single-line appends, fail-safe, never read back at runtime.)
- **Read tools stay read-only.** `tools.ts` exposes zero mutating tools; every identifier
  passes the `paths.ts` guards before any filesystem access. Don't add a write/forget tool
  here — runtime writes are a separate, gated phase (see the roadmap).
- **Reads are authorized, writes are gated.** `authz.ts` is the confidentiality boundary:
  episodic reads require the target summary's `access: org` stamp (the only class extraction
  writes — v1 `dm` stamps deny like legacy), `search_memory` never ranks user files outside
  the caller's AUTHOR users, the extraction gate is a whitelist (ext-shared/unknown/private ⇒
  skip + retract stale artifacts; dm ⇒ prefs-only, user updates only; only all-public ⇒ full),
  user updates need `msg:<ts>` evidence authored by their target user, and ext-shared or
  unknown-stamped tasks get no memory surface at all (spawn + per-call deny on all four
  tools; the per-call lock re-derives from fresh task metadata, so a mid-session
  ext-shared flip locks the next call). Everything unknown fails closed (missing stamp,
  missing ctx ⇒ self-only; classification error ⇒ `unknown` ⇒ locked). Never add an
  unscoped read surface or widen a default on error.

## Files that carry those invariants

The full annotated map is in `memory.md` → "Components". The load-bearing ones:

- `paths.ts` — path resolution, ID guards, flag accessors. Change flags/IDs here.
- `sanitize.ts` — the trust boundary for all model output.
- `lifecycle.ts` — the sequential write queue + extraction pipeline.
- `store.ts` — `applyUpdate` add / update / skip-unmatched semantics.
- Prompts live in `prompts/memory-extractor.md` and `prompts/memory-housekeeper.md`.

## Verify

```bash
npm run typecheck
npx vitest run src/memory/__tests__/      # or: npm test  (whole suite)
```

Manual consolidation pass: `npm run memory:housekeeping -- --target <org|all|U…>`.
