# Memory Module

Standalone, ejectable module for persistent cross-task knowledge. No dependencies on ARCHIE internals.

## Module Structure

- `types.ts` — All interfaces and Zod schemas
- `index.ts` — `createMemoryManager()` factory (public API)
- `file-ops.ts` — Section-aware markdown read/write with per-file write queues
- `extraction.ts` — LLM-based fact extraction from task transcripts
- `retrieval.ts` — Context assembly for agent prompt injection

## Key Design Rules

- **No ARCHIE imports** — this module knows nothing about agents, tasks, Slack, or the event bus
- **LLM via config** — extraction uses `config.llmCall()`, not the Claude SDK directly
- **Markdown as truth** — all memory is human-readable `.md` files, no databases
- **Serialized writes** — per-file write queues in `file-ops.ts` prevent concurrent corruption

## Integration Point

ARCHIE consumes this module through `src/memory-adapter.ts`, which:
1. Provides `haikuLlmCall` and logger to `createMemoryManager()`
2. Subscribes to `task:completed` events for extraction
3. Exports `getMemoryContext()` for prompt injection in `spawn.ts`
4. Exports `createUpdateMemoryTool()` for the PM MCP server

## Memory File Layout

```
workdir/memory/
  org.md              # Organization knowledge (all agents read)
  activity.md         # Recent task activity table (PM reads)
  users/{id}-{name}.md  # Per-user preferences (PM reads)
  tasks/{date}-{slug}.md  # Task summaries (PM reads on demand)
```

## Testing

Tests use temp directories and mock `llmCall`. No external dependencies needed.

```bash
npm test  # runs all tests including memory module
```
