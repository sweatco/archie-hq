---
name: "Forge"
description: Run the Forge v2 loop — idea or issue in; verified, tested pull request out (one sign-off, workflows do the rest)
category: Workflow
tags: [workflow, verification, forge]
---

Run the Forge v2 development loop on one unit of work.

**Usage**

- `/forge <idea text>` — full run from the clarifying interview
- `/forge issue <n>` — seed the interview from a GitHub issue
- `/forge review <n>` — zero-footprint review + QA of an existing PR; findings in chat, review submitted only on approval (add `qa-only` to skip the code-review ring)

**Steps**

1. Load the `forge` skill and follow it as the conductor playbook.
2. Pass the argument after `/forge` as the invocation input. If no argument was given, ask the user what to forge (an idea or an issue number).
