# Initiative refinement verification

Verified locally on 2026-10-21, on branch `codex/slack-initiative`, against published baseline `2f84ec6a47a39c0fc5d680ec935b1a8e095f9d8f`. The implementation remains uncommitted for independent review. The published baseline's passing CI validates only that baseline; the results below validate the local refinement.

The implementation manifest SHA-256 is **`5042d86c861a0df769d76016879780c0e45e575fa2b0395f7200cac042c22eee`**. It includes changed/new source, tests, SQL fixtures, tools and `.env.example`, including deleted paths and untracked new files. The local [manifest](../../e2e-evidence/refinement/implementation-manifest.json) lists each file and content hash. Its digest hashes UTF-8 compact, sorted-key JSON `{baseline,files}`, with files sorted by path and entries `{path,sha256}`; deleted files have `sha256:null`. The selected paths are baseline differences plus non-ignored untracked files under `src/` or `tools/`, and changed `.env.example`, `package.json` or `package-lock.json`. Documentation outside `src/` is excluded to avoid a self-referencing receipt. The handoff's full patch manifest also includes those documents.

## Change boundaries

| Boundary | Result |
|---|---|
| Knowledge memory | Observation merging/attachment was removed; knowledge tools and flags retain their own responsibilities. |
| Observation API | Independent task-bound search/read/matter tools under `proactivity/`; source authorization and validity are rechecked around asynchronous reads. |
| Persistence | One existing database, centralized schema 7 migrations, four focused operation groups and typed boundaries. SQL/handles stay inside persistence. |
| Scheduling | Deadline-aware next checks, authoritative snoozes, repaired transient coverage causes, canonical citation identity and bounded decision explanations. |
| Provider recovery | Durable request identities, supported list/result correlation, terminal execution-slot recovery and unresolved financial liability retained separately. |
| Start task | Owner-only version-bound approval; durable non-runnable preparation, one task identity and recovery through normal task execution/budgeting. |
| Outcomes | Waiting/parked execution stays separate from owner-acknowledged implemented/released/rejected outcomes. |
| Runtime | Normal routing and disabled behavior remain independent; shutdown drains admitted work and reads before SQLite closes. |

The pre-existing SPDX-header removal from `src/memory/observations.ts` is preserved in its relocated facade, `src/proactivity/api.ts`, whose header remains absent. Its original one-line patch is retained separately at [unrelated-header-removal.patch](../../e2e-evidence/refinement/unrelated-header-removal.patch). It was not silently undone by the source-header audit. Other new source files have the required header.

## Complexity check

Counts below compare local checkpoints using aggregate physical production TypeScript lines under `src/`, excluding tests, so file moves do not inflate the net change. They are size indicators, not a complexity score.

| Measure | Before bounded simplification | Final |
|---|---:|---:|
| Net production lines above published baseline | +1,494 | +1,373 |
| Storage helper classes | 6 | 4 |
| Helper methods, including private methods | 140 | 101 |
| Lines in those helpers | 620 | 489 |
| `InitiativeStore` lines | 566 | 583 |

The pass removed 121 production lines and 39 helper methods. Controls share attention operations; evaluation shares learning operations; duplicate policy/episode/source reads use the same boundary. Method arguments no longer expose `SQLInputValue`, and query results have explicit shapes rather than generic `Row`. Matters, observations, proposal intent, citation arrays, extraction parts, cohort manifests and prediction results cross relevant boundaries as typed values, with their database serialization owned by persistence.

This was more than moving files: cohort/prediction/label freezing, evaluation linking, policy activation/rebinding/outbox cancellation, reflection provenance and stop transitions became named atomic operations. Collection checkpoint/scan/gap completion and thread-refresh completion also became atomic, which accounts for the small increase in the central store. Fault-injection tests prove that failed freezing and activation do not leave partial records. The remaining central store owns the cross-domain source invalidation, allowance, delivery-admission and handoff invariants; splitting those transactions into per-table repositories would add coordination and weaken those boundaries. No new repository framework, database or runtime workload driver was added.

Deadline scheduling, duplicate-reminder identity and unchanged-analysis reuse now share the same named 15-minute preparation phase; the previous service/deduplication paths used different thresholds. The workload driver remains a development tool under `tools/` and is not imported by runtime code.

## Verification commands and results

Host: Node `v24.19.0`. Docker: `29.8.1`. Live Claude CLI: `2.1.281`. Raw local evidence is under the ignored `e2e-evidence/refinement/` directory.

```bash
NODE24=/Users/igorsova/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
"$NODE24" node_modules/typescript/bin/tsc --noEmit
"$NODE24" node_modules/typescript/bin/tsc
"$NODE24" node_modules/vitest/vitest.mjs run src/proactivity src/tasks/__tests__/prepared-start.test.ts src/tasks/__tests__/prepared-restart.test.ts src/tasks/__tests__/merge-approval.test.ts --reporter=dot
"$NODE24" node_modules/vitest/vitest.mjs run --reporter=dot
"$NODE24" --import tsx tools/initiative-workload.ts e2e-evidence/refinement/workload-final.json
git diff --check
```

| Check | Result / evidence |
|---|---|
| Typecheck and build | Passed; a clean `dist/` rebuild also passed. [Typecheck](../../e2e-evidence/refinement/typecheck.log), [clean build](../../e2e-evidence/refinement/build-clean.log). |
| Focused behavior suites | 160 tests in 15 suites passed, including source, accounting, memory separation, handoff, migration and task restart tests. [Focused log](../../e2e-evidence/refinement/focused.log). |
| Final integrated suite | **2,148 tests in 155 suites passed** with the temporary E2E credential file removed. Existing API fixtures required loopback access. [Full log](../../e2e-evidence/refinement/full-suite-final.log). |
| Compiled disabled boundary | Compiled `dist/proactivity/index.js` loaded and initialized with initiative off. |
| Formatting/SQL boundary | `git diff --check` passed. SQL/schema creation and database handles are confined to `store.ts`/`persistence/`, apart from purpose-built fixture/test inspection. |
| Baseline regression reproduction | All four retained review probes failed before the fixes, then passed in the maintained suite. [Baseline failures](../../e2e-evidence/refinement/baseline-regressions.log). |
| Live integration | Fresh isolated harness boot, egress and tool-gate checks passed on the final runtime code. [Boot](../../e2e-evidence/refinement/boot-final.log), [egress](../../e2e-evidence/refinement/egress-final.log), [tool gate](../../e2e-evidence/refinement/tool-gate-final.log). |
| Cleanup | Harness teardown confirmed no project containers remained; the temporary mode-600 `.env` containing only the approved test key and isolated settings was removed. [Teardown](../../e2e-evidence/refinement/teardown-final.log). |

The repository's existing lint command has no installed/configured ESLint dependency; this verification does not claim a lint pass. No dependencies were added to repair that unrelated tooling gap.

### Migration and crash evidence

The v4 SQL fixture represents published core and lazy provider/learning tables. Tests preserve source IDs/text, FTS lookup, watermark, job token/generation/attempts, outstanding money, provider ID, pending delivery, feedback, policies and proposal evidence through v7; a second open is idempotent. Read-only opens neither upgrade nor mutate. A conflicting upgrade rolls back schema and data, and team/owner/future-version mismatches are rejected.

Real separate Node processes exit immediately after the first task metadata rename and after the ready transition before enqueue. The first record already contains destination, brief and approval identity while `preparing`; startup cannot run it. Subsequent processes reuse the identity, and startup can recover the ready task. Separate SQLite handoff tests cover concurrent clicks, reopen after preparation, lost activation acknowledgement, changed sources, transient source failure and distinct waiting/outcome states. These tests use fake SDK/Slack boundaries and do not claim a real Slack callback or feature implementation.

Provider tests cover a lost create response and a real process exit during submission, retaining the durable `custom_id` and financial reservation before recovery through a fake provider's supported listing/results interface. Pagination, incomplete/running scans, changed provider binding, missing terminal results, operator reconciliation and complete usage settlement are exercised. Slot recovery never refunds unknown usage or resubmits a possibly running semantic step. The mechanism was checked against the installed Anthropic SDK and [primary batch API documentation](https://platform.claude.com/docs/en/build-with-claude/batch-processing); actual remote lost-response faults were not injected.

## Declared workload

The [driver](../../tools/initiative-workload.ts) runs real SQLite, collection, gateway admission, extraction, investigation and owner recall through normalized service intake. Slack and provider execution are fake with zero network latency. It excludes Bolt's transport queue. The envelope is 40 public channels × 6 threads, including 8 threads with 226 messages, 10 edited roots, 40-message pagination and 481 minute ticks over 8 virtual hours in shadow mode.

| Measurement | Final result |
|---|---:|
| Events accepted / awaiting processed generation | 3,210 / 0 |
| Event → processed thread generation, median / p95 / maximum | 3,575,980 / 4,259,975 / 4,440,000 ms |
| Known due-check lateness, median / p95 / maximum | 0 / 60,000 / 60,000 ms |
| Slack adapter calls: inspect / page / channel listing | 7,285 / 1,921 / 1 |
| Model admissions | 274 |
| Serialized model request bytes, total / p95 / maximum | 4,192,690 / 23,063 / 23,797 |
| Unchanged final two hours: model calls / new revisions | 0 / 0 |
| Owner recall: hits / matching-source checks | 10 / 2 |
| Jobs: peak / peak due / final / final due / deferred | 254 / 208 / 86 / 0 / 0 |
| Revisions / valid observations | 3,210 / 240 |
| Raw UTF-8 / database / WAL bytes | 1,857,576 / 6,012,928 / 4,169,472 |
| Synthetic ledger: unresolved maximum / settled microdollars | 0 / 1,047,296 |

The valid pre-optimization receipt admitted 642 model requests, including 80 in unchanged hours, and checked all 40 sources for an owner query. Batching by channel, matching-source recall and source-validated analysis signatures account for the measured reduction to 274 admissions and no idle model work. [Before](../../e2e-evidence/refinement/workload-before-recall.json), [final](../../e2e-evidence/refinement/workload-final.json).

The serialized bytes and adapter call counts are measurements of this fixture. They are not underlying Slack HTTP counts, which also include membership checks and adapter-internal calls. Provider usage in the fixture is estimated as serialized bytes/4 and then priced through the real gateway: **1,047,296 microdollars is synthetic accounting, not paid spend, an invoice estimate or a usefulness result**. A separate pressure fixture uses real reservation admission with synthetic prior liability: routine work defers at $150, priority admission remains available, and priority work defers at exactly $200. No automatic pause is triggered.

The burst creates a backlog of 208 due jobs and up to 74 minutes to initial processing. Known due checks stay within one tick only after a matter has been extracted. Longer-thread omissions remain visible coverage gaps; processed generation does not mean every message was understood. This establishes the tested envelope and its backlog, not a maximum production throughput or freshness guarantee. Live Slack latency, rate limits, larger workspaces and useful-delivery pressure remain unmeasured.

## Remaining live limits

The live harness used paid Anthropic requests with initiative disabled and no Slack/GitHub credentials. It proved allowlisted egress works, other egress is blocked, package installation/proxy setup works, the gated mutation stays blocked before approval, the read-only tool passes ungated and the approved mutation executes once. No live initiative activation or real Start task button callback was performed. No real provider lost-ID fault, forward human usefulness evaluation, production notification or remote repository action was performed.

Stale preparation remains inert; it needs a new proposal identity or the ordinary mention workflow rather than reviving its old approval. Genuinely ambiguous provider records retain financial exposure and may need operator evidence. Outcome acknowledgements require the owner's artifact URL and acceptance text, but do not independently inspect that artifact. These are explicit boundaries of the delivered implementation. Independent correctness review is still pending; this receipt is implementation verification, not that review.
