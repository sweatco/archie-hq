# Adversarial bug hunter — round 1

Verdict: **PASS — no blocking findings; 3 non-blocking PLAUSIBLE observations.** Working tree left clean; typecheck clean; full suite 897/897.

## Mutation audit (test-theater check): 11 mutations, all caught

sync-save→debounced (caught by on-disk assertions); author gate opened (AC7 drop tests); watermark-advance-on-drop (watermark pin); 403 check removed (route test); `formatGitHubEvent` destination preference flipped (AC11 byte-identical pin); dedup guard dropped for Archie-PR arm (AC11 dedup pins); `request_edit_mode` guard removed (AC10); `request_max_mode` guard removed (max row); approval guard neutralized (rejection + 403 tests); creation watermark unset (seed test); `[bot]` skip / slug gate removed (their dedicated tests). Every priority assertion is load-bearing.

## Non-blocking observations

1. Issues-born race fall-through renders a degenerate knowledge-log entry (`events.ts:238-247` + `webhooks.ts:263-264` default arm: destination "PR", message "issues/opened", body dropped) — only reachable when a concurrent/redelivered `issues.opened` lost the race to a delivery that already seeded the same body; cosmetic log noise. (Same finding as spec-compliance non-blocker.)
2. Decline dedup records `recentDeclines` only after the awaited `addPRComment` resolves; N near-simultaneous authorized mentions on one uncovered thread post N declines (map narrows sequential bursts only). Self-limiting: authorized users, decline path only.
3. If seeding throws after the durable `save(true)`, the mapping is live but the task has no seed/ack/PM wake; a remedial re-mention routes as a follow-up into a context-degraded task (PM sees re-mention text + spawn context origin URL, not the original body). Consistent with documented fire-and-forget stance; weaker than a fresh create.

## Hunted, verified sound

Regex/escape; `issueNumber ?? prNumber` keying (stores cannot coexist in v1; hypothetical overlap takes max + advances both — consistent); channel key symmetry (structural matching, never key parsing; substring false-positive structurally rejected + pinned); permission cache (negative caching, thrown-uncached, lazy eviction); restart/lifecycle (disk-scan routing with empty activeTasks works; in-memory caches documented process-local; multi-instance watermark clobber = pre-existing #201 class); error paths (deleted user/null body/missing repository all fail closed; every GitHub call in ack/decline/postToUser individually try/caught); return-type widening (both callers safe); AC11 surface (pre-existing event arms untouched; new fields have no pre-existing consumers; all other channel-map iterations type-guard on slack); documented-accepted races confirmed as described (duplicate-task window; approve API can still flip max_mode/research-budget — edit mode specifically closed).
