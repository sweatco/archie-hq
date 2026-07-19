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
- `/forge revise <request>` — apply a requested change to a shipped Forge PR through the full machinery (request-mode implement + blind review + QA + docs + PR refresh); works cross-session via the run's `docs/plans/` record
- `/forge review <n>` — zero-footprint review + QA of an existing PR; findings in chat, review submitted only on approval (add `qa-only` to skip the code-review ring)
- `/forge review` — same, for the current working tree as-is against main (uncommitted changes included; nothing touches GitHub or your checkout)
- `/forge qa <n>` — QA-only review of PR n (alias for `review <n> qa-only`)
- `/forge qa ["intended behavior"]` — QA the current working tree as-is; the quoted intent (optional) becomes the authoritative source for deriving ACs

**Steps**

1. Load the `forge` skill and follow it as the conductor playbook.
2. Pass the argument after `/forge` as the invocation input. If no argument was given, ask the user what to forge (an idea or an issue number).
