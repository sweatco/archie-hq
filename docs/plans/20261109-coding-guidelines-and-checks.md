# Adopt Archie's coding guidelines and automated checks

Status: Guidelines, checks and the verified suppression-free follow-up are prepared for publication in [draft PR #370](https://github.com/sweatco/archie-hq/pull/370). Approved 2026-11-09; publication of the zero-debt follow-up authorized 2026-11-10. Starting revision: `b3aae37033d166762db2adff7c95ae249307358c`; rebased onto `26821b177d3c20467559898f5dc0cf02f4322c97` on 2026-11-10. Verification results and remaining debt are recorded below; readability benefit remains unmeasured. No deployment was performed.

## Outcome and constraints

Make the [researched coding guidelines](../guides/coding-guidelines.md) active, enforce reliable mechanical rules locally and in CI, and preserve existing behavior. The [research note](../proposals/coding-guidelines-research.md) retains the community comparisons and empirical limits.

Use Oxlint **1.93.0**, oxlint-tsgolint **7.0.2006** and Prettier **3.9.10**, pinned in the manifest and lockfile. This supersedes the earlier proposed ESLint integration: [typescript-eslint supports TypeScript below 6.1](https://typescript-eslint.io/users/dependency-versions/), while Archie uses 7.0.2 and [Oxlint's stable engine tracks that release](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable.html). Keep the existing compiler/build authoritative; do not add a compiler shim or second TypeScript version.

Initial adoption decisions (superseded by the zero-debt update below): baseline existing debt through the native per-file/rule-count mechanism, review equal-count substitutions and baseline changes, and perform one separate mechanical formatting pass. No public runtime API change, broad refactor, mandatory Git hook, quality bot, architecture rewrite or complexity/file-length quota is planned. Remote Git writes and releases require separate explicit approval.

## Guidance and documentation

- Move the ten guidelines and five-question rubric into the canonical guide. Preserve research, repair references and remove the superseded proposal.
- Consolidate root agent instructions in `AGENTS.md`, linking to the canonical coding guide. Remove root `CLAUDE.md` after carrying over useful project guidance; preserve the scoped memory instructions.
- Update contributor/local-development guidance, documentation indexes and the PR template with commands, baseline maintenance and review expectations.
- Keep ownership, meaningful names, abstraction quality and sufficient rationale as review judgements. Use existing PR feedback for the next five substantive changes to assess useful findings, rejected stylistic suggestions, rework and review overhead; do not add telemetry state.

## Automated checks

Configure one explicit error-rule allowlist, disabling unrelated default categories. The configuration owns exact rule IDs and scopes.

| Concern | Required checks |
|---|---|
| Basic correctness and cleanup | `no-debugger`, `no-var`, `prefer-const`, `no-empty`, `no-unused-vars`; only unused callback parameters may use an `_` prefix |
| Unsafe type escapes | `no-explicit-any`, `no-non-null-assertion`, `ban-ts-comment`; prohibit `ts-ignore`/`ts-nocheck`, require explanations for `ts-expect-error` |
| Unsafe operations | TypeScript `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return` |
| Async handling | `no-floating-promises` with `ignoreVoid: false`, `no-misused-promises`, `await-thenable` |
| Dependencies | `import/no-cycle`, ignoring type-only imports and external packages |
| React CLI | `react/rules-of-hooks`, `react/exhaustive-deps` |
| Tests | `vitest/no-focused-tests`, `vitest/valid-expect` |
| Logging | `no-console` in application source except the logger implementation |

Apply syntax checks across owned source, tools, scripts, examples and root code configuration, including TypeScript and TSX. Add nearest no-emit TypeScript projects for tools/scripts so typed lint has proper coverage. Preserve the emitting script configuration consumed by both Dockerfiles. Route CLI help through the existing `logger.plain` with identical output; standalone tools retain stdout/stderr contracts.

Configure Prettier with two spaces, single quotes, semicolons, trailing commas, 100-column print width, LF endings, `proseWrap: "never"` and embedded-language formatting disabled. Format owned code/configuration and active contributor/agent guidance once, preserving import order. Exclude runtime data, secrets, generated output/changelog, lockfile, prompts, skills and historical documentation/evidence.

## Baseline and CI rollout

- Install dependencies before measuring debt. Review straightforward fixes and complete formatting before generating `oxlint-suppressions.json`; never use dependency-incomplete probe counts.
- Replace obsolete ESLint directives with captured baseline debt or narrow explained Oxlint exceptions. Fail unused disable directives.
- Normal lint must fail counts exceeding committed allowances and stale entries until pruned. Equal-count substitutions remain a documented review limitation. Never regenerate allowances automatically in CI.
- Provide `lint`, `lint:fix`, `lint:prune`, `format`, `format:check` and `check`. Normal checks are read-only; safe fixing and baseline pruning are explicit commands. `check` runs format verification, lint, typecheck, build and tests.
- Add format/lint to the existing CI job without changing its status-check name. Retain gitleaks, CodeQL and Dependabot.
- Keep tooling/guidance, formatting and necessary semantic repairs separately reviewable. Review changed code for scope, readability and unnecessary complexity before handoff.

## Verification and acceptance

- Qualify a clean install under CI's Node 24 and pinned npm 11.16.0.
- Run actual CLIs against temporary cases for TS/TSX coverage, bare-`void` versus handled promises, logger exceptions and tool stdout, focused tests, invalid hooks, runtime versus type-only cycles, baseline overages and pruning.
- Verify formatter idempotence and that excluded prompts, generated files and historical artifacts remain byte-identical.
- Run the complete `check`, the standalone Git-helper compilation and CLI help smoke check. Confirm normal checks leave tracked files unchanged, with build output remaining ignored.
- Inspect semantic repairs through the affected runtime. Load the existing E2E skill if a repair changes engine behavior.
- Record executed checks, remaining debt and unverified behavior. Tool startup/rule recognition was probed read-only on 307 files during planning; dependency-backed counts and full qualification were still outstanding at approval.

## Implementation results

### Delivered

The canonical guide, shared agent entry point, contributor/local-development guidance, PR rubric, explicit Oxlint allowlist, no-emit tooling projects, pinned dependencies and CI steps are implemented. The emitting Docker script configuration is unchanged. The existing CI job name remains `Typecheck, build & test`; gitleaks, CodeQL and Dependabot remain in place. Superseded proposal links and 35 obsolete ESLint directives were removed.

The initial formatting pass changed 285 of 337 selected files and left all 237 excluded files in its snapshot byte-identical. Inspection caught Prettier collapsing significant JSX spaces in three CLI views; explicit string expressions now preserve them. After that correction, normalized emitted JavaScript matched the pre-format snapshot for all 307 existing owned source files. The new check test is outside that existing-source comparison. CLI help before and after routing through `logger.plain` matched byte for byte.

Two integration details were qualified against the owning tools: `vitest/valid-expect` accepts two arguments because Vitest supports an optional diagnostic message, and the formatter excludes the native lint baseline because Oxlint owns its generated formatting. Both are covered by the CLI smoke tests. The installed source types confirmed the Vitest signature; a temporary false-positive baseline entry for the new test was pruned rather than retained.

### Executed verification

| Check | Observed result |
|---|---|
| Clean install | Node 24.22.2 and npm 11.16.0; `npm ci` exited 0 and installed 319 packages. npm reported pending approval for existing esbuild/fsevents install scripts; no approval policy was changed. |
| Check integration | Nine tests passed through the installed Oxlint and Prettier CLIs, including nearest-project typed coverage for source/tools/scripts, promise handling, logger/tool output, hooks, focused/incomplete assertions, cycles, unused directives, baseline overage/pruning and formatting/ignore behavior. |
| Complete gate | `npm run check` passed: formatting, lint, typecheck, build and all **2,272 tests across 161 files**. |
| Sandbox retry | An initial full run passed 2,271 tests and failed one API localhost request with `EPERM`. With local networking permitted and no source/config change, the full gate passed. |
| Docker helper | `tsc -p tsconfig.scripts.json` passed with the same Node/npm toolchain. No Docker image was built. |
| Output preservation | CLI help was byte-identical; normalized emitted JavaScript matched for 307 existing source files after preserving significant JSX spacing. |
| Read-only gate | Hashes of all 575 tracked and task-created files were unchanged by the full gate. Build outputs remained ignored. |

Self-review checked the changed code, rule scopes, existing owners, source-output preservation and necessity of the new configuration. No custom baseline engine, hook orchestration or quality service was added. Source formatting is supplied as a separate local patch alongside the tooling/guidance patch for review.

### Local commit organization, 2026-11-10

The one-time formatting is isolated in `27fc93f` (`style: format owned source and configuration`): 285 files after rebasing, with normalized emitted JavaScript verified equivalent to current `main` for all 310 existing code files checked. The following `chore: adopt coding guidelines and automated checks` commit groups the guide, agent routing, tooling, tests, baseline, CI and the small logger/directive changes. The initial split preserved the implementation's file contents apart from its commit-status record.

For this split, `npm run check` passed again under Node 24 and npm 11.16.0 with local networking permitted: formatting, lint, typecheck, build and all 2,272 tests across 161 files. No source, configuration or baseline content changed during the split.

### Merge conflict repair, 2026-11-10

Current `main` added team-based proactivity, full proposal evidence and the Fable 5.2 default after the starting revision. Its changes overlapped the formatting pass in 31 files. The rebase preserves current `main` behavior and applies the configured formatter to affected code, including its new team-proactivity test. The separate formatting and tooling commits remain intact in structure. Normalized emitted JavaScript matches `main` across all 310 existing code files; no runtime repair or refactor was needed.

The initial adoption baseline was remeasured with Oxlint after installing the rebased lockfile. Its 15 changed rule allowances are confined to 11 files changed upstream: existing non-null assertions and unsafe test operations add 44 findings. The baseline now records 2,449 findings across 167 files. This incorporates pre-adoption code from `main`; it does not introduce routine baseline generation or change lint rules.

The rebased `npm run check` passed under Node 24.22.2 and npm 11.16.0: formatting, lint, typecheck, build and all **2,309 tests across 162 files**. All 576 tracked-file hashes remained unchanged by the gate. The standalone Git-helper compilation also passed. Hosted CI and live-provider behavior remain separate from this local verification.

### CodeQL follow-up, 2026-11-10

At PR head `7cc67d6`, the hosted format/lint/typecheck/build/test job, gitleaks and CodeQL analysis all succeeded. The separate CodeQL results gate failed on 24 annotations: 23 high-severity alerts and one medium. All 24 match alert IDs already open on `main`; both branch analyses contain 46 results and expose the same 41 open alerts. The broad formatting diff placed these existing locations inside the PR's changed code. They were not new findings introduced by the guideline tooling.

The follow-up is a separate security repair, preserving the formatting/tooling split:

| Reported locations | Repair |
|---|---|
| 12 task-persistence path alerts | Validate a single task-ID segment and check normalized directory containment in its owning path constructor. Preserve canonical and existing short IDs. |
| Seven OAuth pending-file path alerts | Keep the existing base64url guard beside path construction and check normalized pending-directory containment. Accepted states and rejection behavior are unchanged. |
| Two memory escaping alerts | Serialize display names as JSON-quoted YAML values and decode entity strings accordingly, retaining the older reader for non-JSON legacy values. |
| One debug format-string alert | Use a literal format string before the caller's message and attached data. |
| One OAuth summary logging alert | Name the returned metadata `bindingSummary`. The SARIF source was the `oauthBindings` identifier, while inspection and existing injection tests confirm the injected list contains only server names. Token values are neither added to the summary nor newly logged. |
| One reminder shell-path alert | Reuse the existing task-metadata reader, removing the shell from reminder reconstruction. |

Regression tests reproduced 11 failures before the repair, including actual shell execution of a controlled marker in a temporary directory. The final `npm run check` passed under Node 24.22.2/npm 11.16.0: formatting, lint, typecheck, build and **2,329 tests across 164 files**. The 20 added cases cover unsafe and ordinary IDs, OAuth state paths, encoded and legacy display names, literal debug output and reminder reconstruction from a path containing shell syntax. An existing traversal test still creates an outside-root fixture directly, since the guarded helper now rejects that setup. The lint baseline is unchanged; no CodeQL query settings, gate settings or alert states were changed.

The first hosted follow-up at `ae9ab55` passed normal CI and cleared the four memory/logging annotations, leaving 19 path annotations and the reminder shell annotation. Its positive identifier checks and quoted shell arguments were safe under the regressions but were not accepted by those query models. Explicit normalized containment checks and removal of the shell address those remaining analyzer boundaries. The reminder regression now uses the real task-metadata reader and filesystem. Hosted verification at `f990cc0` passed all four checks, including the CodeQL results gate with no new alerts. No local CodeQL CLI is installed.

The existing E2E skill's boot command was checked with preparation disabled and stopped at `.env not found at the repo root — copy .env.example and set ANTHROPIC_API_KEY`. No live instance or paid provider scenario ran. Valid task IDs and ordinary output retain their existing behavior; the security repair intentionally rejects path-shaped task IDs and correctly encodes special characters.

### Root instructions review, 2026-11-10

`AGENTS.md` is now the single root instruction file. It retains the project architecture, runtime bootstrap, development commands, E2E preparation, logging, prose, generated-changelog and Git guidance previously split across two entry points, and links to the canonical coding guide. Root `CLAUDE.md` and its obsolete formatter exception were removed. The scoped `src/memory/CLAUDE.md` remains byte-identical and is linked from the root instructions.

CI reads the npm package specifier from `package.json`'s `packageManager` field, using the existing Node/npm tools. The version is declared once rather than repeated in the workflow. Executing that exact install command with a temporary global prefix and the offline package cache installed npm 11.16.0 successfully.

`npm run check` passed under Node 24.22.2/npm 11.16.0: formatting, lint, typecheck, build and all 2,329 tests across 164 files. All 577 tracked-file hashes in the gate snapshot remained unchanged. Root guidance links resolve, and the scoped memory instructions, manifest, lockfile and lint baseline remain byte-identical. This review update changes instructions and CI version selection, with no runtime code change.

### Native package-manager selection, 2026-11-10

CI now runs `corepack enable npm` after setting up Node 24. Corepack reads the existing `packageManager` field and downloads/caches that exact npm version. This replaces both the global npm installation and the hand-written Node expression used in the preceding review update. The local-development guide documents the same activation step. Node 24 bundles Corepack; a later Node 25+ upgrade needs separate Corepack provisioning.

Qualification used Node 24.22.2 and Corepack 0.36.0, the version bundled by that Node release. Corepack created npm shims and its cache in a temporary directory, selected npm 11.16.0 directly from the unchanged manifest, and passed the complete `npm run check`: formatting, lint, typecheck, build and all 2,329 tests across 164 files. All 577 tracked-file hashes remained unchanged by the check. The host toolchain was not changed. Hosted verification of the Corepack workflow follows publication.

### Initial adoption debt and limits (historical)

The native baseline recorded **2,449 findings across 167 files**, measured after the rebase, clean install, directive cleanup, final formatting and the Vitest compatibility adjustment. The original pre-rebase snapshot had 2,405 findings across 164 files. It includes existing unsafe types/operations, non-null assertions, promise handling, runtime cycles and cleanup findings. The new check tests have no baseline entry. Baseline generation is not part of CI; routine pruning only reduces resolved allowances.

The baseline counts findings per file/rule and can miss an equal-count substitution. Config/baseline changes and code readability still require review. Hosted Linux format/lint/typecheck/build/test, gitleaks and CodeQL passed at `46059b9`; hosted checks for the Corepack workflow update remain pending. A Docker image build, provider-backed live E2E and production behavior were not exercised. The original guideline adoption preserved runtime behavior; the subsequent security edge-case changes are recorded above.

No readability or productivity benefit has been measured. The five-change evaluation follows adoption through existing PR feedback and remains pending.


### Zero-debt follow-up, 2026-11-10

The user replaced the baseline rollout with immediate remediation. `oxlint-suppressions.json`, `lint:prune` and the formatter's baseline exception are removed. The rule allowlist and severities are unchanged; there are no inline disable directives or suppressed findings. The CLI integration test now verifies that findings fail without writing allowances and that the repository contains no native suppression file.

The first unsuppressed run reported 2,449 findings across 167 files. Some were caused by missing Node ambient types in the scripts project rather than runtime defects; the root compiler configuration now explicitly includes Node types. `typecheck` also checks the nearest no-emit projects for tools and scripts, while the separate emitting Docker helper project remains intact.

Repairs use typed SDK/Bolt/Octokit contracts, checked external configuration and JSON boundaries, explicit nullable paths and test fixture assertions. Background work and timers own their rejection handling. Runtime cycles are removed by separating startup from path constants, giving the active-task map one independent owner and passing task construction/loading into schedulers. No permissions, model selection, memory audience or approval policy is intentionally broadened. Scoped memory guidance remains unchanged.

Self-review caught and corrected an attachment-identity mistake in the initial type narrowing: branch tools must update the canonical mounted repository, not a copy. New switch/create regressions exercise those updates. Additional boundary regressions cover malformed MCP connection data, CLI response validation and a refusal prompt with no parent checkpoint. Existing GitHub full-description fallback behavior is preserved by narrowing its optional wire field.

Final executed verification used Node **24.22.2** and npm **11.16.0**:

| Check | Observed result |
|---|---|
| Clean install | `npm ci` passed with the existing lockfile; dependency versions and install-script policy are unchanged. |
| Complete gate | `npm run check` passed: formatting, Oxlint with **zero findings**, all three no-emit TypeScript projects, build and **2,338 tests across 164 files**. |
| Read-only checks | All **582 tracked and task-created paths** in the final snapshot remained unchanged by the complete gate. |
| Formatting | A second full formatting pass changed no files. CLI integration tests also verify formatter idempotence and excluded-file preservation. |
| Standalone helper and CLI | `tsc -p tsconfig.scripts.json` and CLI `--help` passed; help output matched the earlier smoke snapshot byte for byte. |
| Preserved artifacts | The lockfile, generated changelog, prompts, skills and scoped memory instructions have no diff. The Oxlint allowlist and severities have no diff. |
| Docker boot | The existing E2E skill built and booted an isolated project, attested as `9722510c81c042b977dd6be1027ff616d87b4954-dirty`, healthy at `http://localhost:3001`. Fresh runtime storage and example plugins were used; Slack, GitHub, memory, proactivity and scheduled firing were disabled. |
| Live basic task | `basic-nonce` completed for `E2E-2e0e7538`, task `task-20261110-1636-5aeima`, with a PM reply and `task:completed`. Evidence was written through the validated writer to `e2e-evidence/coding-guidelines-zero-debt/basic-nonce.json` and its Markdown companion. |
| Live egress | Claude CLI **2.1.321** blocked the non-allowlisted host, reached the allowlisted host, installed an npm package and reported the Yarn proxy mapped. |
| Live approval gate | Fresh nonce `E2E-GATE-ecf94665`, task `task-20261110-1640-17210c`: zero markers before approval, one marker after approval, one approval request, read-only tool ungated. The unchanged check reported PASS. |
| Teardown | `docker compose down` succeeded; the skill verified no containers remained for the isolated project. The worktree's prepared workdir link was restored. |

The first live gate attempt did not complete: the model initially supplied `{}` to `write_marker`, then retried with `{ "value": "E2E-GATE-78e74f43" }`. The two payloads reproduced the recorded distinct digests (`0f49cf60c4472520` and `6c9b7d08a6beff48`), so the second call correctly requested another approval and no marker was written. That stalled runner was stopped, its transcript retained locally, and one unchanged-fixture rerun passed. No gate policy was relaxed to obtain the pass.

Remaining lint debt is **zero**, with no suppression file or inline disable directives. Hosted CI/CodeQL for the zero-debt follow-up await publication. The live checks cover the isolated normal task, network and approval paths; real Slack/GitHub delivery, OAuth providers, Perplexity, Bedrock and production operation were not exercised. The final refusal-checkpoint and GitHub wire-field compatibility adjustments were made after live scenarios and verified by the final full gate. Readability benefit and the five-change review evaluation remain unmeasured. The user separately authorized committing and pushing this follow-up to PR #370; no release or deployment is authorized.
