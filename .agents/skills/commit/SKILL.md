---
name: commit
description: Review the complete working tree, verify the repository, and create logically grouped Git commits without pushing. Use when the user explicitly asks to commit changes, make a commit, split work into commits, or prepare local commits for review.
---

# Commit changes

Create intentional, verified commits from the current working tree.

## Workflow

1. Confirm that the user explicitly requested commits. If not, do not commit.
2. Run `git status --short --branch`, inspect staged and unstaged diffs, and include untracked files in the review. Do not infer changes from filenames alone.
3. Read `git log --oneline -10` to match the repository's commit style.
4. Separate changes into logical groups by purpose. Keep tightly coupled files together; do not default to one commit per file or one catch-all commit.
5. Preserve unrelated user changes. If a clean logical group cannot be staged without capturing unrelated edits, stop and explain the overlap.
6. Run the narrowest relevant tests, then the build command required by the repository guidance. Resolve failures caused by the intended changes before committing. Report unrelated pre-existing failures instead of hiding them.
7. For each logical group, stage only its files, review the staged diff with `git diff --cached`, and create a concise commit whose subject explains the purpose in the repository's existing style.
8. After all commits, show `git status --short --branch` and summarize each created commit.
9. Do not push. Wait for a separate explicit push request.

## Guardrails

- Never use destructive commands to manufacture a clean tree.
- Never amend, rebase, reset, or rewrite existing commits unless the user explicitly requests it.
- Never bypass hooks or verification with `--no-verify` unless the user explicitly authorizes it after seeing the failure.
- Do not add an AI co-author trailer unless the user asks for one.
- Do not stage secrets, credentials, generated scratch output, or unrelated files.
