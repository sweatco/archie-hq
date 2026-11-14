# OpenSpec records

This tree retains specification snapshots and archived change evidence. The [system module map](../docs/architecture/overview.md) routes current implementation questions. Older normative wording here must not silently override a later implemented contract.

## Specification inventory

| Snapshot | Disposition | Current owner |
| --- | --- | --- |
| [PR merge policy](specs/pr-merge-policy/spec.md) | Historical acceptance contract; agent-frontmatter/consensus policy was superseded by root `archie.json` | [GitHub integration](../docs/architecture/github-integration.md), [`isAutoMergeRepo`](../src/agents/registry.ts) |
| [Memory layer](specs/memory-layer/spec.md) | Historical target and amendments; scoped storage and recall evolved beyond it | [Memory](../docs/architecture/memory.md) |
| [E2E harness](specs/archie-e2e-harness/spec.md) | Historical acceptance scenarios; not requalified requirement by requirement | [E2E skill](../.claude/skills/archie-e2e/SKILL.md), [cloud runbook](../docs/guides/e2e-in-cloud-sandbox.md) |
| [Debug task waiting](specs/debug-mcp-task-waiting/spec.md) | Historical acceptance scenarios; not requalified requirement by requirement | [API and CLI](../docs/architecture/api-cli.md), [`wait-for-task.ts`](../tools/debug-mcp/wait-for-task.ts) |

## Archived changes

Keep [archived changes](changes/archive/) with their proposals, decisions, acceptance conditions and evidence. Negative results and intermediate verification explain the history; they are not current operating procedures. This filing review preserves all seven archived change directories without rewriting their evidence.

If new work explicitly uses OpenSpec, reconcile the affected contract against source and its module map first, then maintain one canonical change record. Do not create a duplicate `docs/plans/` implementation plan for the same work. See the [filing guide](../docs/guides/documentation.md).
