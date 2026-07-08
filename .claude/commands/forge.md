---
name: "Forge"
description: Run the Forge loop — idea, issue, or PR in; verified, tested pull request out
category: Workflow
tags: [workflow, verification, forge]
---

Run the Forge development loop on one unit of work.

**Usage**

- `/forge <idea text>` — full run from inception
- `/forge issue <n>` — seed inception from a GitHub issue
- `/forge pr <n>` — finish, verify, and ship an existing PR (takes ownership)
- `/forge review <n>` — zero-footprint review + QA of an existing PR; findings in chat, review submitted only on approval (add `qa-only` to skip the code-review ring)
- `/forge resume` — continue the active run from its recorded stage
- `/forge abandon` — mark the active run abandoned (unblocks the one-run-at-a-time guard)

**Steps**

1. Load the `forge` skill and follow it as the orchestrator playbook.
2. Pass the argument after `/forge` as the invocation input. If no argument was given, ask the user what to forge (an idea, an issue number, or a PR number).
