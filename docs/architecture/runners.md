# Tart Runners

## Purpose

Archie can use operator-managed Tart VMs through Orchard for workloads that cannot run on the Archie host, including Xcode builds, iOS Simulator automation, LLDB, and VNC debugging. The Claude agent remains on Archie; only commands and repository snapshots run remotely.

Runner support is opt-in. If `ARCHIE_RUNNERS_CONFIG` is absent, no runner subsystem or tools are loaded.

## Architecture

```text
Repository agent -> runner-tools -> RunnerManager -> Orchard -> Tart VM
                                      |              |
                                      |              +-- command output and VNC
                                      +-- runners.json, exec logs, artifacts
```

- `RunnerManager` owns profile policy, one lease per task-agent-profile, limits, persistence, recovery, and cleanup.
- `OrchardRunnerProvider` uses authenticated REST for VM lifecycle and reconnectable WebSockets for exec sessions.
- Repository files remain canonical in the local task clone. `runner_sync` sends tracked and unignored files without `.git` or ignored content.
- `runner_collect` validates requested paths and downloaded tar entries before extracting them under task artifacts.
- Mobile-specific build and debugging logic belongs in repository skills. Archie exposes only generic runner operations.

Runner ownership, capacity reservations, and operation locks are process-local. Run exactly one runner-enabled Archie process for each `instanceId` and workdir. Two processes sharing an `instanceId` can classify each other's VMs as orphans, while two processes sharing a workdir cannot coordinate in-memory locks. Horizontal runner scaling requires distinct instance IDs and stable task routing, or a future distributed lease and leader-election layer.

## Configuration

Set `ARCHIE_RUNNERS_CONFIG` to an operator-owned JSON file. The service account and guest passwords remain in environment variables.

```json
{
  "version": 1,
  "instanceId": "archie-prod",
  "maxConcurrent": 1,
  "orphanGraceMinutes": 30,
  "reaperIntervalSeconds": 60,
  "orchard": {
    "baseUrl": "https://orchard.example.internal/v1",
    "context": "production",
    "allowInsecureHttp": false
  },
  "profiles": {
    "ios-xcode-26": {
      "image": "ghcr.io/example/xcode@sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "os": "darwin",
      "cpu": 8,
      "memoryMiB": 16384,
      "diskGiB": 150,
      "username": "admin",
      "passwordEnv": "ORCHARD_IOS_GUEST_PASSWORD",
      "allowedAgents": ["mobile-agent"],
      "labels": { "pool": "ios" },
      "resources": { "org.cirruslabs.logical-cores": 8 },
      "networkMode": "softnet",
      "softnetAllow": ["192.168.2.0/24", "10.0.0.0/8"],
      "readinessCommand": ["/usr/bin/xcodebuild", "-version"],
      "leaseTtlMinutes": 120,
      "debugTtlMinutes": 30,
      "maxDebugTtlMinutes": 120,
      "execTimeoutSeconds": 3600,
      "maxActiveExecSessions": 4,
      "maxExecSessionHistory": 50,
      "maxUploadBytes": 2147483648,
      "maxDownloadBytes": 1073741824
    }
  }
}
```

`baseUrl` must include the Orchard API prefix (`/v1`) — the provider appends bare resource paths like `/vms` to it. HTTPS/WSS is required unless an isolated development config explicitly sets `allowInsecureHttp: true`; Basic credentials must not cross an unencrypted network. Images must use a `sha256` digest. Profile names and agent allowlists are fixed at startup. Orchard host directories, bridged networking, startup scripts, raw VM specifications, images, and credentials are never accepted from agents. Profile `labels` are required worker selectors, not descriptive VM metadata; every selected worker must advertise all of them or the VM remains unscheduled.

`networkMode` defaults to `softnet`. Softnet uses a default-deny IPv4 block; an empty `softnetAllow` denies guest outbound traffic, while more-specific IPv4 CIDRs explicitly reopen required destinations. `softnetAllow` MUST include the worker host's Softnet subnet (`192.168.2.0/24` by default) — the block-all rule also drops guest replies to the Softnet gateway, which the Orchard worker's SSH-based exec channel depends on. `networkMode: "nat"` omits Softnet entirely and requires an empty allowlist. NAT is an explicit unisolated lab escape hatch for a worker that cannot create Softnet; it is not a production substitute for default-deny networking.

When `NODE_ENV=production`, startup rejects insecure HTTP and every NAT runner profile. This makes the Softnet/HTTPS production boundary executable rather than relying only on deployment convention.

On macOS 15 and newer, deploy the Orchard worker using its supported privileged helper path: start `orchard worker run` as root with `--user <regular-host-user>`. Orchard starts the minimal local-network helper and then drops the worker to that user. An unprivileged background worker can create a NAT VM but macOS Local Network privacy may deny the worker's SSH/port-forward connections to it even when an interactive shell can reach the same guest.

Required environment variables when enabled:

- `ARCHIE_RUNNERS_CONFIG`: JSON configuration path.
- `ORCHARD_SERVICE_ACCOUNT_NAME`: Orchard Basic authentication name.
- `ORCHARD_SERVICE_ACCOUNT_TOKEN`: Orchard Basic authentication token.
- Every profile’s `passwordEnv`, such as `ORCHARD_IOS_GUEST_PASSWORD`.

Invalid configuration or missing secrets fails startup. Orchard unavailability during reconciliation marks `runners.degraded` in `/health` but does not take Archie offline.

## Agent Tools

Only repository agents named in a profile’s `allowedAgents` receive `runner-tools`. Explicit agent tool allowlists are augmented with the exact runner tool names.

- `runner_list_profiles`: list allowed profiles.
- `runner_ensure`: provision or reuse a lease.
- `runner_sync`: copy a declared repository snapshot into the VM.
- `runner_exec`: start an argv-based command in the synced primary repository with a caller-generated UUID `request_id`. Reusing that ID retries the start idempotently while its retained session exists.
- `runner_exec_poll`: reconnect and replay output after the last client delivery cursor.
- `runner_exec_cancel`: terminate a reconnectable command.
- `runner_collect`: download relative artifact paths.
- `runner_open_debug`: extend the lease within the configured cap and return credential-free Orchard context, VNC, and requested TCP port-forward commands.
- `runner_release`: delete the lease immediately.

Command environment values are sent through the exec WebSocket stdin bootstrap rather than URL query parameters. They are not included in lease state, output logs, audit events, proxy URLs, or tool responses; command output itself is persisted verbatim and must not print secrets.

## Persistence and Lifecycle

Runner state is stored atomically in `sessions/<task>/shared/runners.json`. Output is appended to `shared/runners/<lease>/exec/<exec>.jsonl`; collected artifacts go to `shared/artifacts/runners/<lease>/<collection>/`.

Exec uses two independent monotonic positions. The Orchard watermark records what Archie has durably received and may acknowledge to Orchard. The delivery cursor records what the tool client has received. Each JSONL record stores its ending delivery position; text advances the position by its encoded byte length, so a response can stop and resume inside one large provider frame without skipping the remainder. `runner_exec` returns the current cursor; later polls pass it as `after_cursor`. The client advances its saved cursor only after receiving a response and retries an uncertain poll with the previous value. This provides duplicate-safe, at-least-once output replay across Archie restart while the session remains in retained history. `hasMore` requires another poll, and `truncated` explicitly reports output discarded by the configured command-output limit.

The caller must generate one stable UUID per logical command and reuse it when a start result is uncertain. Archie fingerprints the repository, argv, working directory, and environment variable names and rejects reuse for a different command without persisting environment values. Idempotency and replay last for the configured terminal-session retention window; callers must not intentionally recycle request IDs.

Startup reconciliation inspects persisted VMs, recovers both reconnectable Orchard watermarks and client delivery cursors from JSONL, closes expired commands, retries releases, and deletes old instance-prefixed Orchard orphans. The minute reaper applies lease, command, and debug deadlines. Transfer reconnect is allowed only after Orchard confirms that the complete stdin bootstrap and EOF reached the remote session; a connection loss during upload fails the staged transfer instead of reconnecting a tar process with incomplete input.

Exec history retains a bounded number of terminal sessions and removes their JSONL logs. Active commands are also bounded per lease. Orchard WebSocket handshakes, buffered frames, command output, repository uploads, and artifact downloads all have explicit limits. Stdin is fragmented below Orchard's per-message limit. Transfers reconnect from their last acknowledged Orchard watermark when a subscriber drops before the terminal frame, and any replay gap fails the transfer instead of producing a corrupt repository or artifact. Persisted task, lease, exec, session, and backend ownership identifiers are validated before local log access or remote VM operations; one corrupt task state is isolated and reported as degraded without blocking recovery of other tasks.

Task pauses and recovery stops preserve VMs. Terminal task completion deletes all leases except a still-valid debug lease. Graceful Archie shutdown leaves VMs intact for restart recovery. Release failures remain persisted as `releasing` and are retried by the reaper or next startup.

## Human Debugging

The developer configures the named Orchard context locally. `runner_open_debug` returns commands equivalent to:

```bash
orchard context default production
orchard vnc vm archie-prod-...
```

Archie does not proxy VNC or return Orchard credentials.

### Simulator-only live video

Keep binary video out of `runner_exec`, whose durable output contract is textual. Install a pinned AXe release in the Tart image and let the repository-owned iOS workflow start `axe stream-video --format mjpeg` behind a bounded one-shot HTTP listener in the guest. The command emits a complete `multipart/x-mixed-replace` HTTP response. Pass the listener port in `runner_open_debug.ports`; the tool extends the lease and returns the ready-to-run forwarding command through the preconfigured Orchard context:

```bash
orchard port-forward vm archie-prod-... 18080:18080
```

Opening `http://127.0.0.1:18080` then shows the live Simulator-only MJPEG feed. VNC remains the zero-setup whole-VM fallback. The stream listener must bind only for the debug lease, accept a bounded number of clients, require a per-session token if exposed beyond localhost, and be terminated during task cleanup. Use `xcrun simctl io <udid> recordVideo --codec=h264 <path>` plus `runner_collect` when a durable MP4 artifact is required.

## Canary Validation

The opt-in Vitest case `src/runners/__tests__/orchard.e2e.test.ts` exercises a real Orchard deployment and is skipped by default. Run it with `ARCHIE_ORCHARD_E2E=true`, the normal runner configuration and credential variables, `ARCHIE_ORCHARD_E2E_PROFILE`, `ARCHIE_ORCHARD_E2E_AGENT`, and `ARCHIE_ORCHARD_E2E_REPO_PATH`. `ARCHIE_ORCHARD_E2E_COMMANDS` may contain a JSON array of argv arrays for an app-specific Xcode/Simulator/LLDB canary; defaults verify the Xcode, `simctl`, and LLDB toolchains. Use a disposable `ARCHIE_WORKDIR` because the harness writes its lease audit state there.

The canary provisions and syncs a real repository, runs every configured command, detaches and reconnects to a long command, validates the VNC handoff, releases the lease, and confirms Orchard deleted the VM.

`npm run runner:sweatcoin-e2e` is a compiled, manager-level live canary. It does not exercise task creation, agent spawning, MCP tool registration, or terminal-task cleanup, so it must not be described as a full Archie product-flow test. It requires `ARCHIE_SWEATCOIN_LIVE_E2E=true`, provisions a new lease without running global orphan reconciliation, and fails unless it can verify that its exact backend was deleted during cleanup.

Use a dedicated lab runner configuration and a clean, commit-exact fixture containing `swc.app.tgz`, `axe.tgz` with AXe's `libexec` directory, and the bounded one-shot `mjpeg_bridge.py`. In addition to the normal runner credentials, provide:

- `ARCHIE_SWEATCOIN_PROFILE`, `ARCHIE_SWEATCOIN_AGENT`, `ARCHIE_SWEATCOIN_FIXTURE_REPO`, `ARCHIE_SWEATCOIN_FIXTURE_COMMIT`, and `ARCHIE_SWEATCOIN_FIXTURE_GITHUB`.
- `ARCHIE_SWEATCOIN_APP_BUILD_REF`, `ARCHIE_SWEATCOIN_APP_SHA256`, `ARCHIE_SWEATCOIN_AXE_VERSION`, `ARCHIE_SWEATCOIN_AXE_SHA256`, and `ARCHIE_SWEATCOIN_BRIDGE_SHA256`.
- Exact `ARCHIE_SWEATCOIN_RUNTIME`; optional device, bundle, and expected-screen overrides use the other `ARCHIE_SWEATCOIN_*` variables defined in the checked harness.
- `ARCHIE_BUILD_COMMIT` in a production image without Git metadata and `ARCHIE_SWEATCOIN_ORCHARD_VERSION` for the evidence manifest.

The canary verifies fixture hashes in the guest; Simulator launch; screenshot dimensions; LLDB attach/backtrace/detach; H.264 MP4 structure and duration; MJPEG HTTP headers, multipart boundary, and complete frames; collected artifact hashes; and backend deletion. Set `ARCHIE_SWEATCOIN_ORCHARD_BIN` to exercise a host-side Orchard port forward and record that result in `evidence.json`. A positive `ARCHIE_SWEATCOIN_HOLD_SECONDS` is required before it creates and prints a live VNC/stream handoff; the debug TTL is aligned with the bounded hold.

A separate production-container E2E remains required to cover the real task → allowed agent → MCP tools → task completion path. That test must use an isolated `instanceId`, Orchard pool, workdir, and credentials.
