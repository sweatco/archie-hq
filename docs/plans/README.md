# Development Plans

Historical record of Archie's incremental development. Each plan represents a milestone that was designed, reviewed, and (in most cases) implemented. Plans are preserved as-is for historical reference, with a status header indicating their implementation state.

## Naming convention

- **New plans** are named `YYYYMMDD-{name}.md` (date the plan was written, e.g. `20260626-response-formatting.md`). Dates don't collide, so several plans can be drafted in parallel without coordinating a shared counter.
- **Legacy plans** use the sequential `vN-{name}.md` scheme and are kept under their original names as a frozen historical record — they are not renamed.

## Implementation Status

| Plan | Feature | Status |
|------|---------|--------|
| [v1](v1-core-system.md) | Core multi-agent system | Implemented |
| [v2](v2-edit-mode.md) | Edit mode & git worktrees | Implemented |
| [v3](v3-git-and-prs.md) | Git commits & pull requests | Implemented |
| [v4](v4-queue-architecture.md) | Queue-based architecture (Redis/GroupMQ) | Not implemented |
| [v5](v5-agent-recovery-design.md) | Agent recovery & handoff resilience (design) | Partially implemented |
| [v6](v6-plugin-architecture.md) | Plugin architecture migration | Partially implemented |
| [v7](v7-plugin-agents.md) | Plugin agent track | Implemented |
| [v8](v8-web-research.md) | Web research MCP tool | Implemented |
| [v9](v9-prompt-injection-defense.md) | Prompt injection defense | Implemented |
| [v10](v10-agent-recovery-impl.md) | Agent recovery implementation | Partially implemented |
| … | (v11–v31 — see files in this directory) | — |
| [20260626](20260626-response-formatting.md) | Message footer + self-updating PR cards | Implemented |
| [20260718](20260718-web-artifact-rendering.md) | Web artifact rendering (Markdown + stable pointer + hot reload) | Implemented |

## Evolution Arc

The plans describe an evolutionary path from a read-only investigation tool to a production-ready multi-agent engineering system:

1. **v1-v3** (Foundation): Core system, edit mode, GitHub integration
2. **v4** (Infrastructure): Durable queues for multi-pod deployment — deferred in favor of single-pod with restart recovery
3. **v5, v10** (Resilience): Agent idle detection & progressive recovery
4. **v6-v7** (Extensibility): Plugin architecture for domain-agnostic agent spawning
5. **v8** (Capabilities): Web research with multi-agent pipeline
6. **v9** (Security): Layered prompt injection defense

## Notes

- Plans were written before implementation and represent the design intent at the time
- The actual codebase may differ from plans in implementation details — see [architecture docs](../architecture/) for current state
- v4 (queue architecture) was intentionally skipped; the system achieves acceptable resilience through v10's restart recovery mechanism
