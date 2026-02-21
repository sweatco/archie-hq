# Memory System

## Overview

Cross-task memory that lets agents benefit from past work. Built on top of existing per-task summaries with a Memory MCP server for search and retrieval.

## Design Principles

1. **Task summaries are the unit of memory** — each task already produces an evolving summary (in-progress) and a final summary (completed). These are the building blocks.
2. **No workspace context inside tasks** — global knowledge doesn't belong in task-scoped directories. Workspace context as previously designed (living inside `memory/workspace-context.md` per task or even globally) is removed.
3. **Memory is retrieved, not loaded** — instead of stuffing context into every agent prompt, agents query for relevant past tasks when they need it.
4. **Recency matters** — a rolling index of recent tasks gives agents fast awareness of what's been happening without searching.

## Architecture

```
memory/
  recent-tasks.md          # Rolling list of last 50 task one-liners

sessions/
  task-{id}/
    metadata.json
    shared-knowledge.log
    memory/
      summary.md           # Per-task evolving/final summary (unchanged)
```

### What Changed

- **Removed**: `memory/workspace-context.md` (global file loaded into all agents)
- **Added**: `memory/recent-tasks.md` (rolling recency index)
- **Added**: Memory MCP server for semantic search across task summaries

## Summary Triggers

Task summaries are generated at two points:

1. **Task pauses** (status → `stopped`) — Memory Agent writes/updates `summary.md` with current state, findings, decisions, and next steps
2. **Task completes** (status → `completed`) — Memory Agent writes final summary with problem, solution, outcome, and key learnings

No periodic or mid-task updates. Keep it simple — summarize when work stops.

## Memory MCP Server

An MCP server that agents can call to search and retrieve relevant past tasks.

### Tools

**`memory_search(query: string, limit?: number)`**
- Semantic search across all task summaries
- Returns ranked list of matching task summaries (or excerpts)
- Default limit: 5 results

**`memory_get_recent(count?: number)`**
- Returns the rolling recent tasks list
- Default: last 20 tasks
- Fast recency recall without search

**`memory_get_task(task_id: string)`**
- Retrieve full summary for a specific task
- Used when an agent wants deeper context on a search result

### When Agents Use It

- **PM Agent**: Before assigning a task owner, check if similar work was done before. "Has the team dealt with auth timeout issues before?"
- **Repo Agents**: When investigating, check if past tasks touched the same code or solved similar problems
- **Triage Agent**: Already searches task metadata — could also use memory search for better matching

Agents are not forced to query memory. It's a tool available when they need context.

## Recent Tasks Index

**`memory/recent-tasks.md`**

Rolling list of the last 50 completed/stopped tasks. One line per task. Updated by Memory Agent whenever a task summary is written.

### Format

```markdown
# Recent Tasks

| Task ID | Date | Summary | Outcome | Participants |
|---------|------|---------|---------|-------------|
| task-20240115-1000-abc123 | 2024-01-15 | Fixed auth timeout with retry logic | success | backend, mobile |
| task-20240114-0900-def456 | 2024-01-14 | Updated pricing page copy | success | website |
| task-20240113-1400-ghi789 | 2024-01-13 | Investigated payment failures — root cause in Stripe webhook | success | backend |
| ... | | | | |
```

### Maintenance

- Memory Agent appends new entry when writing a task summary
- When list exceeds 50 entries, oldest entries are dropped
- Simple, no database needed — just a markdown file

## How It Fits Together

```
Task completes or pauses
        │
        ▼
  Memory Agent runs
        │
        ├──▶ Writes/updates sessions/task-{id}/memory/summary.md
        │
        └──▶ Appends one-liner to memory/recent-tasks.md
             (trims to 50 if needed)

Agent needs context
        │
        ▼
  Calls Memory MCP tools
        │
        ├──▶ memory_get_recent() — "what's been happening?"
        ├──▶ memory_search("auth timeout") — "have we seen this before?"
        └──▶ memory_get_task("task-456") — "give me the full story"
```

## Open Questions

1. **Search implementation**: Start with keyword matching over summary frontmatter (keywords, summary fields) or go straight to embeddings? Keyword is simpler, embeddings scale better.
2. **Memory MCP scope**: Should the memory server also expose knowledge logs, or only summaries? Summaries are more concise; logs have full detail.
3. **Triage integration**: Should Triage Agent use memory search instead of (or in addition to) its current grep-based task lookup?
4. **Retention policy**: Do we ever prune old summaries from the memory index, or is the full history always searchable?
