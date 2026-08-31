## Why

Archie's global memory can currently retain private Slack context and has no agent-callable retrieval path. We need a small, reviewable boundary that preserves useful public memory, keeps current triggers working, and confines private outcomes to their original channel or user.

## What Changes

- Partition the file-based store into workspace-bound public memory and per-channel/per-user rolling outcome files for internal-only Slack audiences.
- Persist host-derived task audience and Slack author provenance instead of inferring authorization from transcript text.
- Extract rich profiles/entities only from internal-only public tasks; retain summary-only outcomes for internal private channels, MPIMs, and DMs.
- Disable memory for Slack Connect channels, channels containing restricted guests, external-user DMs, mixed audiences, and failed audience lookups.
- Add feature-gated, read-only `search_memory`, `read_entity`, and `read_task_summary` tools with live private-scope authorization.
- Keep prompt injection public-only and default-off, and add no automatic channel-history lookback.
- Require an operator wipe or backup of the legacy unscoped store instead of migrating it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory-layer`: Add audience-scoped storage, host-controlled provenance, private rolling outcomes, workspace binding, and read-only pull tools.

## Impact

- Affects the memory subsystem, Slack conversation classification, task metadata/ingestion, trigger-fired task initialization, agent MCP registration, environment flags, and memory documentation.
- Adds no external service or runtime dependency.
- Runtime memory is reset once during rollout; existing task and trigger delivery behavior remains unchanged. Live verification uses a test-only memory mount and never resets the shared host store.
