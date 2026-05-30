## 1. Pre-flight

- [x] 1.1 Re-read `proposal.md`, `design.md`, and the delta spec at `specs/memory-layer/spec.md`.
- [x] 1.2 Verify `npm run typecheck` and `npm test` are green on `feature/memory-layer` before starting.
- [x] 1.3 `grep -rn "shared/summary.md" src/` to confirm `lifecycle.ts` is the only writer/reader of the old per-task summary path.

## 2. Sanitizer (sanitization + prompt-injection defense requirements)

- [x] 2.1 Create `src/memory/sanitize.ts` with `sanitizeUpdate(update): MemoryUpdate | null`, `sanitizeActivityEntry(entry): ActivityEntry | null`, `isAllowedSection(s)`, `isAllowedDomain(d)`, `escapeTableCell(v)`.
- [x] 2.2 Add prompt-injection heuristics in the same module: `looksLikeInstruction(content)` (matches `/^(always|never|must|do not)\b/i` + imperative verb, and bypass-shaped tokens like `system prompt`, `ignore previous`, `you are`, `act as`) and `looksLikeSecret(content)` (long alphanumeric runs after `=`, `Bearer `, `sk-`, `xoxb-`, `ghp_`, etc.). Wire both into `sanitizeUpdate` rejection path.
- [x] 2.3 Route `applyOrgUpdates` and `applyUserUpdates` in `src/memory/store.ts` through `sanitizeUpdate`. Drop+log rejected entries via `logger.warn('memory', …)`.
- [x] 2.4 Route `appendActivity` in `src/memory/activity.ts` through `sanitizeActivityEntry`.
- [x] 2.5 Add `src/memory/__tests__/sanitize.test.ts`. Table-driven, one row per rule, positive + negative. Include adversarial fixtures: instruction-shaped lines, role-play directives, API-key-shaped strings.
- [x] 2.6 Confirm existing `store.test.ts`, `activity.test.ts`, `lifecycle.test.ts` still pass.

## 3. Skip unmatched updates (unmatched-update requirement)

- [x] 3.1 In `src/memory/store.ts:applyUpdate`, when `action === 'update'` and `old` is not found, return the input string unchanged and `logger.warn('memory', …)`.
- [x] 3.2 Add a case to `store.test.ts`: `applyUpdate("## Eng\n- A\n", {action:'update', old:'B', content:'C'})` returns input unchanged; logger is invoked.
- [x] 3.3 Tighten `prompts/memory-extractor.md` Rules section: discourage `update` actions without a confidently-matched `old`. (Combined with §5 prompt-injection text since both edit the same Rules section.)

## 4. Raw Slack ID identity (user-memory identifier requirement)

- [x] 4.1 Tighten `src/memory/paths.ts:getUserPath()` signature to `getUserPath(id: string): string`. Guard with regex `^(U|W|B|T)[A-Z0-9]{6,}$` for Slack IDs OR `^(cli|local):[A-Za-z0-9_-]+$` for fallback. Throw on mismatch.
- [x] 4.2 Update mention parsing in `src/memory/lifecycle.ts:extractUsernames` and `src/agents/spawn.ts:extractTaskUsernames` to return raw IDs (drop the `.split(' ')[0].toLowerCase()` transformation). New return shape: `{ userId, displayName }[]`.
- [x] 4.3 Add `resolveFallbackId(metadata): string` — for CLI channels return `cli:<sessionId>`; absent a session id, return `cli:<taskId>`.
- [x] 4.4 When `writeUser` creates a new file, prepend YAML frontmatter (`slack_user_id`, `display_name`, `aliases`). Existing files keep their existing frontmatter.
- [x] 4.5 Update `src/memory/context.ts:buildMemoryContext` to render `<user_preferences user_id="U…" display_name="...">` (fall back to user_id only if no frontmatter).
- [x] 4.6 At `initMemory()` startup, scan `users/` for non-`U/W/B/T/cli:/local:` filenames and `logger.warn('memory', 'legacy user file: <name>')` — do not auto-rename.
- [x] 4.7 Add `src/memory/__tests__/paths.test.ts` covering accepted and rejected IDs (Slack prefixes, fallback prefix, bare first name, empty string).
- [x] 4.8 Update `lifecycle.test.ts` fixtures to use raw `U…` IDs.
- [x] 4.9 Update `src/memory/__tests__/context.test.ts` to assert the new `<user_preferences>` attributes.

## 5. Multi-user existing memory in extraction

- [x] 5.1 In `lifecycle.ts:processExtraction`, build `userMemory` by concatenating each involved user's existing memory (labelled with `## <userId> (<displayName>)` headers) instead of only the first user. Use `Promise.all`.
- [x] 5.2 In `extractor.ts:parseExtractionResponse`, drop any `user_updates[key]` whose `key` is not in the involved-users list. Log the drop. (Need to thread the allowed set into the parser; either via closure or as a second arg.)
- [x] 5.3 Update `lifecycle.test.ts` to mock two users; assert the extractor receives both blocks and that an update for a third user is dropped.

## 6. Remove the "Learned from this task" Slack post (REMOVED requirement)

- [x] 6.1 Delete `postLearnings()` from `src/memory/lifecycle.ts`.
- [x] 6.2 Remove the call site for `postLearnings()` in `processExtraction`.
- [x] 6.3 Remove the import of `postSlackMessage` from `lifecycle.ts` (only used for the now-deleted post).
- [x] 6.4 Remove `import type { SlackChannel, SlackThreadRef }` if no longer used elsewhere in `lifecycle.ts`.
- [x] 6.5 Remove the corresponding test case `'calls postSlackMessage with the learnings message'` from `lifecycle.test.ts` and replace it with an assertion that postSlackMessage is NOT called.
- [x] 6.6 Update `docs/architecture/memory.md` to remove the step "8. Post learnings to Slack threads" from the extraction pipeline diagram, and remove the "Posts to Slack" mention from the feature description. (Completed as part of §10.1 doc sweep.)

## 7. Housekeeping (new ADDED requirement)

- [x] 7.1 Created `src/memory/housekeeping.ts` exposing `runHousekeeping(target)`. Internals: `consolidateFile`, `traceBackOutput`, `validateTraceBack`, `extractBullets`.
- [x] 7.2 Created `prompts/memory-housekeeper.md` — merge/drop/reorder only, no paraphrasing, transcript-as-data preamble.
- [x] 7.3 Inline `<!-- touched: YYYY-MM-DD -->` annotation now added on `add`, refreshed on matched `update` in `applyUpdate`. `old` matching strips annotations before substring check.
- [x] 7.4 `parseLastTouched`, `stripLastTouched`, `appendLastTouched` live in new `src/memory/annotations.ts` (avoids store/housekeeping circular dep).
- [x] 7.5 Soft-cap detection: `applyOrgUpdates` / `applyUserUpdatesWithIdentity` return a boolean indicating overflow; lifecycle.ts enqueues `runHousekeeping(target)` on the same queue when overflow.
- [x] 7.6 Housekeeping shares the `extractionQueue` defined in `lifecycle.ts`.
- [x] 7.7 Env flags added in `paths.ts`: `isHousekeepingEnabled`, `getOrgCap`, `getUserCap`, `getSectionCap`, `getStalenessDays`. All documented in `.env.example`.
- [x] 7.8 Manual entry point `scripts/memory-housekeeping.ts` + `npm run memory:housekeeping -- --target <org|all|U…>` in package.json.
- [x] 7.9 `recordHousekeepingNote(target, note)` queues a per-target note; `buildSummaryMarkdown` drains and renders them under `### Housekeeping` inside `## Memory Updates`.
- [x] 7.10 Tests in `src/memory/__tests__/housekeeping.test.ts`: annotation round-trip, `extractBullets` parsing, `traceBackOutput` accepts verbatim / rejects new facts / rejects paraphrase, `validateTraceBack` split, soft-cap detection thresholds. (Stale-window-drop integration test deferred to manual smoke run §11.5.)

## 8. Summary location + content (per-task summary requirement)

- [x] 8.1 In `src/memory/paths.ts`: add `getSummaryPath(taskId): string` → `workdir/memory/summaries/<taskId>.md`. Old `getTaskSummaryPath` kept as `@deprecated` for callers locating legacy files.
- [x] 8.2 In `initMemory()`, also create `workdir/memory/summaries/` at startup.
- [x] 8.3 Refactored `buildSummaryMarkdown` to produce the rich schema from design.md §D9: frontmatter (`task_id`, `status`, `created_at`, `updated_at`, `domain`, `extraction_at`, `links`, `users`), `# Summary`, `## Memory Updates`, `## Related Tasks`.
- [x] 8.4 Implemented `selectRelatedTasks` — domain filter, stopword-removed token-overlap, top-5 with min 2-token overlap.
- [x] 8.5 `_no durable learnings_` literal emitted when both org_updates and user_updates are empty.
- [x] 8.6 `_no related tasks found_` literal emitted when zero candidates clear the overlap threshold.
- [x] 8.7 Links block built from `metadata.channels`: slack threads → channel_id + thread_id; github PRs → url; cli sessions → session_id.
- [x] 8.8 Updated `lifecycle.test.ts` with new-path assertion, frontmatter assertions, memory-updates per-file bullets, empty-learnings placeholder, slack-link frontmatter.

## 9. Durable extraction queue (durable-extraction requirement)

- [x] 9.1 Add `src/memory/pending-queue.ts`:
  - `enqueuePending(taskId)` — append `- {taskId}` to `workdir/memory/pending-extractions.md` via tmp-then-rename.
  - `dequeuePending(taskId)` — rewrite file without that line.
  - `readPending(): string[]` — return all queued task IDs.
- [x] 9.2 Wire `handleTaskCompleted` to `enqueuePending` before scheduling; wire `processExtraction` to `dequeuePending` on success.
- [x] 9.3 At `initMemory()` startup, call `readPending()` and re-schedule each via `rescheduleTaskCompleted()` (drains without re-enqueueing).
- [x] 9.4 Add `src/memory/__tests__/pending-queue.test.ts`: enqueue/dequeue/read round-trip on a temp dir; idempotent enqueue; malformed-line resilience.
- [x] 9.5 Restart-resilience test in `lifecycle.test.ts`: pre-populate the queue file, call `rescheduleTaskCompleted()`, observe extraction completes and the entry is removed.

## 10. Docs + spec alignment

- [x] 10.1 Updated `docs/architecture/memory.md`:
  - Removed the "Known Gaps" table; replaced with a "Hardening (landed on this branch)" table summarising the resolved findings.
  - Storage section: new `summaries/` and `pending-extractions.md` entries; raw Slack ID filename rule; frontmatter shape for user files.
  - Feature-flag section: now lists `ARCHIE_MEMORY`, `ARCHIE_MEMORY_HOUSEKEEPING`, and the four cap/staleness variables.
  - Added a new "Housekeeping" section between "Storage Formats" and "Feature Flags".
  - Updated extraction-pipeline diagram: step 6 writes to new memory dir; step 7 = activity append/trim; step 8 = soft-cap-triggered housekeeping. Slack post removed from the diagram.
  - Updated Components tree, Testing table.
- [x] 10.2 Archive-time sync applied +1 / ~7 / -1 deltas to `openspec/specs/memory-layer/spec.md`. `Currently violated` markers cleared; "Learned-from-this-task Slack post" requirement removed.

## 11. Verification

- [x] 11.1 `npm run typecheck` — **green**.
- [x] 11.2 `npm test` — **green: 18 test files, 310 tests passing** (baseline 153 → +157 net new tests). Far exceeds the ≈ +25 estimate in design because the housekeeping/sanitize/pending-queue/paths modules each got their own dedicated test files.
- [ ] 11.3 Manual smoke run — **deferred to implementer**. Requires a live Slack workspace and `npm run dev`. Steps documented in this section for the reviewer:
  - `ARCHIE_MEMORY=true ARCHIE_MEMORY_HOUSEKEEPING=true npm run dev`.
  - Drive a Slack task mentioning two distinct users to completion.
  - Observe `workdir/memory/users/U<id1>.md` and `users/U<id2>.md` with YAML frontmatter and `<!-- touched: -->` annotations.
  - Observe `workdir/memory/summaries/<taskId>.md` with `# Summary`, populated `## Memory Updates`, `## Related Tasks` (or its `_no related tasks found_` placeholder).
  - Observe NO "Learned from this task" message in the originating Slack thread.
  - Observe `workdir/memory/pending-extractions.md` ends empty.
- [ ] 11.4 Restart-resilience smoke run — **deferred to implementer**. Covered by automated test (`lifecycle.test.ts > replays a pending task left over from a previous run`); manual procedure documented for reviewer:
  - Temporarily insert `await new Promise(r => setTimeout(r, 60_000))` at the start of `processExtraction` (dev only).
  - Trigger `task:completed`. Observe `pending-extractions.md` has the entry.
  - `kill -9` the process. Confirm the entry remains.
  - Restart. Observe extraction runs and the entry is removed.
- [ ] 11.5 Housekeeping smoke run — **deferred to implementer**. Trace-back validator and soft-cap detection are unit-tested; full side-agent-driven consolidation requires a live model call and is best done as a manual pass:
  - Pre-seed `workdir/memory/org.md` with 31 bullets in one section (cap 30).
  - Trigger a task completion that touches that section.
  - Observe consolidation runs and `<!-- touched: -->` annotations remain on surviving bullets.
  - Observe the resulting summary's `## Memory Updates` contains a `**housekeeping**` line.

## 12. Archive

- [x] 12.1 Moved to `openspec/changes/archive/2026-05-29-harden-memory-layer/`.
- [x] 12.2 `openspec list` returns "No active changes found".
- [x] 12.3 Canonical spec synced — housekeeping requirement present (line 281), Slack-notification requirement removed, 7 MODIFIED requirements carry current content without violated markers.
