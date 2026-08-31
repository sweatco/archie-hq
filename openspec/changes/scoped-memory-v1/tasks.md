## 1. Scope and Store Foundation

- [x] 1.1 Add task memory scope/internal-author metadata, strict conversation/member/DM classification, and monotone scope composition with focused tests, including Slack Connect and restricted guests
- [x] 1.2 Add workspace-bound scoped paths, marker initialization, runtime readiness, and legacy/mismatch fail-closed tests
- [x] 1.3 Move initialization after Slack authentication without changing task recovery or trigger startup behavior
- [x] 1.4 Run focused tests and an adversarial working-tree review; fix every confirmed cycle-1 issue

## 2. Scoped Extraction

- [x] 2.1 Relocate the rich corpus and pending queue under public/runtime paths without adding migration logic
- [x] 2.2 Replace transcript-derived profile authorization with structured Slack authors for extraction and prompt injection
- [x] 2.3 Implement public full extraction plus internal private-channel/DM summary-only rolling outcomes with atomic dedupe/trim; outsider-visible and mixed tasks write nothing
- [x] 2.4 Reject secret/instruction-shaped task and activity summaries without unsafe fallback writes
- [x] 2.5 Run focused tests and an adversarial working-tree review; fix every confirmed cycle-2 issue

## 3. Read-Only Memory Tools

- [x] 3.1 Implement deterministic scoped search and safe public entity/task-summary readers without duplicate public channel projections
- [x] 3.2 Reauthorize private reads live, validate internal DM partners/current channel membership, and disable all memory for outsider-visible transitions
- [x] 3.3 Register the three-tool MCP server behind the default-off tools flag for every agent track
- [x] 3.4 Add envelope, traversal, stale-scope, locality, dedupe, and ranking tests
- [x] 3.5 Run focused tests and an adversarial working-tree review; fix every confirmed cycle-3 issue

## 4. Integration, Documentation, and Live Verification

- [x] 4.1 Update environment examples, memory architecture/security docs, operator wipe/rollback instructions, and make standalone housekeeping refuse scoped stores
- [x] 4.2 Run all focused tests, full test suite, typecheck, lint, and build (lint is recorded as unavailable because the repository does not declare or install `eslint`)
- [x] 4.3 Run a final adversarial branch review and fix every confirmed issue without widening scope
- [x] 4.4 Boot `archie-e2e` with a fresh test-only memory bind mount while preserving the symlinked host `workdir`; record before/after proof that host memory is unchanged
- [x] 4.5 Run the Hookdeck/Slack scenarios in `verification.md` against `#archie-test-channel` and the named private/DM fixtures, capturing validated evidence for each case
- [x] 4.6 Verify internal public recall, private isolation, DM isolation, scheduled-trigger continuity, outsider-visible no-memory behavior, tools-off behavior, and fail-closed Slack lookup behavior from runtime evidence
- [x] 4.7 Record final evidence and reconcile every OpenSpec task and requirement
- [x] 4.8 Apply iteration-2 confirmed adversarial findings, run final gates, and complete the fresh post-review live regression
- [x] 4.9 Flatten private outcome storage under `private/channels/<id>.md` and `private/users/<id>.md`, update the active contract, and rerun affected gates
