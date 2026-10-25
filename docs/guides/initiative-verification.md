# Initiative verification and limits

Verification must distinguish local correctness, simulated capacity, live delivery and usefulness. A passing test or a parked task does not establish that a feature shipped. The subsystem stays off by default; merge, activation, paid model calls and live Slack checks require their own authorization.

## Local checks

Use Node 24+ and installed dependencies:

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc
node node_modules/vitest/vitest.mjs run src/proactivity src/tasks/__tests__/prepared-start.test.ts src/tasks/__tests__/prepared-restart.test.ts src/tasks/__tests__/merge-approval.test.ts --reporter=dot
node node_modules/vitest/vitest.mjs run --reporter=dot
node --import tsx tools/initiative-workload.ts /tmp/initiative-workload.json
git diff --check
```

The focused tests cover collection through investigation, suggestion, owner approval and normal task start with simulated Slack/provider boundaries. Retain the exact 2026-10-27 17:00 Europe/Lisbon deadline, both DST transitions, invalid/ambiguous/no-deadline cases, paraphrased pending/approved suggestions, citation order, new evidence/work, obsolete counts and inert approval recovery. Keep discriminating checks for source/audience changes, inactivity and shortened deadlines, controls, duplicate and uncertain sends, cancelled-card recovery, fixed private replies, confirmed initial reply, consumed-card races/restart, fresh-schema initialization/reopen, rejection of unsupported databases and unresolved direct-request charges. Invalid operator commands must not open state for writing.

The workload driver is a local simulation with fake sources, models and time. It measures queue progress, idle work, request admission and spending limits; it makes no paid calls. Re-run it when changing scheduling, extraction, admission or retention. Check the exact revision and preserve its output alongside test results.

## Existing evidence

At starting revision `189bbc29b89d85fa679345fd4957ce9f6dd174bf`, local provider/accounting checks and GitHub typecheck, build, all 2,177 tests and CodeQL passed. Those results validate that revision. A later patch needs its own checks. The previous detailed refinement receipt remains in [Git history](https://github.com/sweatco/archie-hq/blob/189bbc29b89d85fa679345fd4957ce9f6dd174bf/docs/guides/initiative-verification.md); its local artifact paths and then-pending review statements describe that earlier run.

The correction review recorded 274 simulated model calls, zero idle calls, at most 60 seconds of lateness for already known due checks and a 74-minute initial burst delay. Matters cannot receive deadline-aware checks before extraction identifies them. These are tested capacity limits, not production throughput or freshness guarantees. Live latency, rate limits and useful-delivery pressure remain unmeasured.

On 2026-10-25, a genuine source, owner Start click and authenticated replay on frozen patch `f8e1754e2d2e24cd66719e7509d53332d49a9b991d264c2b24308eb99236d125` produced one completed read-only task and exact private ACK. That run also exposed a one-hour deadline conversion error, duplicate paraphrased candidates and an approved proposal still counted as awaiting approval. A real model recheck chose private help; the public reply was a labelled transport-only fixture. The failed-baseline receipts remain preserved. Those live observations do not establish behavior on this corrected patch or organic multi-day usefulness.

A scoped public-follow-up retest must use a fresh authenticated unresolved source, ordinary model extraction/investigation and actual source-thread delivery. Injected later clocks and deferred unrelated jobs must be labelled. Do not force `public=true`, repeatedly sample until it passes, or claim a seeded outbox proves the decision path. Retain actual model outcomes, usage, exact source/patch identity and cleanup in a separate receipt.

Unknown direct-request usage retains its financial liability and may need external evidence. Previous unshipped schemas, including the schema-10 test baseline, are rejected unchanged; the base has no migration, learning or batch-recovery path. Keep archived databases with their original binaries and evidence.

On 2026-10-25, the owner confirmed this feature had not run in another persistent installation and approved dropping experimental-state compatibility. Archived test databases remain unchanged. Schema 11 starts fresh; schema 1–10 upgrades and optional-learner rollback are no longer supported. Previously closed batch-discovery findings are outside this release because it has neither batch storage nor provider batch APIs. Current source, spending, delivery and task-recovery checks still apply.
