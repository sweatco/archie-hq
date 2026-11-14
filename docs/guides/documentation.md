# Filing and maintaining documentation

Give each fact one maintained home. Start at the [documentation index](../README.md) and [system map](../architecture/overview.md), then read the map for the responsibility being changed. Architecture describes the implementation; a plan or proposal records intent and cannot override the code.

## Choose the home before writing

| Content | Home | Keep here |
| --- | --- | --- |
| Current responsibility, interfaces, state, constraints and failure behavior | `docs/architecture/<module>.md` | A module map using the [shared template](../architecture/_template.md), with links to owning code and checks |
| A repeatable setup, operation, migration or investigation | `docs/guides/<task>.md` | Prerequisites, steps, expected result and recovery; link the architecture instead of explaining it again |
| A consequential unresolved choice | `docs/proposals/<topic>.md` | Problem, options, recommendation, decision needed and condition for revisiting it |
| Agreed work and its outcome | `docs/plans/YYYYMMDD-<topic>.md` | Scope, decisions, observable acceptance, actual checks, remaining gaps and links to current docs |
| Detailed evidence for one plan | Beside that plan only when it needs supporting files | Dated source revision, observations and limitations; link it instead of copying transcripts into architecture |
| Agent behavior | `AGENTS.md`, linking an owning guide or scoped instruction | Short actionable rules; no second architecture or tool-specific copy of the same policy |

Small fixes need no proposal or plan. Use the PR description for ordinary change history. Existing OpenSpec records remain available through [their index](../../openspec/README.md); do not create a second plan for work already owned by an OpenSpec change or another canonical record. A private planning library may index a repository plan, but must not contain a competing editable copy. Keep private evidence, credentials and machine-specific paths out of this repository.

## Define a module by responsibility

A module has a coherent responsibility, a boundary with callers or dependencies, and behavior a maintainer needs to understand. It can span directories: OAuth includes the CLI, callback connector and vault. A directory or helper file does not automatically need its own architecture document. Give small capabilities a row or subsection in their owning map; split a map only when the new responsibility can be understood independently.

Use these five sections in order: **Purpose and boundary**, **Module map**, **Flow and lifecycle**, **Contracts and failure behavior**, **Change and verification**. The system overview maps modules to one another. Security uses the same questions across trust boundaries. Keep useful deeper explanations beneath these sections; do not pad a small module to match a large one's length.

The map links entry points, state owners and dependencies, and explains what crosses each boundary. Avoid exhaustive file listings, copied type declarations and implementation-shaped pseudocode when a source link answers the question. A diagram is useful only when it makes a relationship clearer. Preserve non-obvious constraints and incident rationale; remove obsolete instructions and duplicate explanations.

## Keep intent and outcomes distinct

New proposals and plans name their status and date near the top. Proposals use `proposed`, `deferred`, `accepted`, `rejected` or `superseded`; plans use `planned`, `active`, `completed`, `abandoned` or `superseded`. Record a dated reason when the status changes. An accepted proposal links its implementation plan; a completed plan links the current module map or guide and records the checks actually performed. Completed implementation does not establish deployment or usefulness.

Historical records can remain at their existing paths. Put a visible historical banner and current-document link at the top, and classify them in the owning index. Preserve original expectations, failed experiments, incomplete verification and important decisions. A stale plan is not evidence that its feature was cancelled; an old proposal is not evidence that it was accepted. Use `needs revalidation` when the current decision or external implementation is unknown. Never infer implementation from unchecked tasks, merge from a draft, or production behavior from a local test.

Archive by status and navigation first. Move files only when a move improves retrieval enough to justify updating incoming links. Delete only material whose unique useful content has been preserved elsewhere, or disposable output with no continuing value. Age and length alone are not deletion criteria.

## Update documentation with the change

1. Find the existing owner before creating a file. Update its map when responsibility, an interface, state lifetime, authorization, failure behavior or an operating assumption changes.
2. Update a guide when a user's procedure changes. Keep configuration names and defaults in their owning source or `.env.example`, linking them where possible.
3. Reconcile the relevant plan or proposal's outcome, preserving its original baseline. Do not maintain historical designs as if they were current manuals.
4. Add or update the owning index in the same change. `docs/README.md` indexes current architecture and guides and links to the complete plan/proposal indexes; it does not repeat their status tables.
5. Verify touched source paths, relative links and affected heading anchors. Check claims at the actual owner. Run proportionate checks; prose-only changes need link/source review and `git diff --check`, not new application tests. Record runtime or provider checks only if actually run.

Keep paragraphs and bullets on single source lines. Keep examples short, use repository-relative Markdown links, and preserve stable headings where other documents link to them. A review date records a scoped check, not a promise that every sentence or deployed environment was verified.
