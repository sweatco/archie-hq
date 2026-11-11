# Coding guidelines

Optimize for the next maintainer's understanding. They should be able to find the responsible module, follow a normal execution path, identify failure behavior and safely change it. Fewer lines can help, but fewer concepts, hidden effects and unnecessary jumps matter more.

## Guidelines

### 1. Give each responsibility one owner

Extend the module that already owns a decision or state transition. Callers use its operations; they do not maintain a competing flag, policy check, cache or persistence path. Identify who creates, changes and disposes of state. Make dependencies visible through imports and arguments. Prefer direct calls for required sequencing; use events to notify independent observers.

In Archie, connectors translate external events, tasks own task lifecycle, agent modules own SDK interaction, and system services own shared infrastructure. Follow the current architecture docs when a boundary is less obvious. Domain workflows and specialized capabilities belong in plugins. This is a placement guide, not a proposal to rebuild the engine around a new layering framework.

### 2. Make the main path readable in execution order

Keep a function at one useful level of detail. Handle invalid or inapplicable cases early, then show the main work in order. Prefer straightforward branches and loops when a dense expression or nested callback would make the reader reconstruct control flow. A short, clear array transformation is fine. Keep meaningful intermediate names even when the value is used once.

Represent significant JSX spacing with explicit string expressions, such as `{'  '}`, so formatting preserves the terminal output.

Put supporting helpers near their caller where practical. A named helper earns its place when it expresses a domain operation, hides a meaningful boundary, isolates complex logic or provides real reuse. Avoid helpers that merely rename a simple expression. A single caller is not, by itself, a reason to inline a useful boundary.

### 3. Split modules by responsibility

Keep closely related behavior together. Extract a module when it owns a distinct concept, has its own dependency needs or can be understood through a small interface. Do not split a coherent operation across many files to meet a line limit. Do not collect unrelated helpers in a new `utils`, `helpers` or `manager` module.

Long files, repeated edits across the same files and difficult navigation are prompts to inspect cohesion. They are not automatic failures. Name the responsibility being separated before extracting it. Improve touched code within the task's scope; record unrelated restructuring as a follow-up.

### 4. Use names that carry domain meaning

Use the same words as the surrounding product and architecture: task, session, destination, approval, trigger. Prefer `pendingApproval` to `data`, and `approvalExpiresAt` to `time`. Keep distinct identifiers distinct in names, especially task IDs, SDK session IDs, Slack channel IDs and thread timestamps. Include units when a number's meaning would otherwise be ambiguous.

Use verbs for actions and predicates for boolean questions. Avoid boolean arguments that select substantially different operations; prefer named operations or an explicit mode when callers need that choice. Keep existing formatting and naming conventions unless changing them is part of the task.

### 5. Let types describe valid states

Use the SDK's actual types and existing domain types. Infer obvious local values; make exported and non-obvious contracts explicit. Use tagged unions when outcomes or lifecycle states require different data. Avoid loosely related booleans and optional fields that allow contradictory states. Do not introduce elaborate generic types when a concrete type explains the contract.

Illustrative outcome types, not a proposed change to an existing Archie API:

```ts
type DeliveryResult =
  | { status: 'sent'; messageId: string }
  | { status: 'skipped'; reason: 'disabled' | 'unchanged' }
  | { status: 'failed'; error: Error };
```

Avoid new `any`, broad casts and non-null assertions that conceal uncertainty. Narrow `unknown` at the boundary. When a library limitation requires an escape hatch, keep it local and explain the specific invariant that makes it safe. Do not widen a contract merely to silence a compiler error.

### 6. Validate external data at its owning boundary

Validate wire input, persisted data and model output before treating them as domain values. Reuse the existing schema or parser; pass the resulting typed values inward. Avoid repeating the same shape checks inside internal helpers.

Types do not establish current authorization. Keep live access checks, approval consumption, audience checks and state-dependent invariants at the operations that own them. Rechecking a permission after asynchronous work can be necessary even when the input shape was already validated. Preserve these protections when simplifying code.

### 7. Make effects, errors and cleanup explicit

Keep a decision calculable without Slack, GitHub, disk or an SDK session when that makes the boundary clearer. Let the owning operation perform the effect; do not build an entire parallel domain model merely to make everything pure. Name functions so readers can recognize work that sends, persists, schedules or deletes.

Catch an error where code can recover, add useful context or present a meaningful outcome. Propagate it otherwise. Distinguish an expected skip, a failed action and an uncertain external delivery. Never turn all failures into an empty result or apparent success. Use Archie's unified logger and make intentional best-effort behavior visible.

Await promises or give background work an explicit owner for failures, cancellation and cleanup. A bare `void` does not handle rejection. Give timers, subscriptions, retries and locks a visible lifecycle. Add coordination for a concrete failure mode, especially data integrity or authorization; do not add state machines for unspecified future races.

### 8. Add abstractions for a present need

Search the owning module, siblings, existing services and installed dependencies before adding another mechanism. Use the existing SDK or platform capability when its semantics fit. Prefer a concrete solution over a configurable framework, registry or wrapper with no current consumer need.

Small duplication can be clearer than coupling unrelated behavior. Extract when the shared concept and its contract are understood, not when two pieces of syntax happen to match. Preserve compatibility for an identified public API, configuration, stored-data or deployment contract. Remove superseded internal paths in the same change when safe; do not add speculative legacy support.

### 9. Preserve rationale, remove narration

Comments explain a surprising constraint, dependency limitation, ordering requirement or intentional tradeoff. They do not restate a name or narrate assignments and branches. Existing incident rationale is valuable when it explains behavior that would otherwise look unnecessary. Prefer a focused explanation beside that behavior and link longer architecture or operational detail.

Update the owning architecture or guide document in the same change when a contract, lifecycle or operating assumption changes. Keep agent instructions focused on actionable repository-specific rules. Maintain each rule in one canonical place and link to it from other tools. Keep Markdown paragraphs and bullets on single source lines, as the repository already requires.

### 10. Review behavior and understanding before completion

Keep each change coherent: a reviewer should be able to connect the problem, implementation and verification without reading the chat. Separate broad formatting or unrelated refactors. Remove imports, helpers and paths made obsolete by the change.

Test observable behavior and meaningful boundaries. For a bug, use a regression that reproduces the failure when practical. For a refactor, preserve behavior and check affected callers. Avoid tests that reproduce the implementation, mock away the relevant boundary or assert private organization solely to reach a coverage target. Do not add tests for prose, mechanical formatting or other changes with no behavioral contract.

Use focused checks during iteration and the existing required checks before a code PR: typecheck, build and tests, plus the relevant running path when behavior warrants it. Use the repository's E2E skill for live verification. Report actual results and gaps. Passing tests establish only the behavior exercised; they do not establish human readability.

## A short review rubric

Reviewers should be able to answer these questions from the code and PR description. A finding should name the confusing behavior or unnecessary structure and suggest a concrete improvement; an empty review is valid.

- **Purpose:** What behavior changed, and which existing responsibility owns it?
- **Flow:** Can I follow input, decision, effect and failure without reconstructing hidden sequencing?
- **State:** Who owns updates, retries, authorization and cleanup? Can the types represent contradictory states?
- **Necessity:** Which new helper, option, dependency or layer earns its cost? Could an existing mechanism satisfy the requirement?
- **Proof:** Does verification cover the changed behavior, and can someone unfamiliar with this chat explain the important tradeoff?

Use a self-review for routine changes and ordinary maintainer review for PRs. Seek a fresh reviewer for consequential ownership, concurrency, persistence or authorization changes when that independent inspection can resolve a material uncertainty. Do not require a new agent, model judge or repeated review loop for every edit.

## Automated checks

Run `npm run check` before handing off a code change. It checks formatting, lint, types, the build and tests without rewriting source. During iteration, use `npm run lint`, `npm run format:check` and focused tests. `npm run lint:fix` applies the linter's safe fixes; `npm run format` rewrites formatting. Review both diffs before keeping them.

The committed `.oxlintrc.json` owns the exact rule allowlist and scopes. Syntax checks cover owned source, tools, scripts, examples and root code configuration. Typed rules cover TypeScript in `src/`, `tools/` and `scripts/`, using their nearest TypeScript projects. React rules apply to the CLI; test rules apply to test/spec files. Application source uses the unified logger, whose implementation owns direct console access. Standalone tools and scripts retain their intentional stdout/stderr interfaces. The existing compiler and Docker helper build remain authoritative; lint does not replace type checking.

Prettier owns mechanical presentation: two spaces, single quotes, semicolons, trailing commas, 100-column code formatting and LF endings. Markdown prose stays on single lines. Import order is preserved and embedded-language formatting is disabled. The ignore file excludes runtime data, secrets, generated output and changelog, the lockfile, prompts, skills and historical documentation/evidence. Only active contributor/agent guidance is included in Markdown formatting.

### Keeping lint clean

The repository has no lint baseline or suppressed findings. Fix violations in the owning code and run `npm run lint` across the full project. Do not introduce a suppression file, lower rule severity or replace uncertain types with broad casts to make checks pass. The CLI integration tests fail if the native suppression file returns.

Narrow `unknown` data at its external boundary and use the SDK's actual types. Tests should use typed mocks, checked lookups and assertions about returned data. The shared MCP test helper isolates the pinned SDK's private registration table, checks its shape and validates handler results; application code does not depend on that private API.

An unavoidable library constraint may justify a narrow, explained exception after review. Unused disable directives fail lint. Naming quality, ownership, necessary abstraction and useful rationale remain review judgements.

## Checking the guidelines' usefulness

For the next five substantive PRs, use the existing review to record useful readability findings, rejected stylistic suggestions, review/rework time and later corrective edits. Ask a maintainer unfamiliar with each change to trace its main flow and identify its owner. Record instruction misses or agent cost only where available. This small pilot can guide revisions; it cannot establish a general productivity improvement.

The [research note](../proposals/coding-guidelines-research.md) records the sources and their limits. The [adoption plan](../plans/20261109-coding-guidelines-and-checks.md) records implementation and verification outcomes.
