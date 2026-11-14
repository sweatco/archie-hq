# Agent completion hooks

> **Historical record — filing review 2026-11-11.** Current documentation: [Coding guidelines](../guides/coding-guidelines.md). Original design and verification claims below describe their recorded revision; they are not current implementation instructions.

Status: simplified, verified live and passed the complete repository check on 2026-11-11.

## Outcome

Project-level Claude Code and Codex `Stop` hooks invoke one shared 70-line script to run the existing lint and formatting commands. The [coding guide](../guides/coding-guidelines.md#agent-completion-hooks) owns behavior; [local development](../guides/local-development.md#agent-completion-hooks) owns activation.

Every applicable Stop runs `npm run lint` and `npm run format:check` over the whole checkout. Both run even when the first fails. File selection stays with those commands. The earlier change detection, Prettier discovery, content fingerprints and successful-check cache were removed. The hook has no persistent state and does not rewrite source.

The remaining guards have concrete purposes: skip plan mode and ignored runtime directories, bound each command to 30 seconds, limit diagnostic output and allow only one automatic correction pass. The next Stop reruns the checks and warns about unresolved failures instead of creating another continuation. Checks can report another contributor's edits; feedback explicitly requires preserving unrelated work.

## Native verification

| Client/path | Observed result |
| --- | --- |
| Claude Code 2.1.319, project settings | A real model turn emitted a successful `Stop` hook response with stdout `{}` and exit code 0. |
| Claude Code, intentional lint and format failures | First Stop returned `decision: block` with both actual CLI diagnostics; the continued turn returned the retry-exhausted warning and stopped. Two model turns; no tool calls or fixture repairs. |
| Claude Code, plan mode | With the failure fixture still present, native `Stop` returned `{}` without continuing. |
| Claude Code, ignored runtime directory | With the project settings explicitly supplied and the failure fixture still present, native `Stop` returned `{}` without continuing. Plain project discovery from that ignored directory did not load the hook, so the explicit-settings case established the script guard. |
| Codex CLI 0.167.0, exact command supplied as a temporary session override | Native hook review showed one active, trusted Stop after review of the exact command. A real model turn displayed “Running hook” and completed successfully. |
| Codex CLI, intentional lint and format failures | Native `HookPrompt` contained both real diagnostics. The model reported the intentional fixture as a blocker; the second Stop displayed “automatic retry is exhausted” and completed. No tool calls or fixture repairs. |

The deliberate TypeScript failure fixture was removed after these runs. The Claude tests used the existing local API credential without printing or copying it; Codex used its existing ChatGPT login. The single temporary-session hook definition was trusted through Codex's native UI; no trust bypass or global hook definition was added.

## Codex linked-worktree discovery

A controlled standalone repository and linked worktree contained distinct hook definitions. Native `hooks/list` from the linked worktree selected the primary checkout's `.codex/hooks.json`, not the linked worktree's file. Archie's primary checkout does not yet contain this new configuration, explaining its missing project entry during initial inspection.

Live Codex tests therefore supplied the exact repository command as a temporary session configuration and completed native trust review. Automatic project discovery in this existing worktree will require the configuration in the primary checkout through the normal Git workflow, followed by native hook review. The primary checkout was left unchanged. The [official OpenAI documentation](https://learn.chatgpt.com/docs/hooks) describes project and definition trust; [Claude's reference](https://code.claude.com/docs/en/hooks) documents its settings and Stop contract.

## Other verification and limits

- Eleven focused tests pass: repeated full checks, root/subdirectory execution including spaces, both command failures, retry bounds and correction, real CLI diagnostics, read-only source behavior, missing dependencies, malformed input, plan/runtime guards and both configuration commands.
- A real npm script intentionally hung beyond the command timeout. The hook returned after 30.16 seconds, reported `ETIMEDOUT`, still ran the formatting command and left no live lint child process.
- `npm run check` passed on Node 24.22.2 and npm 11.16.0: formatting, zero lint findings, source/tools/scripts type checks, build and **2,355 tests across 165 files**. A before/after content comparison found all 587 tracked/task paths unchanged by the command.
- Windows invocation is unverified. Local hooks provide feedback and bounded retries; required CI checks remain authoritative. No runtime engine behavior, lint rules or suppression policy changed.

The completion hooks are a separate change from the coding-guidelines adoption.
