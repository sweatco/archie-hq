# Coding guidelines review of PR #370

Status: review and repairs verified locally on 2026-11-10.

## Scope and method

Reviewed the code/configuration diff for [PR #370](https://github.com/sweatco/archie-hq/pull/370), starting at `c2f4cad`, against the [coding guidelines and five-question rubric](../guides/coding-guidelines.md). The fetched base was `a953f21`; the branch merge base was `26821b1`. No branch synchronization or remote write was performed during this review.

The inventory contains 304 code/configuration paths, excluding the generated lockfile and Markdown. Applying the committed Prettier configuration to both revisions makes 120 files identical; 184 have additional changes. Normalization was used to navigate those changes, not to declare them readable. The review inspected substantive changes, callers, fixtures and complex guards in the formatted code. Repeated assertion substitutions were inspected as a pattern; test expectations removed or weakened by the cleanup received a separate pass. Generated lockfile changes were considered through the pinned dependency configuration and successful checks.

| Area, including its tests | Changed paths | Paths with changes beyond formatting |
|---|---:|---:|
| Agents | 40 | 28 |
| CLI | 14 | 10 |
| Connectors | 48 | 23 |
| Memory | 31 | 17 |
| Proactivity | 36 | 23 |
| System services | 50 | 33 |
| Tasks | 38 | 29 |
| Test support, shared types and utilities | 6 | 3 |
| Tools and scripts | 27 | 11 |
| Root configuration, workflows and examples | 14 | 7 |
| Total | 304 | 184 |

## Findings and repairs

- **Readable invariants (guidelines 2 and 4):** `approvedReplyConversation` mixed lookup, DM/thread validation and destination consistency in one condition. Split those stages and name their domain checks while retaining every validation and the existing error. Extend prepared-task regressions for missing conversations, public channels, invalid timestamps and competing home channels.
- **Boundary correctness and ownership (guidelines 1, 5 and 6):** the lint cleanup made optional `updateMessage` blocks mandatory at runtime. A new regression reproduced the rejection before repair. Omitted blocks now reach the SDK as omitted; an empty array still clears blocks. Share one block schema for untyped caller input and pass internally constructed message blocks directly to the SDK.
- **Visible control flow (guidelines 2 and 8):** replace the nested conditional that selected initiative buttons with a local `deliveryActions` operation and early returns. Existing tests retain owner-only buttons and public-message behavior.
- **One error handler at the relevant boundary (guideline 7):** remove redundant nested catches from task-detail loading/sending, debounced task persistence and GitHub check notifications. Keep the UI error state and contextual task/notification logs at the caller that owns the background operation.
- **Useful names and abstractions (guidelines 4 and 8):** give repeated Git-command error formatting a local owner instead of embedding nested conditionals in error messages. Remove aliases that obscured which generated JSON schema was being changed, and place the research API comment beside its function.
- **Readable, sufficient tests (guidelines 2, 5 and 10):** simplify nested defined-value assertions, use the existing checked MCP handler lookup across fixtures and remove a duplicate GitHub-client setup. Replace matcher casts and repeated response-parsing schemas with direct assertions. Restore merge-approval timestamp checks and compare the built-in MCP configuration before and after OAuth injection.

Kept authorization checks at their existing operations, the active-task map under one owner, startup dependencies separate from path constants and scheduler dependencies explicit. Homogeneous wire-field checks and inline path-containment guards retain their safety rationale. No rule severity, suppression policy, prompt, skill, generated changelog or public runtime API was changed.

## Verification and limits

- The new text-only Slack-update regression failed with the original array-schema error, then passed after repair. The empty-array case also passes.
- Focused task-destination, Slack-client, research and pin-summary verification passed: 156 tests across four files.
- Compared the original and revised destination function across 3,648 valid/malformed metadata combinations. Returned values and error names/messages matched in every case; this is bounded equivalence evidence, not a proof over arbitrary JavaScript objects.
- `npm run check` passed under Node 24.22.2 and npm 11.16.0: formatting, zero lint findings, all three TypeScript projects, build and 2,344 tests across 164 files. A sandboxed run initially blocked the API test's localhost connection; the final run with localhost access passed.
- Standalone Docker Git-helper compilation (`tsc -p tsconfig.scripts.json`) passed. The CLI help entry point (`node --import tsx src/cli/index.tsx --help`) matched the previously recorded output byte-for-byte. `git diff --check` passed.
- Live Slack delivery and model-backed E2E were not rerun for these local repairs. The Slack regression exercises the real client function with a mocked SDK transport. Earlier live evidence in the [adoption record](20261109-coding-guidelines-and-checks.md) belongs to the previous implementation and is not a fresh pass for this follow-up.

No further blocking findings were identified in the reviewed diff. Existing code can still benefit from later maintenance; the review does not establish universal readability or replace the planned five-change maintainer evaluation. Local verification does not establish the result of hosted checks for the follow-up commit.
