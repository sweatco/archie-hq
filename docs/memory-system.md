# Memory System

## Overview

Cross-task memory that lets agents benefit from past work. Each completed task produces a summary. Summaries are searchable through a Memory MCP server. That's the whole system.

## Design Principles

1. **Task summaries are the unit of memory** — each task produces a summary when it stops or completes. These are the building blocks.
2. **Memory is retrieved, not loaded** — agents query for relevant past tasks when they need context, nothing is force-fed into prompts.
3. **Recency matters** — recent tasks from a channel give agents fast awareness without searching.
4. **Channel visibility governs access** — tasks inherit visibility from their source Slack channel. Memory queries are filtered accordingly.
5. **Start simple, add complexity when evidence demands it** — keyword search before embeddings, full logs before sectioned logs, no per-channel summaries until query patterns stop scaling.

## Architecture

```
memory/
  recent-tasks.md          # Rolling list of last 50 task one-liners

sessions/
  task-{id}/
    metadata.json           # Includes source channel ID + visibility level
    shared-knowledge.log
    memory/
      summary.md            # Per-task evolving/final summary
```

### What Changed From Previous Design

- **Removed**: `memory/workspace-context.md` (global file loaded into all agents)
- **Added**: `memory/recent-tasks.md` (rolling recency index)
- **Added**: Memory MCP server for search and retrieval
- **Added**: Channel-based visibility filtering on all memory queries
- **Added**: Full knowledge log retrieval for deep context

## Summary Triggers

Task summaries are generated at two points:

1. **Task pauses** (status -> `stopped`) — Memory Agent writes/updates `summary.md` with current state, findings, decisions, and next steps
2. **Task completes** (status -> `completed`) — Memory Agent writes final summary with problem, solution, outcome, and key learnings

No periodic or mid-task updates. Summarize when work stops.

## Memory MCP Server

An MCP server that agents call to search and retrieve past task context. Serves as the access control boundary — agents never read task directories directly.

### Tools

**`memory_search(query: string, channel_context: string, limit?: number)`**
- Search across task summaries
- Results filtered by channel visibility (see Access Control below)
- Returns ranked list of matching task summaries
- Default limit: 5 results

**`memory_get_recent(channel_context: string, count?: number)`**
- Returns recent tasks visible to the requesting channel
- Default: last 20 tasks
- Fast recency recall without search

**`memory_get_task_log(task_id: string, channel_context: string)`**
- Retrieve the full knowledge log for a specific task
- Same visibility rules apply — if you can see the summary, you can see the log
- Used when an agent finds a relevant task via search but needs deeper context (exact implementation details, approaches tried and rejected, specific error messages)

### Two-Level Retrieval

Memory retrieval works as a drill-down:

1. **Summaries first** — agent searches, gets back compact summaries. This is the default and handles most cases.
2. **Full log on demand** — if a summary looks highly relevant but lacks detail, the agent requests the full knowledge log for that specific task.

Summaries are the compression layer. They tell the agent whether it's worth reading more. Agents should not routinely pull full logs for every search hit.

## Access Control

### The Problem

Tasks can originate from public or private Slack channels. A task from a private channel (HR issues, security incidents, unreleased work) must not leak into search results for queries from public channels.

### The Model

Each task is tagged with its source channel. Channel visibility determines what memory queries return.

**Two tiers:**
- **Public tasks** — visible to all queries
- **Private tasks** — visible only to queries from the same private channel

**The rule: public sees public. Private sees public + own channel.**

```
search("auth timeout", { channel: "C_PRIVATE_SECURITY" })
  -> returns public tasks + tasks from C_PRIVATE_SECURITY only

search("auth timeout", { channel: "C_PUBLIC_ENGINEERING" })
  -> returns public tasks only
```

### Enforcement

The MCP server is the single enforcement point. It receives the requesting task's channel context, filters results accordingly, and returns only what's visible. Individual agents never make access decisions — they get pre-filtered results.

### Metadata

Task `metadata.json` includes:
```json
{
  "channel_id": "C_PRIVATE_SECURITY",
  "channel_visibility": "private"
}
```

Channel visibility is determined at task creation time from the Slack channel type.

## Per-Channel Context

No separate per-channel memory system. Instead, searching recent tasks filtered by channel *is* channel memory — assembled on the fly from task summaries.

A dedicated per-channel rolling summary becomes necessary only when history is long enough that pulling all recent summaries for a channel doesn't fit in context. Build that artifact when the query pattern stops scaling, not before.

## Recent Tasks Index

**`memory/recent-tasks.md`**

Rolling list of the last 50 completed/stopped tasks. One line per task. Updated by Memory Agent whenever a task summary is written.

### Format

```markdown
# Recent Tasks

| Task ID | Date | Channel | Summary | Outcome |
|---------|------|---------|---------|---------|
| task-20240115-abc | 2024-01-15 | #backend | Fixed auth timeout with retry logic | success |
| task-20240114-def | 2024-01-14 | #general | Updated pricing page copy | success |
| task-20240113-ghi | 2024-01-13 | #backend | Investigated payment failures — Stripe webhook issue | success |
```

Note: This file is used internally by the MCP server, not read directly by agents. The MCP server filters entries by channel visibility before returning results.

### Maintenance

- Memory Agent appends new entry when writing a task summary
- When list exceeds 50 entries, oldest entries are dropped
- Simple, no database — just a markdown file

## How It Fits Together

```
Task completes or pauses
        |
        v
  Memory Agent runs
        |
        |-->  Writes/updates sessions/task-{id}/memory/summary.md
        |
        '-->  Appends one-liner to memory/recent-tasks.md
              (trims to 50 if needed)

Agent needs context
        |
        v
  Calls Memory MCP tools (with channel context)
        |
        |-->  memory_get_recent(channel) -- "what's been happening?"
        |-->  memory_search("auth timeout", channel) -- "seen this before?"
        '-->  memory_get_task_log("task-456", channel) -- "full details"
              ^
              |
              Only when summary isn't enough detail
```

## When Agents Use Memory

- **Triage Agent**: Check if a similar/duplicate task exists before creating a new one
- **PM Agent**: Before assigning a task, check if similar work was done before
- **Repo Agents**: When investigating, check if past tasks touched the same code or solved similar problems

Agents are not forced to query memory. It's a tool available when they need context.

## Open Questions

1. **Search implementation**: Start with keyword matching over summaries or go to embeddings? Keyword is simpler and probably sufficient initially.
2. **Retention policy**: Do we ever prune old summaries, or is the full history always searchable? Likely keep everything — disk is cheap, and old context can be surprisingly useful.
