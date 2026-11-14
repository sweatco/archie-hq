# Proposals and retained research

Only unresolved choices belong in the proposal queue. These existing files retain their paths; historical designs and research remain useful evidence without being promises of future work. Follow the [filing guide](../guides/documentation.md).

## Unresolved or deferred

| Document | Disposition | Next useful observation |
| --- | --- | --- |
| [Distributed queues](distributed-queues.md) | Deferred; canonical revisit summary | Reproduce delivery loss or a multi-process requirement; compare a durable inbox before selecting a broker |
| [GitHub mentions](github-mention-workflow.md) | Proposed; needs revalidation | Define creation/resumption and approval behavior against the current flat PM and existing webhook router |
| [Analytics plugin gaps](analytics-plugin-gaps.md) | Needs revalidation in the owning plugin repository | Recheck remaining gaps against current plugins; old implementation claims are not evidence of current gaps |

## Historical rationale and evidence

| Document | Disposition | Current home |
| --- | --- | --- |
| [Architecture simplification](architecture-simplification.md) | Adopted historical rationale; old mechanics superseded | [System map](../architecture/overview.md) |
| [Coding-guidelines research](coding-guidelines-research.md) | Evidence for the adopted guide; preserve dated sources and limits | [Coding guidelines](../guides/coding-guidelines.md) |
| [Forge](forge.md) | External handoff reported by the original record; not reverified | External repository linked in the record |
| [LLM Guard](llm-guard-integration.md) | Trialed/removed alternative; retained rationale | [Web research](../architecture/web-research.md) and its optional guardrail path |

Filing review: 2026-11-11 against `4242842`. No proposal was accepted, cancelled or reprioritized merely because it was old. The [documentation reorganization record](../plans/20261111-documentation-filing.md) records the review scope and limits.
