# Proposal: memory-v2-preflight

## Why

`ARCHIE_MEMORY_INJECT` has never been `true` in prod: extraction has filled the store for months, but nobody has seen what selection would actually inject, and the selection sensor only records when injection is on — so there is no telemetry to reason from. Selection is a pure function over capturable inputs (pulled store + reconstructable spawn contexts), which means a close approximation of prod injection behavior — the same code path over end-of-task reconstructions of each spawn's context — is computable today, offline, at zero risk. This change builds that pre-flight: the remaining Phase 1 evidence-gathering (replay + store review + snapshot history) that the enablement flag flip is conditioned on.

## What Changes

- New disposable replay script `scripts/memory-preflight.ts`: runs recent prod tasks' reconstructed `SelectionContext`s through the real `selectEntities` against a pulled store, prints per-spawn would-be injections (slugs, scores, scope, dropped, zero-signal count, rendered-token estimate) plus worst-case token arithmetic for the enablement PR.
- The replay also emits a store-review reading list (entities ordered by connectedness/size/staleness, suspicious-content grep hits) so the human review of page content takes ~1h instead of an unordered skim.
- New thin snapshot wrapper `scripts/snapshot-memory.sh` + laptop `launchd` schedule: periodic `pull-remote-data.sh -m` into dated local tarballs — store-at-time-T history for later evals, no prod-side change.
- Human tasks tracked but not automated: store content review (junk / staleness / prompt-injection residue) and the enablement flag flip itself.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `memory-layer`: ADDED requirement — offline selection replay: the repo provides a read-only tool that reproduces production entity selection against a pulled snapshot via the same `selectEntities` code path and reports would-be injections and token estimates per spawn.

## Impact

- New files: `scripts/memory-preflight.ts`, `scripts/snapshot-memory.sh`.
- Possible small export change in `src/memory/context.ts` (expose `renderEntityBlock` or equivalent) so replay token counts use the real render path; no behavior change.
- Docs: `docs/architecture/memory.md` gains a short pre-flight/snapshot note; `docs/proposals/memory-v2-roadmap.md` Phase 1 item statuses updated as they land.
- No runtime behavior change: the app's execution paths are untouched; injection stays default-off until the (separate, human) flag flip.
