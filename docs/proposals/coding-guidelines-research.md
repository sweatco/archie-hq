# Evidence for Archie's coding guidelines

> **Adopted research evidence — filing review 2026-11-11.** The dated research supports an implemented guide. Later adoption decisions supersede the original ESLint/baseline recommendation; readability benefit remains unmeasured. Current contract: [Coding guidelines](../guides/coding-guidelines.md).

Research date: 2026-11-09. Supports the [coding guidelines](../guides/coding-guidelines.md) and [adoption plan](../plans/20261109-coding-guidelines-and-checks.md). Repository practices below are observed instructions, not evidence that their projects are more readable or that agents obey every rule. The sample is purposive: three TypeScript agent projects, a Rust editor, a large TypeScript editor and an established service repository with explicit multi-tool guidance. It is not an adoption survey.

## What exists in Archie

Inspected local commit `b3aae37033d166762db2adff7c95ae249307358c`: root `CLAUDE.md`, `CONTRIBUTING.md`, package manifests, TypeScript configuration, CI, the PR template, architecture docs, scoped memory instructions and selected source modules. The checkout was clean at the start. This was a convention and structure review, not a full code-quality audit.

- **Observed:** `tsconfig.json` enables strict TypeScript. `CONTRIBUTING.md` already requires the unified logger, SPDX headers, focused changes and typecheck/build/tests. The PR template already asks for the problem, design decisions and actual verification. Reuse those mechanisms.
- **Observed:** root `CLAUDE.md` supplies project-specific commands, architecture pointers, prose and changelog rules. `src/memory/CLAUDE.md` demonstrates scoped invariants worth preserving. There is no repository root `AGENTS.md` in this snapshot. There is no reason to create separate copies of the new coding rules for every agent.
- **Observed:** `package.json` declares `lint: eslint src/**/*.ts`, but neither it nor `package-lock.json` includes ESLint, and no ESLint configuration was found. No formatter configuration was found. CI runs typecheck, build, tests and gitleaks, without lint or formatting. This establishes a configuration gap, not a failed execution result; dependencies were not installed and lint was not run in this research.
- **Observed:** a count of non-test `src/**/*.ts` files found 122 files. `src/agents/tools.ts` has 3,063 lines, `src/connectors/slack/client.ts` 2,793 and `src/tasks/task.ts` 2,510. These are navigation candidates to inspect when working in those areas, not proof of poor cohesion or a request for a broad refactor. The count excludes `.tsx` files and files beneath `__tests__`.
- **Observed:** `src/agents/message-queue.ts` contains both comments that narrate simple operations and valuable rationale for detaching abandoned readers. `src/agents/tool-approval-gate.ts` explains an SDK interception constraint. The guideline should distinguish narration from constraints rather than reward indiscriminate comment deletion.

## Community repositories

Each linked instruction file was fetched at the pinned revision below. These are examples to adapt, not instructions governing work on Archie.

| Repository | Observed approach | Useful adaptation for Archie | Do not copy wholesale |
|---|---|---|---|
| [Pi, formerly pi-mono](https://github.com/earendil-works/pi/blob/a09906b2f64bf89a276956ff20ad2b1ad6fd74c0/AGENTS.md) | Its general rules discourage `any`, redundant internal checks and trivial one-use helpers. Its scoped Chord v2 guide organizes files by concept, public entry points before helpers, explicit state/result types and rationale comments. | Judge boundaries by the concept they name; use scoped rules for subsystem constraints. | Chord-specific rules do not apply to the whole project. Its blanket ban on dynamic imports and project-specific test restrictions are not universal readability requirements. |
| [OpenCode](https://github.com/anomalyco/opencode/blob/05099eaa0b5946285063896f555eeef3ece482e3/AGENTS.md) | Documents runtime dependency direction, boundary validation, guard clauses and examples. Allows helpers for complex boundaries or meaningful concepts while discouraging premature extraction. | Show the main path clearly, validate at a named boundary and explain when extraction helps. | Preferences for fewer variables, array methods and dynamic imports are local choices. Inlining every intermediate value can remove useful meaning. |
| [OpenClaw](https://github.com/openclaw/openclaw/blob/cbe182f49c4cac33f339c03a77b983f3d7a52ccc/AGENTS.md) | Explicit ownership of state and responsibilities; small core with capability in plugins; removal of superseded paths; concrete failure scenarios before additional coordination. Long rules live in owning guides. | Reuse existing owners, avoid parallel state and keep specialized capabilities outside the engine. | Its database, runtime, release and review procedures reflect its own contracts. Archie's file persistence is not a reason to adopt its storage rules. |
| [Zed](https://github.com/zed-industries/zed/blob/483b746b568256e125538769ce5474a5347069a3/AGENTS.md) | Prioritizes clarity, full names, rationale comments and visible error handling. Prefers existing files unless a new logical component is needed. Documents task and subscription lifetimes. | Keep cohesive code together and make async ownership and cleanup visible. | Rust/GPUI mechanics and the manual README review marker are not part of this proposal. |
| [VS Code](https://github.com/microsoft/vscode/blob/e0adcb58901264a1eb00bff9b598170bf1d508a4/.github/copilot-instructions.md) | Explains layering, limits exports, uses whole words, requires disposable ownership and favors direct service calls over events for control flow. Validation is scoped to risk and existing diagnostics. | Small module surfaces, explicit dependencies and traceable sequencing. Reuse successful relevant checks. | Its DI framework, localization system, tabs and public-content policy are project-specific. Do not add a service framework merely to imitate its architecture. |
| [Sentry](https://github.com/getsentry/sentry/blob/bd5d90759550e76bc32a679eefecb7080e0e36ce/AGENTS.md) | Makes `AGENTS.md` canonical, routes to scoped files and skills, and explicitly avoids long duplicated tool-specific guidance. Its [Claude entry point](https://github.com/getsentry/sentry/blob/bd5d90759550e76bc32a679eefecb7080e0e36ce/CLAUDE.md) references that file. | One owner for instructions, small tool entry points and subsystem-specific invariants. | Its Python environment, deployment and feature-flag requirements do not transfer to Archie. |

There is no single community style to copy: Pi prohibits dynamic imports while OpenCode encourages them for startup-sensitive paths. Zed and Pi discourage unnecessary fragmentation, while still recognizing real component boundaries. The synthesis is to make ownership and comprehension reviewable, with local conventions deciding syntax preferences. This is an inference from the inspected examples, not a measured superiority claim.

## Research relevant to the decision

The dates identify the reviewed paper version, not a search engine's crawl timestamp. Findings are separated from the proposed application to Archie. The newest sources are preprints; recent publication alone does not establish reliability.

### Instruction consistency: a fresh descriptive result

[Shanto et al., *Toward an Evidence-Based Template for Agent Instruction Files*, v1, 2 November 2026](https://arxiv.org/html/2611.02383v1) analyzed 3,387 files from 1,000 repositories. In a manual sample of 386 corresponding section pairs, 16.1% provided divergent guidance. The study also proposes a template and evaluates generated content. Its threats section explicitly says it does not measure downstream coding-agent performance. **Implication:** keep one canonical rule source and inspect generated instructions for preserved intent. Do not treat its larger template or structural coverage scores as proof that more instruction categories improve code.

### Agent effectiveness: use the revised result

[Gloaguen et al., *Evaluating AGENTS.md*, v3, 29 September 2026](https://arxiv.org/html/2602.11988v3) evaluated four agent/model configurations on 300 SWE-bench Lite tasks and 138 CTXbench tasks. Context files did not significantly improve resolution compared with no file. Generated files increased average inference cost by 20% and 23% on the two benchmarks; developer files improved resolution by 2.4 percentage points on CTXbench without statistical significance and also added cost. The evaluation is Python-focused and tests issue resolution, not human readability or long-term maintainability. Its ablations do not establish a simple file-length effect. **Implication:** use instructions to state necessary conventions, and evaluate useful behavior rather than assuming an instruction file is a performance improvement. Brevity is an editorial choice here, not a validated optimal token count.

### Contrary efficiency evidence

[Lulla et al., *On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents*, v2, 30 March 2026](https://arxiv.org/html/2601.20404v2) studied 124 PR tasks from 10 repositories. It reports 28.64% lower median runtime and 16.58% lower median **output** tokens. This is not a reduction in all token categories: median total tokens slightly increased. Output quality was checked through a 50-task manual sanity sample, not a full correctness evaluation. **Implication:** retain useful project instructions, but do not infer code quality from faster runs or fewer output tokens. The different tasks, agents and outcome measures prevent treating this and Gloaguen et al. as a clean replication or direct contradiction.

### Readability-labelled refactors are not proof of improvement

[Horikawa et al., *Do AI Agents Really Improve Code Readability?*, MSR 2026, 14 March 2026](https://arxiv.org/html/2603.13723v1) examined 403 readability-related commits from AIDev. Maintainability Index fell in 56.1%, and cyclomatic complexity rose in 42.7%. These are observational metric changes on selected commits, not measured human comprehension or a causal comparison with human refactoring. **Implication:** preserve behavior, inspect the resulting structure and use metrics as prompts for review. Neither a request to simplify nor a lower complexity number establishes that maintainers understand the result better.

### Human maintenance: meaningful counterevidence

[Borg et al., *Echoes of AI*, v3, 26 February 2026](https://arxiv.org/html/2507.00788v3) studied 151 participants, 95% professional developers. Developers first extended a Java application with or without AI; a subsequent randomized phase had different participants evolve the results without AI. The study found no significant downstream difference in completion time or code quality. Its authors describe possible improvements as small and uncertain. **Implication:** assess code and maintainers' actual experience rather than treating AI authorship as a defect. A bounded Java task does not establish equivalence for Archie's TypeScript runtime or long-term architectural evolution.

### Latest quality synthesis: provisional support for independent checks

[Kadam, *Beyond Passing Tests*, v1, 28 October 2026](https://arxiv.org/html/2610.38977v1) reports a review of 628 studies plus controlled technique comparisons. It warns about incomplete correctness reporting, evaluation on the same signal being optimized and unmatched compute budgets. Its reported comparisons do not support assuming elaborate prompting or reviewer agents universally beat simpler budget-matched baselines. This is a new preprint with disclosed LLM assistance; the synthesis and experiments were not independently reproduced for this proposal. **Implication:** check behavior and human understanding separately, and justify additional review machinery through observed benefit. This source is supplementary; the recommendation does not depend on accepting all its benchmark conclusions.

## Enforcement choices

The proposed guide uses existing TypeScript, Vitest, architecture docs and PR review. It does not introduce a new development framework or a rewrite. Three credible next steps have different costs:

| Option | Benefit | Limitation | Recommendation |
|---|---|---|---|
| Guide and review only | Lowest setup cost; handles context-dependent design | Objective mistakes still rely on review and agent compliance | Useful first step, not a claim of enforcement |
| Qualified ESLint/TypeScript checks plus one formatter | Reproducible mechanical feedback; extends the intent of the existing `lint` script | Needs dependencies, configuration, a compatibility check and a manageable baseline | Preferred follow-up after agreeing the guide |
| An automated quality reviewer and complexity gates | Could catch recurring structural issues | More inference and integration cost; proxy gaming, taste-driven churn and false confidence | Defer until specific misses justify it |

Tool candidates are proposals, not verified integrations with Archie's pinned compiler and dependencies. The [typescript-eslint `no-explicit-any` documentation](https://typescript-eslint.io/rules/no-explicit-any/) supports narrow exceptions and safer boundary types. Its [`no-floating-promises` documentation](https://typescript-eslint.io/rules/no-floating-promises/#ignorevoid) explicitly warns that `void` does not handle rejection; configuration and review must preserve actual error ownership. [Prettier's prose-wrap option](https://prettier.io/docs/options#prose-wrap) supports `never` for single-line prose blocks. A formatter resolves presentation consistency; it cannot decide module ownership or sufficient explanation.

Start checks with a scoped, explicit baseline or a clean pilot area, not a repository-wide suppression comment. Add import restrictions only after verifying the owning boundaries; current cross-module dependencies are not automatically violations of a new idealized diagram. Keep subjective file-size, complexity and duplication observations advisory. Change that choice if a calibrated rule consistently catches a concrete maintenance problem without forcing fragmentation or unrelated cleanup.

## Coverage and limits

Executed: local instruction/configuration and selected-source inspection; source-file line counts; six pinned community instruction reads and Sentry's Claude entry point; six primary-paper reviews using abstracts and relevant methods/results/limitations; official tooling documentation checks. No empirical experiment was reproduced. This is a targeted review, not a systematic literature search or an exhaustive scan of Archie.

The proposed rules are engineering judgements informed by those sources. None of the inspected studies demonstrates that this exact guide improves Archie. Its adoption plan therefore uses existing PRs to check comprehension, useful findings, rework and overhead before adding further machinery. Automatic enforcement, product changes and broad refactors remain outside this research deliverable.

Review receipt: one fresh read-only critic, same inherited model, one review call and no follow-up. It checked the documents, owning local configuration and central primary-source claims, and returned ready with no material findings. Local links, code fences, trailing whitespace and the tracked diff check passed. Application tests were not run for this documentation-only change. Review agreement establishes no implementation or readability benefit. Stop reason: settled; the targeted research and proposal are complete, while adoption and outcomes remain pending.

## Adoption decision, 2026-11-09

The guidelines and automated-check plan were approved for implementation. The baseline remains native and count-based, with review of equal-count substitutions; formatting is a one-time mechanical change. Compatibility inspection superseded the proposed ESLint integration: Archie uses TypeScript 7.0.2, while typescript-eslint documents support below 6.1. The selected Oxlint engine tracks TypeScript 7.0.2. Historical observations above describe the research snapshot; current configuration and executed outcomes are recorded in the adoption plan.
