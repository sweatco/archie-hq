# Proposal: Distributed Queue Architecture

> **Status:** Not implemented — design only (from MVP v4)

## Summary

Replace the current in-memory message queues with a durable, Redis-backed queue system to enable zero-downtime deployments and horizontal scaling across multiple pods.

## Motivation

The current system uses in-memory `MessageQueue` instances per agent per task (`src/system/message-queue.ts`). This works well for single-pod deployment but has limitations:

- **Task state lost on restart** — mitigated by v10's restart recovery, but messages in transit are lost
- **No graceful deployment** — restarting the process interrupts all active tasks
- **Single-pod bottleneck** — all tasks must run on one machine

## Design

### Two-Queue Architecture

1. **Triage queue** (fast, ~2s per job): Webhook events → classification → routing
2. **Spawn queue** (blocking, long-running): Agent spawning and task management

Both backed by GroupMQ + Redis with FIFO ordering per group (task ID).

### Key Features

- Webhook preclassification and deterministic routing for most events
- Graceful shutdown: active tasks handed off to new pod before old pod stops
- Per-pod local state tracking (`pendingSpawns`, `activeTasks`)
- Direct handlers for deterministic events (approvals, CI checks)

## Current Mitigation

The system achieves acceptable resilience without distributed queues through:
- `recoverActiveTasks()` on server restart (re-spawns agents from persisted sessions)
- SDK session resume capability (restores full agent context)
- Shared knowledge log provides continuity across restarts

## When to Build

This becomes necessary when:
- Deployment frequency requires zero-downtime updates
- Task volume exceeds single-pod capacity
- Multiple teams need independent scaling

## Original Design Document

The full design was captured in `plans/v4-queue-architecture.md`.
