# Tart Runner Implementation Tracker

## Scope

Implement opt-in Tart VM runners through Orchard. Archie remains the control plane and exposes only generic runner tools to explicitly allowed repository agents. OpenSpec is not used.

## Progress

- [x] Confirm repository baseline and lifecycle integration points.
- [x] Verify the current Orchard VM and reconnectable exec API.
- [x] Add runner configuration and validation.
- [x] Add Orchard provider and WebSocket execution transport.
- [x] Add lease persistence, recovery, cleanup, and health reporting.
- [x] Add safe repository sync and artifact collection.
- [x] Add generic runner MCP tools and agent allowlist integration.
- [x] Release task runners on terminal completion while preserving paused tasks.
- [x] Add unit, contract, and opt-in real-Orchard tests.
- [x] Add architecture and deployment documentation.
- [x] Run typecheck, build, full tests, and diff validation.
- [x] Rebase the feature branch onto current `origin/main` and preserve a local safety branch.
- [x] Harden provisioning, readiness, cleanup, WebSocket, persistence, capacity, output, archive, and deployment failure paths after review.
- [x] Add the SOTA comparison, full E2E flow, staged deployment, rollback, and ordered follow-up plan.
- [ ] Run the expanded opt-in canary against the production Orchard/Xcode pool.

## Decisions

- Tart/Orchard only; container runners are out of scope.
- One lease per task, agent, and profile.
- Repository contents remain canonical on the Archie host and are copied into disposable VMs.
- Human GUI debugging uses a preconfigured local Orchard CLI context and a bounded VNC lease.
- Mobile-specific Xcode, Simulator, and LLDB workflows stay in repository-owned skills and call Archie’s generic runner tools.
- Runner credentials, guest passwords, and command environment values are never persisted.

## Validation Log

- Baseline: `docs/proposals/runner-host-architecture.md` was already untracked; no existing tracked files were modified before implementation.
- Orchard API verified against the current official `api/openapi.yaml`: VM CRUD, reconnectable WebSocket exec sessions, history watermarks, acknowledgements, detach, close, and VNC-compatible VM naming are available.
- Added `ws`, `tar`, and `@types/ws` dependencies.
- Added strict operator configuration, digest-pinned images, repository-agent allowlists, default-deny Softnet policy, environment-only secrets, and startup validation.
- Added Orchard VM CRUD, Basic authentication, argv-safe WebSocket exec, streamed stdin, history replay, durable watermark acknowledgements, detach, cancellation, and bounded payloads.
- Added atomic task lease state, watermark-indexed output logs, restart reconciliation, orphan cleanup, TTL/debug reaping, degraded health, and completion cleanup.
- Added filtered git snapshot upload, staged remote replacement, bounded artifact download, and traversal/link/type validation.
- Added nine generic `runner-tools` only for allowed repository agents, including explicit SDK tool-allowlist augmentation.
- Added architecture, persistence, agent, deployment, environment, and canary documentation.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: passed, 846 tests; the credentialed real-Orchard canary is skipped by default.
- `git diff --check`: passed.
- `npm run lint`: unavailable because the repository declares the script but has no ESLint dependency or configuration; CI does not run lint.

## 2026-08-17 Rebase and Hardening

- Rebasing started from remote Draft PR commit `c3ce1f`, preserved the prior local state as `codex/tart-runner-host-local-backup`, and replayed the runner commits onto `origin/main` at `8fa4dea` without changing remote state.
- Investigated Draft PR #233. Typecheck, build, tests, gitleaks, and CodeQL analysis passed; the separate GitHub Advanced Security gate reported two high-severity JavaScript path-injection alerts in artifact extraction. Added canonical task and UUID validation plus lexical and realpath containment barriers at the reported sinks.
- Failed provisioning and readiness now release the backend immediately, preserve retryable `releasing` state on delete failure, and cannot be promoted to ready after restart without readiness succeeding.
- Reconciliation handles terminal tasks, provisioning deadlines, missing or failed backends, removed profiles, per-task corrupt state, per-lease errors, and orphan ownership without starving later leases.
- Reaping is non-overlapping and serialized with lease operations. Debug expiry is clamped correctly after task completion, and the reaper retries releases before consulting a removed profile.
- Exec now limits active and retained sessions, removes old logs, bounds Orchard frame queues and handshakes, caps provider error output, closes remote commands before terminalizing local state, and treats close 404 as idempotent success.
- Command environment values moved from WebSocket query parameters to a bounded stdin bootstrap that completes before detach. HTTP Orchard endpoints require an explicit development-only opt-in.
- Repository guest paths include a stable hash to avoid normalization collisions. Artifact collection handles asynchronous write failures and validates every extraction root before filesystem mutation.
- The production systemd example now mounts the runner config read-only, exposes a runner-specific health probe, documents the single-controller constraint, and gives a safe rollback cleanup order.
- Added focused regression coverage for concurrent capacity, failed readiness cleanup, provisioning recovery, active/history bounds, oversized errors, corrupt state isolation, 404 close, private environment detach, handshake timeout, and archive containment.
- Stabilized two pre-existing full-suite races exposed by the rebased test load: task-list rendering now has a suite-appropriate timeout, and memory extraction teardown waits for the asynchronous pending queue to drain before removing its temporary directory. The full Vitest default is 15 seconds; the known slower task-list suite uses 30 seconds.
- Reverified with bundled Node.js 24.19: runner and tool-contract tests passed (41 passed, 1 skipped), typecheck passed, build passed, the exact disabled/invalid/valid configuration smoke matrix passed (4 of 4), and the complete suite passed (84 files passed, 2 skipped; 1,157 tests passed, 6 skipped).
- Built `Dockerfile.prod` successfully as `archie-hq:tart-runner-verify` (`sha256:8a7f61036cfddaf73513e649a2c515a1699113e9142752f23941556633aa3162`). The runtime dependency audit still reports 8 advisories, including 6 high-severity transitive advisories; dependency remediation is a deployment gate, not part of the runner change.
- The disabled Docker Compose boot was not run because the required local `.env`, `workdir`, and `claude-data` fixtures are absent. The credentialed real-Orchard canary was not run because it requires an explicit request and live credentials.
- Remaining production blockers and the complete rollout sequence are tracked in [Tart Runner Rollout Plan](20260817-tart-runner-rollout.md).
