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
- [ ] Run the opt-in canary against the production Orchard/Xcode pool.

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
