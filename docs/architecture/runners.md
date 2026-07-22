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
    "baseUrl": "https://orchard.example.internal",
    "context": "production"
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
      "softnetAllow": ["10.0.0.0/8"],
      "readinessCommand": ["/usr/bin/xcodebuild", "-version"],
      "leaseTtlMinutes": 120,
      "debugTtlMinutes": 30,
      "maxDebugTtlMinutes": 120,
      "execTimeoutSeconds": 3600,
      "maxUploadBytes": 2147483648,
      "maxDownloadBytes": 1073741824
    }
  }
}
```

Images must use a `sha256` digest. Profile names and agent allowlists are fixed at startup. Orchard host directories, bridged networking, startup scripts, raw VM specifications, images, and credentials are never accepted from agents. Softnet uses a default-deny IPv4 block; an empty `softnetAllow` denies guest outbound traffic, while more-specific IPv4 CIDRs explicitly reopen required destinations.

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
- `runner_exec`: start an argv-based command in the synced primary repository.
- `runner_exec_poll`: reconnect and read output after the durable watermark.
- `runner_exec_cancel`: terminate a reconnectable command.
- `runner_collect`: download relative artifact paths.
- `runner_open_debug`: extend the lease within the configured cap and return credential-free Orchard context/VNC commands.
- `runner_release`: delete the lease immediately.

Command environment values are sent to Orchard for that exec only. They are not included in lease state, output logs, audit events, or tool responses.

## Persistence and Lifecycle

Runner state is stored atomically in `sessions/<task>/shared/runners.json`. Output is appended to `shared/runners/<lease>/exec/<exec>.jsonl`; collected artifacts go to `shared/artifacts/runners/<lease>/<collection>/`.

Startup reconciliation inspects persisted VMs, preserves reconnectable session watermarks, closes expired commands, retries releases, and deletes old instance-prefixed Orchard orphans. The minute reaper applies lease, command, and debug deadlines.

Task pauses and recovery stops preserve VMs. Terminal task completion deletes all leases except a still-valid debug lease. Graceful Archie shutdown leaves VMs intact for restart recovery. Release failures remain persisted as `releasing` and are retried by the reaper or next startup.

## Human Debugging

The developer configures the named Orchard context locally. `runner_open_debug` returns commands equivalent to:

```bash
orchard context default production
orchard vnc vm archie-prod-...
```

Archie does not proxy VNC or return Orchard credentials.

## Canary Validation

The opt-in Vitest case `src/runners/__tests__/orchard.e2e.test.ts` exercises a real Orchard deployment and is skipped by default. Run it with `ARCHIE_ORCHARD_E2E=true`, the normal runner configuration and credential variables, `ARCHIE_ORCHARD_E2E_PROFILE`, `ARCHIE_ORCHARD_E2E_AGENT`, and `ARCHIE_ORCHARD_E2E_REPO_PATH`. `ARCHIE_ORCHARD_E2E_COMMANDS` may contain a JSON array of argv arrays for an app-specific Xcode/Simulator/LLDB canary; defaults verify the Xcode, `simctl`, and LLDB toolchains. Use a disposable `ARCHIE_WORKDIR` because the harness writes its lease audit state there.

The canary provisions and syncs a real repository, runs every configured command, detaches and reconnects to a long command, validates the VNC handoff, releases the lease, and confirms Orchard deleted the VM.
