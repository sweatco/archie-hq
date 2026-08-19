# Tart Runner Rollout Plan

## TL;DR

Keep Tart and Orchard as Archie's primary interactive macOS backend. Their VM lifecycle, reconnectable exec, OCI image, VNC, and Softnet model matches the generic runner API already implemented. Use a managed macOS CI service as an independent build/test baseline and Xcode Cloud as the signing, TestFlight, and release-validation lane. Do not expose runners to production agents until the protocol-level integration harness, real app/Simulator/LLDB canary, durable output-delivery contract, drain controls, and runner telemetry are complete.

## Platform Decision

| Option | Role | Decision |
| --- | --- | --- |
| [Tart](https://github.com/openai/tart/releases) + [Orchard](https://github.com/openai/orchard/releases) | Interactive, task-scoped macOS VMs with custom images, reconnectable commands, and VNC | Primary backend. It is the closest fit to Archie's control-plane model and remains actively maintained by OpenAI. |
| [Anka Build Cloud](https://docs.veertu.com/anka/anka-build-cloud/release-notes/) | Enterprise macOS virtualization with support and mature control-plane features | Preferred enterprise alternative if Orchard's single-controller design or support model becomes limiting. Requires a new provider adapter. |
| [Orka](https://docs.macstadium.com/orka/orka-overview/orka-overview) | Kubernetes-native Mac fleet orchestration with HA and managed/on-prem options | Strong alternative for an organization already committed to Kubernetes or MacStadium. Higher platform complexity than Orchard. |
| [WarpBuild](https://www.warpbuild.com/docs/ci/cloud-runners), [Buildkite hosted macOS](https://buildkite.com/docs/agent/buildkite-hosted/macos), or [GitHub-hosted macOS](https://docs.github.com/en/actions/reference/runners/larger-runners) | Managed ephemeral macOS CI | Independent CI baseline and overflow path, not a replacement for Archie's arbitrary interactive exec, durable lease, or VNC workflow. Benchmark with the actual iOS repository before choosing one. |
| [Xcode Cloud](https://developer.apple.com/documentation/xcode/xcode-cloud) | Apple-native build, test, archive, signing, and TestFlight distribution | Independent release oracle. Keep signing and distribution out of the interactive Archie VM path. |
| Docker/container runner | Linux builds and tools | Future separate backend. It cannot provide Xcode or iOS Simulator workloads, so it does not unlock the target workflow. |

Cirrus Runners is not available to new customers and Cirrus CI shut down on June 1, 2026. BuildJet stopped running jobs on March 31, 2026. Neither belongs in the shortlist: [Cirrus Labs notice](https://cirruslabs.org/), [BuildJet shutdown notice](https://buildjet.com/for-github-actions/blog/we-are-shutting-down).

## Resolved Protocol Decision

Archie now separates Orchard receipt acknowledgement from client delivery. Each logical command has a caller-stable UUID request ID, each persisted JSONL event has an independent delivery cursor, and poll requests replay after the last cursor the client actually received. Retrying an uncertain start with the same request ID cannot create a second command while the retained session exists; retrying an uncertain poll with the previous cursor may duplicate output but cannot silently skip it. Restart recovery rebuilds both cursor positions from the log. The remaining fake-Orchard and real-lab gates must prove this contract under forced crashes before production rollout.

## Production Blockers

- Add a stateful fake-Orchard REST and WebSocket integration server. It must exercise VM CRUD, pending/running/failed transitions, history replay, ACK, detach, close, VNC naming, 404 close, authentication, connection loss, bounded queues, and Archie restart.
- Replace the toolchain-only canary with a deterministic fixture app that proves build, test, Simulator boot/install/launch, UI state, screenshot capture, crash logs, LLDB attach/breakpoint/evaluation, artifact collection, and teardown.
- Add runner admission and drain controls plus an operator inventory endpoint or command. Rollback currently depends on manual coordination because disabling the config also disables reconciliation.
- Export runner metrics and alerts: provisioning latency/failure, active and queued capacity, exec reconnects/timeouts, output truncation, release retries, orphan count, image pull time, VM age, and controller degraded reasons.
- Prove the single-controller deployment invariant. Run exactly one Archie runner controller per `instanceId` and workdir until distributed leases and leader election exist.
- Install the Orchard worker as root with `--user <host-user>` on macOS 15+ so its privileged local-network helper can reach Tart guests after the worker drops privileges. The TeamCity lab passed the full canary with the isolated external-netcat development patch, but that workaround is deliberately excluded from staging and production.
- Remediate the current production dependency audit before deployment. The verified production image reports 8 runtime advisories, including 6 high-severity transitive advisories; update the dependency graph, review the resulting lockfile, and rerun the complete suite, container build, audit, and image scan.

## Test Strategy

### Pull Request Gates

1. Run schema, provider, manager, transfer, persistence, tool-contract, typecheck, build, and production-container tests.
2. Run the stateful fake-Orchard integration with deterministic fault injection at every lifecycle boundary.
3. Start Archie with runners disabled and verify no runner tools, config reads, network calls, or state mutations occur.
4. Start Archie with runners enabled in the production container layout and a mounted read-only configuration file.
5. Treat CodeQL, secret scanning, dependency audit, and archive/path traversal tests as blocking.

### Stateful Fake-Orchard Scenarios

- Concurrent tasks race for the final capacity slot; exactly one reservation wins.
- Provision remains pending, becomes running, fails, disappears, exceeds its deadline, and passes or fails readiness.
- Exec emits stdout, stderr, error, exit, malformed frames, oversized frames, delayed handshakes, disconnects, and close 404/503 responses.
- Archie is killed after VM creation, each persisted output frame, task completion, and release-state persistence; restart must reconcile without capacity leaks or unsafe deletion, and retrying with the last client cursor may duplicate but never skip output.
- One corrupt task state and one permanent release failure must not block healthy task recovery or later reaper work.
- Repository names that normalize identically remain isolated, archive links cannot escape, disk-write errors degrade safely, and secret values never appear in URLs, logs, state, events, or tool output unless the remote command itself prints them.

### Real Lab Canary

Use a dependency-free fixture repository with a small iOS app and XCTest target. The app must expose a nonce through an accessibility label, include a known LLDB symbol, and contain an opt-in deliberate crash path. Include filenames with spaces and Unicode, ignored files, safe and unsafe symlinks, and an oversize artifact fixture.

1. Boot Archie with runners disabled and verify the feature remains inert.
2. Boot the production container with the runner config and credentials mounted exactly as production will use them.
3. Provision a digest-pinned VM and assert the exact image, resources, labels, Softnet policy, and readiness command seen by Orchard.
4. Sync the fixture and verify the remote file manifest and hashes, including exclusions.
5. Run `xcodebuild build`, unit tests, and UI tests; collect the result bundle and derived logs.
6. Create and boot a named Simulator, install and launch the app, assert the nonce through XCTest or an accessibility driver, and collect a screenshot.
7. Attach LLDB to the launched app, stop at the known symbol, evaluate the nonce, continue, trigger the deliberate crash, and collect the crash report.
8. Start a long command with a stable request ID, detach, kill Archie with `SIGKILL`, restart it, retry once with the pre-crash cursor, and verify ordered at-least-once replay with no gaps or duplicate remote command.
9. Collect `.xcresult`, screenshots, unified logs, crash logs, and a bounded archive through `runner_collect`.
10. Exercise bounded VNC access without returning Orchard credentials.
11. Complete and explicitly release tasks, then assert zero matching VMs and zero stale active sessions in Orchard.

Run the lab canary on every runner-controller or image change and as a nightly synthetic. Run 50 clean cycles plus at least 20 forced-restart cycles before staging promotion.

## Image Pipeline

1. Build golden Tart images with [Packer](https://tart.run/integrations/packer/) from a reviewed base.
2. Install a pinned Xcode, required Simulator runtimes, LLDB helpers, test automation, certificates needed only for non-distribution development, and observability agents.
3. Produce an SBOM and vulnerability report, run the full lab canary, then push the image to an OCI registry.
4. Resolve and record the immutable digest in the Archie runner profile. Never deploy a mutable tag.
5. Promote the same digest through candidate, canary, staging, and production. Pre-pull it to every worker and keep the previous known-good digest available for rollback.
6. Keep App Store distribution credentials and production signing in Xcode Cloud or a dedicated release system, not in general interactive images.
7. Install and pin AXe in interactive iOS images. Validate its Simulator-only MJPEG stream and retain `simctl recordVideo` as the durable artifact path.

## Deployment Sequence

### Lab

- One Orchard controller, one Apple Silicon worker, one Archie instance, one profile, one agent, and `maxConcurrent: 1`.
- Back up Orchard's `ORCHARD_HOME`, ship Orchard OpenTelemetry metrics, and monitor Archie `/health/runners`.
- Complete the real canary cycles and rehearse controller restore, worker loss, image rollback, and orphan cleanup.

### Staging

- Use production networking and secret injection with isolated credentials, workdir, `instanceId`, Orchard project/pool, and image profile.
- Run continuously for at least 72 hours with the nightly synthetic and forced Archie/controller/worker restart tests.
- Set initial SLOs from measured data: provisioning success, p95 time-to-ready, command completion/reconnect success, cleanup success, and orphan-free task completion.

### Production

- Deploy the Archie build with runner config absent for 24 hours to prove no regression in the disabled path.
- Mount the config, enable one synthetic agent and one slot for 48 hours, then pilot one mobile team.
- Increase capacity one slot at a time only after host CPU, memory pressure, image-pull latency, Simulator reliability, failure rate, and cleanup SLOs remain healthy.
- Keep managed macOS CI and Xcode Cloud green as independent comparison lanes during the pilot.

## Rollback

1. Stop admission of new runner work and let safe in-flight work finish or explicitly cancel it.
2. Inventory Archie leases and all `archie-<instanceId>-*` Orchard VMs.
3. Release leases, retry failed deletions, and confirm zero owned VMs and sessions.
4. Restore the previous Archie image and previous digest-pinned Tart profile.
5. Remove `ARCHIE_RUNNERS_CONFIG` only after cleanup; otherwise Archie no longer reconciles the outstanding VMs.
6. If Orchard itself is unhealthy, preserve its data directory for diagnosis, delete owned VMs from recovered Orchard or workers, and route required builds to the managed CI fallback.

## Ordered Next Work

1. Build the stateful fake-Orchard integration harness and production-container test.
2. Add admission, drain, inventory, and forced-cleanup operations with audit events.
3. Create the fixture iOS app and automate the full Simulator, LLDB, artifact, VNC, cursor-replay, and restart canary.
4. Add runner metrics, dashboards, alerts, and operator runbooks.
5. Automate Packer image creation, digest promotion, pre-pull, and rollback.
6. Remediate the production dependency audit and prove the rebuilt image is clean enough for the agreed deployment policy.
7. Execute lab and staging soak gates before the one-team production pilot.
