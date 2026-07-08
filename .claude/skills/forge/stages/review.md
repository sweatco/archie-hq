# Review mode — zero-footprint PR review & QA

**Purpose:** review and QA an existing PR *without taking it over*. Forge acts as an independent reviewer: it derives intent and ACs from the PR on its own, runs the verification rings, and reports findings to the user — the PR's author (human or Archie) stays the owner and handles the outcome. Also usable as a cheap "pre-run" before the operator tests a PR by hand.

**Invocation:** `/forge review <n>` (full), `/forge review <n> qa-only` (skip the code-review ring; report only, never submits to GitHub).

## Ground rules (how this differs from a run)

- **Zero footprint.** Never commit, push, or modify the PR's branch or any branch. No change dir, no `forge.yaml`, no committed artifacts — working notes and QA evidence live in a local uncommitted scratch directory and the deliverable is the chat report (plus, on approval, the GitHub review). Wipe or ignore the scratch on exit.
- **No questions during analysis.** Unlike `pr` mode there is no inception interview: derive the ACs and intent yourself from the PR description, linked issues, review threads, and the code. Every assumption you had to make is *flagged in the report*, not asked upfront — the user corrects you at the findings stage.
- **Exempt from one-run-at-a-time.** Reviews write nothing, so they can run alongside an active Forge run or other reviews (e.g. in separate worktrees). The one shared resource is docker during QA: one live boot at a time unless each checkout uses a distinct `PORT` (compose project names already differ per directory).
- **Worktree-friendly.** This mode is designed to run in a worktree so the operator's main checkout stays free. The docker boot needs the gitignored local state (`.env`, `secrets/`) — copy or symlink them from the main checkout into the worktree before QA; if that's not possible, degrade QA to coverage-and-suite only and say so in the report.

## Flow

**1. Silent inception + grounding.** Reverse-inception's research pass, unchanged: diff mapper, codebase context, base-branch drift, fact-checked by the research verifier. From the PR materials + dossier, derive the intent and a numbered AC list with verification methods — best effort, assumptions marked. The PR's own "couldn't verify" admissions become ACs to actually verify.

**2. Review ring** (skipped in `qa-only`). Fresh-context reviewers in parallel, as in Stage 3 but judging against the *derived intent* instead of a plan: the spec-compliance reviewer (does the diff do what the PR claims, and nothing beyond it) and the adversarial bug hunter (logic errors, lifecycle/races, broken invariants, mutation-check the PR's new tests). Findings classified CONFIRMED/PLAUSIBLE with `file:line`.

**3. QA ring.** As Stage 4, blind roles, evidence to the local scratch: map each AC to existing unit/integration coverage (name the test or the gap), run the suite, and drive `live-e2e` ACs against an instance booted from the PR's branch via the `archie-e2e` skill. ACs that can't be verified in this environment are reported as unverified with the reason — never silently skipped.

**4. Findings report (chat, human gate).** One message: derived intent + ACs (assumptions flagged), per-AC verdict table with evidence, review findings ranked by severity, and an overall recommendation (approve / request changes / needs discussion). Nothing has touched GitHub yet.

**5. Iterate.** The user corrects assumptions or points at gaps → run the delta (only the affected lenses/ACs), update the report. Repeat until the user is satisfied.

**6. Submit on approval only.** On the user's explicit go, post the review to the PR: summary verdict plus the findings as line-anchored comments where they have a `file:line`. Attribute honestly — the review states it's an Archie/Forge review so the author knows what they're replying to. Then stop: the author handles it.

**7. Follow-up rounds (same session).** When the author pushes corrections, the user says "another round": diff only what changed since the last reviewed SHA, check each previously reported finding (fixed / unaddressed / regressed), re-run QA only for ACs the new commits touch, and report. Submitting the follow-up review again requires the user's go.
