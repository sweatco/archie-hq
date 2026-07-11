# AC2 — VERIFIED (QA cycle 2 addendum; monolith split into per-claim cases)

**Method**: integration · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box

**Test file**: `src/connectors/github/__tests__/mention-handler.test.ts` — run fresh via `npx vitest run src/connectors/github/__tests__/mention-handler.test.ts --reporter=verbose`. File result: 26/26 passed. Raw output: `../raw/mention-handler.txt`; full-suite run: `../test-run.txt` (904/904, AC2 cases at lines 241-245).

## Cycle history

- Cycle 1 (@ `d2976f9`): VERIFIED via the single monolith case `creates a seeded task from an authorized comment mention` (all AC2 claims asserted inside one case).
- Cycle 2 (@ `8f70930`): unchanged (monolith still present, 22/22 file total).
- Cycle 2 addendum (@ `05fcf1a`): the monolith was split into 5 per-claim named cases, each tagged `(AC2)`; the old monolith case name no longer appears. All five exist and pass; a claim-level regression now fails a named case instead of hiding inside the monolith.

## AC2 clauses → named cases (exact names from vitest verbose output)

Brief AC2: "WHEN a `new_task` event's author has write/maintain/admin on the repo THEN a task is created; `knowledge.log` is seeded with repo, issue/PR number, title, body, the mentioning comment text, author, and a link back; the PM receives the new-task prompt; task metadata records the GitHub origin (repo + issue number → taskId)."

| AC2 clause | Case in output (all under `handleGitHubMentionDirect — creation path (AC2, AC4, AC5)`) | Result |
|---|---|---|
| task is created + `knowledge.log` seeded with repo and issue/PR number (destination prefix) | `seeds knowledge.log with the repo and issue number via the destination prefix (AC2)` | ✓ pass |
| seeded with title and body, plus the link back to the thread | `seeds knowledge.log with the issue title, body, and thread link (AC2)` | ✓ pass |
| seeded with the mentioning comment text (verbatim, `[comment_id=…]` tag) and author, with link back | `seeds the verbatim mentioning comment with its [comment_id] tag, author, and link back (AC2)` | ✓ pass |
| task metadata records the GitHub origin (repo + issue number → taskId), durable on disk immediately (sync-save, design D6) so `findTaskByIssueChannel` resolves | `records the GitHub origin as a github channel entry with repo + issue number, on disk immediately (sync-save, AC2)` | ✓ pass |
| the PM receives the new-task prompt (`AGENT_PROMPTS.newTask`) | `pings the PM with the newTask prompt after seeding (AC2)` | ✓ pass |

Every case exercises the authorized (write-permission) creation path, so the "author has write/maintain/admin → task is created" precondition is exercised five times over; the unauthorized complement is pinned under AC3.

The plan's on-disk durability requirement is additionally pinned in `src/tasks/__tests__/github-channel.test.ts > Task.linkGitHubChannel > persists to on-disk metadata via save(true)` — ✓ pass (see `../raw/github-channel.txt`).

## Vitest output excerpt (from `../raw/mention-handler.txt`, run at 04:08:05)

```
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > seeds knowledge.log with the repo and issue number via the destination prefix (AC2) 6ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > seeds knowledge.log with the issue title, body, and thread link (AC2) 3ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > seeds the verbatim mentioning comment with its [comment_id] tag, author, and link back (AC2) 3ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > records the GitHub origin as a github channel entry with repo + issue number, on disk immediately (sync-save, AC2) 3ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > pings the PM with the newTask prompt after seeding (AC2) 3ms

 Test Files  1 passed (1)
      Tests  26 passed (26)
```
