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
- [x] Separate Orchard receipt watermarks from client delivery cursors and make command start idempotent with caller-stable request IDs.
- [x] Validate a real Sweatcoin app launch, LLDB attach, MP4 recording, and live Simulator MJPEG stream inside a Tart VM on the TeamCity E2E host.
- [x] Run the generic Orchard canary and the complete Sweatcoin workflow through Archie on the TeamCity E2E host, including artifact collection and an externally forwarded live stream.
- [x] Add the SOTA comparison, full E2E flow, staged deployment, rollback, and ordered follow-up plan.
- [x] Decompose `RunnerManager` into explicit lifecycle, execution-session, and workspace/artifact boundaries without changing its public API or lock scope.
- [ ] Replace the isolated TeamCity lab dialer with Orchard's supported root `--user customer` helper before production-like deployment.

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

## 2026-08-19 Delivery Cursor Protocol

- `runner_exec` now requires a stable UUID `request_id`. Reusing it after an uncertain response reconnects to or replays the existing command instead of starting a duplicate. Reuse with different repository, argv, working directory, or environment variable names is rejected; environment values remain unpersisted.
- Every persisted exec record has a local ending delivery position independent of Orchard's history/ACK watermark. Text advances by encoded bytes, which lets polling resume inside a large provider frame without loss. `runner_exec_poll` requires `after_cursor`, responses return `cursor` and `hasMore`, and a client retries an uncertain response from its previous cursor.
- Startup recovers both positions from JSONL. Terminal sessions can replay output after restart, and older persisted state migrates with a zero delivery cursor.
- Added regressions for idempotent start, parameter mismatch, replay from zero, acknowledged empty replay, invalid future cursors, paginated stdout/stderr/exit delivery, legacy state migration, and post-restart replay without starting a second remote command.
- Added a regression that pages through one output record and resumes at its returned byte cursor without discarding the remainder.

## 2026-08-19 TeamCity E2E Tart Validation

- Targeted the idle `E2E 167-235-122-67` Apple Silicon TeamCity agent running macOS 26.5.2, Xcode 26.5, Tart 2.32.1, and a cached digest-pinned internal Xcode image.
- Installed and checksum-verified Orchard 0.56.1 in an isolated user directory. The release binary required an ad-hoc re-sign on this macOS build; the original verified binary remains preserved beside the working copy.
- Confirmed Orchard scheduling semantics against the 0.56.1 source: VM labels are required worker selectors. Removing unmatched lab labels allowed scheduling; explicit CPU, memory, and Tart slot resources fit the worker.
- Added an explicit `networkMode` profile setting. `softnet` remains the safe default; `nat` omits Softnet and is rejected if it also carries a Softnet allowlist. NAT allowed the unprivileged lab worker to start a VM, while readiness now stops immediately if a backend fails during probing.
- Confirmed the remaining host gate: macOS Local Network privacy denied the unprivileged background Orchard worker's guest SSH sockets even though the host's interactive SSH client could reach the guest. The official fix is a root-started worker with `--user customer`; this requires operator authority unavailable to the current session.
- Through the host's permitted SSH client, booted the actual Tart VM and verified Xcode 26.5 plus the iOS 26.5 Simulator runtime. Copied the already-tested `swc.app` build without reusing TeamCity secrets, created an iPhone 16 Simulator, installed and launched `swc`, and captured a real 1179×2556 screenshot.
- Attached LLDB to the live `swc` Simulator process, stopped it on the main thread, collected a five-frame backtrace, and detached cleanly. Recorded an H.264 launch video and copied the 1.4 MB MP4 to the local evidence directory.
- Installed the pinned AXe 1.8.0 bundle into the disposable VM and proved a Simulator-only live stream: a one-shot HTTP bridge returned `200 OK` with `multipart/x-mixed-replace`, delivering 1.2 MB and 27 JPEG frames in four seconds through a local port forward.
- Deleted the disposable VM, confirmed zero matching TeamCity VMs, removed host temporary files, and stopped the unauthenticated development Orchard daemon. No test VM or listener remains running.
- [ ] During initial host inspection, an unsafe process-argument listing exposed existing TeamCity-injected credentials in the tool log. Those credentials were not reused or copied into repository files. Rotation remains an explicit deployment gate; the target and this evidence set are not production-clean until an operator records completion.
- Reverified focused runner coverage (40 passed), typecheck, production build, `git diff --check`, and the complete suite (84 files passed, 2 skipped; 1,166 tests passed, 6 skipped).

## 2026-08-19 Archie-managed Sweatcoin E2E

- Added a reproducible Orchard 0.56.1 lab patch at `scripts/teamcity/orchard-0.56.1-external-netcat.patch`. Its explicit `--unsafe-external-netcat-dialer` development flag delegates each guest TCP connection to one macOS `/usr/bin/nc` process, allowing the unprivileged TeamCity account to cross the Local Network privacy boundary without sudo. The reviewed patch pins commit `1c241832f5710f68d395c91c414ca55afcb0468a`, waits for netcat's actual connection signal, keeps a returned connection independent of the dial context, forces the development controller onto loopback, and covers connection success, post-connect cancellation, refusal, deadlines, and idempotent close. `scripts/teamcity/build-orchard-lab.sh` applies and verifies it. This remains a lab transport, not a production substitute for Orchard's root-started helper.
- Deployed the lab build under a separate filename and data directory, preserving the checksum-verified official binary. The real Archie Orchard canary passed in 58 seconds: provision, readiness, repository sync, Xcode, Simulator and LLDB tool checks, detach/reconnect, debug handoff, release, and backend deletion.
- Fixed real transfer failures found by the canary. Archie now fragments stdin below Orchard's 32 KiB WebSocket message limit, reconnects a transfer session that loses its subscriber before the exit frame, and rejects Orchard watermark gaps instead of accepting corrupted output.
- Added `runner:sweatcoin-e2e`, an environment-driven manager-level live canary compiled into the production image. It requires an explicit destructive opt-in plus commit-exact, checksum-pinned app/AXe/bridge inputs and an exact runtime. It installs and launches `swc`, captures a screenshot and UI diagnostic, attaches LLDB, records an H.264 MP4, validates guest-local and optional host-forwarded MJPEG, validates collected artifacts, emits `evidence.json`, and fails if its backend cannot be deleted. It prints a human debug handoff only for a positive bounded hold. It does not claim to cover Archie's task/agent/MCP product path.
- Extended `runner_open_debug` with an optional validated `ports` list. It now returns ready-to-run Orchard TCP forwarding commands alongside VNC without returning Orchard credentials.
- The first TeamCity product run transferred a 140,718,592-byte fixture, launched `swc` in an iOS 26.5 Simulator, attached LLDB to the live arm64 Simulator process, captured an eight-frame main-thread backtrace, detached, recorded a 1,306,322-byte QuickTime/H.264 artifact, and collected a 1179×2556 PNG showing the Sweatcoin launch screen. Its external stream delivered 1,230,228 bytes and 27 JPEG frames in four seconds.
- The harness released its bounded debug lease successfully. Orchard and Tart both reported zero matching Archie VMs afterward; no stream listener or local forwarding process remained.
- Review hardening added a positive stdin-bootstrap acknowledgement before transfer reconnect, rejects unwatermarked Orchard output, enforces HTTPS plus Softnet in production, removes global orphan reconciliation from the live canary, aggregates cleanup failures, and verifies exact backend deletion. A first reviewed rerun caught a bridge-readiness race after successful launch, LLDB, and MP4 capture; its cleanup assertion still removed the VM. Replacing the fixed delay with bounded connection-refused retries removed the flake.
- The exact reviewed code and reviewed loopback-only lab binary then passed the complete TeamCity canary as task `task-20260819-2042-3augts`: 140,718,592-byte commit-exact fixture sync; real `swc` launch; LLDB attach/backtrace/detach; 833,011-byte 8.80-second H.264 MP4; 2,174,406-byte 1179×2556 PNG; guest MJPEG with 683,430 bytes and 15 complete frames; automatic host-forwarded MJPEG with 1,321,240 bytes and 29 complete frames; bounded VNC/port-forward handoff; artifact hashing and `evidence.json`; and verified backend deletion. Controller and Tart inventories were empty afterward, and the reviewed Orchard daemon plus SSH tunnel were stopped.
- Post-review verification passed: TypeScript typecheck, production build (including the compiled live canary), `git diff --check`, 42 focused runner tests, fresh application/build/test of the pinned Orchard patch, and the complete repository suite (85 files passed, 2 skipped; 1,175 tests passed, 6 skipped).

## 2026-08-19 RunnerManager Decomposition

- Reduced `src/runners/manager.ts` from 1,096 to 670 lines. It remains the public façade and sole owner of lease maps, keyed locks, global capacity reservation, provisioning/readiness, health, debug/release, and reconciliation policy.
- Added `src/runners/execution.ts` (457 lines) as the command-session state machine. It owns request validation and idempotency, persisted sessions, Orchard watermarks, client delivery cursors, output journals and bounds, polling, deadlines, close/cancel retry semantics, transfer reconnects, and history pruning.
- Added `src/runners/workspace.ts` (157 lines) as the repository/artifact I/O boundary. It owns collision-safe guest paths, staged repository replacement, streamed tar transfers, download bounds, artifact containment checks, extraction, and temporary-file cleanup.
- Kept every public `RunnerManager` signature unchanged and re-exported `runnerRepositoryPath` from its original module. All provider streams and mutable collaborator calls remain inside the existing task-agent-profile lock; global capacity reservation remains atomic under its separate lock.
- Consolidated the duplicated reconcile/reaper backend inspection and readiness ladder into `inspectLease` and `finishProvisioning`. Startup task/debug handling and periodic touch, pruning, TTL, and release ordering remain explicit at their call sites.
- Ran three independent simplification reviews before implementation, then three concurrent architecture, invariant, and minimalism reviews after implementation and again after fixes. The final reviews found no behavioral regression, dependency cycle, awkward ownership, or further warranted production-code split.
- Deferred mechanically splitting the 659-line façade-level manager test file. Its current integration tests intentionally exercise locks and delegation through the public API; moving them into collaborator-focused files is a non-blocking test-navigation cleanup.
- Final validation: `npm run typecheck`, `npm run build`, 46 focused runner tests, `git diff --check`, and the complete suite passed (85 files passed, 2 skipped; 1,175 tests passed, 6 skipped). `npm run lint` remains unavailable because `eslint` is not installed in this checkout.
