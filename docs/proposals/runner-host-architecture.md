# Runner Host Architecture for Containers and Tart VMs

## TL;DR

This is feasible. Archie should remain the control plane, use Orchard for Tart VM scheduling, and use a restricted runner daemon for containers. Xcode, Simulator, and LLDB should run inside Tart VMs. The Claude agent process should remain on the Archie host initially.

## Recommended Architecture

```text
Archie -> RunnerManager -> Container runner
                       \-> Orchard -> Apple Silicon hosts -> Tart VM
```

- Archie owns policy, leases, task association, persistence, and cleanup.
- Orchard owns Mac-host discovery, capacity scheduling, Tart lifecycle, execution, and SSH/VNC forwarding.
- A small `archie-runnerd` service owns rootless container lifecycle. Docker is never exposed directly to agents.

Orchard already provides resource-aware scheduling, VM creation, port forwarding, and a reconnectable WebSocket exec API with buffered output and watermarks. Custom Tart orchestration would duplicate it.

References:

- [Orchard API](https://github.com/openai/orchard/blob/main/api/openapi.yaml)
- [Orchard repository](https://github.com/openai/orchard)
- [Tart repository](https://github.com/openai/tart)

## Archie Integration

Keep the Claude Agent SDK `query()` process local. The current implementation assumes:

- Local workspaces, SDK directories, MCP servers, and `AbortController` wiring in [`src/agents/spawn.ts`](../../src/agents/spawn.ts).
- Local path-based sandbox enforcement in [`src/agents/sandbox.ts`](../../src/agents/sandbox.ts).
- An agent handle that aborts a local SDK subprocess in [`src/types/agent.ts`](../../src/types/agent.ts).

Moving the full agent into a runner would require remote MCP transport, event streaming, session-file movement, message-queue bridging, and new sandbox enforcement. Remote builds and simulators do not require that complexity.

Instead:

- Add a `RunnerManager` and a `RunnerProvider` interface.
- Attach `runner-tools` alongside the existing in-process MCP servers.
- Let agents select only operator-defined profiles such as `linux-small` or `ios-xcode-26`.
- Persist runner leases in `sessions/<task>/shared/runners.json`.
- Reconcile leases during startup recovery.
- Clean runners during task stop or completion, except for explicit time-limited debug leases.

Suggested tools:

- `runner_ensure(profile)`
- `runner_sync(paths)`
- `runner_exec(argv, cwd, timeout)`
- `runner_collect(paths)`
- `runner_open_debug_session()`
- `runner_release()`

The local repo clone remains canonical. Archie uploads a filtered workspace snapshot and downloads only logs, screenshots, test results, and build artifacts. Shared host mounts can be an optimization for colocated runners, but must not be the primary protocol.

## Provider Interface

```ts
interface RunnerProvider {
  provision(spec: RunnerSpec): Promise<RunnerInstance>;
  inspect(id: string): Promise<RunnerInstance>;
  exec(id: string, request: ExecRequest): AsyncIterable<ExecEvent>;
  upload(id: string, source: AsyncIterable<Uint8Array>): Promise<void>;
  download(id: string, paths: string[]): AsyncIterable<Uint8Array>;
  openTunnel(id: string, port: number): Promise<RunnerTunnel>;
  release(id: string): Promise<void>;
}
```

Initial implementations:

- `OrchardRunnerProvider` for Tart macOS and Linux VMs.
- `ContainerRunnerProvider` through `archie-runnerd` and rootless Docker.

Runner profiles should be centrally configured. Agents must not provide raw images, host paths, privileged flags, network modes, or device mounts.

## iOS Simulator and Debugging Flow

An `ios-xcode` profile should:

1. Provision a pinned Tart Xcode image.
2. Upload the repository snapshot.
3. Run `xcodebuild` for builds and tests.
4. Use `simctl` to create or boot a simulator, install and launch the app, and collect screenshots, video, logs, and diagnostics.
5. Run LLDB inside the VM for breakpoints and process inspection.
6. Offer Orchard VNC for human GUI debugging.

Apple documents `xcodebuild` and `simctl` as the supported command-line interfaces for builds and Simulator management. LLDB supports iOS Simulator and process attachment.

References:

- [Xcode command-line tool reference](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)
- [Running apps on simulated devices](https://developer.apple.com/documentation/Xcode/running-your-app-on-simulated-or-physical-devices)
- [LLDB documentation](https://lldb.llvm.org/man/lldb.html)
- [macOS Tart image templates](https://github.com/cirruslabs/macos-image-templates)
- [Orchard SSH and VNC access](https://tart.run/orchard/quick-start/)

For interactive debugging, Xcode should run inside the VM and the developer should connect through Orchard VNC. A local Xcode instance should not be expected to treat the remote simulator as a local destination.

## Persistence and Recovery

Runner state should be separate from task metadata because command state and output watermarks change frequently.

```ts
interface RunnerLease {
  id: string;
  taskId: string;
  agentId: string;
  profile: string;
  provider: "orchard" | "container";
  backendId: string;
  state: "provisioning" | "ready" | "busy" | "failed" | "releasing";
  createdAt: string;
  expiresAt: string;
  execSessions: Record<string, { sessionId: string; watermark: number }>;
}
```

Orchard's reconnectable exec sessions map well to Archie's existing recovery behavior. The container runner must provide equivalent buffered output and resume semantics.

On startup Archie should:

1. Read persisted leases.
2. Inspect each backend resource.
3. Reattach to live resources and exec sessions.
4. Mark missing resources failed.
5. Delete expired and orphaned resources.

## Security

- Use disposable runners and immutable image digests.
- Disable network access by default; explicitly allow required destinations.
- Inject secrets per command and never bake them into images.
- Enforce CPU, memory, disk, process, and wall-clock limits.
- Do not expose arbitrary Orchard `hostDirs` or Docker bind mounts.
- Do not expose Docker or Orchard credentials to agents.
- Do not allow privileged containers, host networking, host PID namespaces, device mounts, or Docker socket mounts.
- Record provision, exec, tunnel, artifact, and release events in the task audit log.

Docker warns that daemon access can become host-level privilege. Use a narrow service API over rootless Docker.

References:

- [Docker Engine security](https://docs.docker.com/engine/security/)
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [Protecting Docker daemon access](https://docs.docker.com/engine/security/protect-access/)

## Platform and Licensing Constraints

- Tart requires an Apple Silicon Mac host. Archie may remain on Linux.
- Apple permits up to two additional macOS VM instances per Apple-branded host for development and testing under the standard macOS license.
- Apple's license restricts service-bureau, time-sharing, terminal-sharing, and remote-desktop usage. Use one active human debug lease per VM and obtain legal review for the intended access model.
- Headless macOS hosts require preparation around login keychains and Local Network permissions.
- Tart and Orchard use FSL-1.1-ALv2. Internal use is permitted; competing hosted services are restricted until each release converts to Apache-2.0 after two years.

References:

- [macOS Tahoe license](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf)
- [Tart FAQ](https://tart.run/faq/)
- [Current Orchard host requirements](https://github.com/openai/orchard)
- [Tart license](https://github.com/openai/tart/blob/main/LICENSE)
- [Orchard license](https://github.com/openai/orchard/blob/main/LICENSE)

## Delivery Order

1. Run a standalone Orchard proof with a real app: simulator boot, tests, screenshot, logs, LLDB, VNC, and teardown.
2. Add `RunnerManager`, persistence, profiles, and the Orchard provider.
3. Add high-level iOS tools and temporary debug leases.
4. Add the restricted container provider through `archie-runnerd`.
5. Consider full agent-in-runner execution only if workload offloading proves insufficient.

The proof should validate simulator reliability, image caching and startup behavior, GUI access, task recovery, and guaranteed cleanup before implementation begins.
