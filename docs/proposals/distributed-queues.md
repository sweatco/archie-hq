# Distributed task delivery

Status: Deferred design; reviewed for filing on 2026-11-11. No queue implementation or new infrastructure is authorized by this record.

## Problem and revisit condition

Archie runs task sessions in one process, with a streaming input queue per PM and file-based task recovery. Revisit durable distributed delivery when measured restart loss, deployment interruption or task volume requires a multi-process ownership model. No current capacity measurement or delivery-loss reproduction is attached to this proposal.

## Options and recommendation

Keep the existing [task runtime and restart recovery](../architecture/orchestration.md) until a concrete failure justifies more infrastructure. If the requirement is durable inbound delivery, first test whether a persisted inbox plus the current single-process runtime suffices. A distributed broker is appropriate only when multiple processes must own and transfer work; it also requires claims, fencing, idempotency, shared state and recovery rules beyond replacing an in-memory queue.

The [v4 design](../plans/v4-queue-architecture.md) records the original Redis/GroupMQ and two-queue proposal. It assumes a triage/peer-agent architecture that no longer exists. Preserve it as historical rationale, not an implementation specification. Task metadata and SDK sessions support recovery, but neither proves that every interrupted in-memory message is durably delivered.

## Decision needed

Define the observed failure, required delivery guarantee and deployment topology, then compare the smallest durable-inbox change with a broker using a restart/concurrent-owner experiment. Until then, retain this as one deferred decision and keep queue implementation steps out of current architecture.
