# Stage 0 — Inception

**Purpose:** turn a raw idea, issue, or PR into a signed-off brief whose acceptance criteria are the contract every later stage verifies against.

**Inputs:** the invocation input (idea text / issue body / PR description + linked issues + diff summary).

**Output:** `brief.md` in the change dir, plus the `acceptance_criteria` block in `forge.yaml`.

## Procedure

You are the interviewer. Interview the user until the brief is unambiguous. Ask in small batches (AskUserQuestion or plain chat), never a wall of questions. Do **web research** instead of asking when an external fact answers better than the user can (SDK capabilities, API limits, third-party behavior) — cite sources in the brief.

The brief must contain:

- **Problem** — what's wrong or missing, in the user's terms.
- **Goals / Non-goals** — non-goals are load-bearing; scope creep at Stage 3 is judged against them.
- **Constraints** — architectural, security, compatibility, deadline.
- **Affected repos** and rough blast radius; risk class (docs-only / plugins-only / engine / engine+migration).
- **Acceptance criteria** — numbered, each one *observable* ("WHEN X THEN Y", not "should work well"). For each AC, force the verification method now: `unit`, `integration`, `live-e2e` (dockerized instance driven via archie-debug MCP), `manual`, or `deploy-only` (name the post-merge step). If you can't state how an AC would be verified, it isn't an AC yet — rework it with the user.

Ask explicitly: "how would we know this works end to end?" — the answer usually surfaces the ACs the user actually cares about.

### Reverse inception (`pr` mode)

**Research before brief.** Do not build the brief from the PR's description alone — the description is the author's claim, not ground truth. Before presenting anything, run a code-grounding pass with Stage 1's machinery (fresh-context lenses, in parallel; output contract: factual claims with `file:line` citations):

- **Diff mapper** — what the diff actually does, function by function; where it diverges from or exceeds what the PR description claims.
- **Codebase context** — the subsystems the diff touches, the patterns and invariants there, existing test coverage for the touched area.
- **Drift check** — what changed on the base branch since this PR branched (commits touching the same files, merged PRs in the same territory); flags for likely conflicts or invalidated assumptions.

Run the Stage 1 research-verifier pass over the merged findings, then write the surviving dossier to `research.md` — it feeds the brief and later stages exactly as in a full run.

Then reconstruct the brief from the PR **and** the dossier: description (What & why / Verification sections), linked issues, review comments, and what the code actually shows. Mark every reconstructed item as **inferred** and have the user confirm or correct it; where the dossier contradicts the PR's claims, surface the contradiction explicitly in the brief. Always ask: "what would make you comfortable merging this?" — their answer becomes ACs. Pay special attention to the PR's own "couldn't verify" admissions: each becomes an AC with method `live-e2e` or an explicit `deploy-only` waiver.

Because Stage 2 is normally skipped in `pr` mode, reverse inception also writes `verification-plan.md`: the AC table expanded with the concrete scenario/check that will produce each AC's evidence and where the evidence will live (Stage 4 requires this file).

## Exit criteria (human gate)

Render the brief **in the chat message** — problem, goals, non-goals, constraints, risk class, and every AC verbatim with its verification method — then ask for sign-off. The rendering must include an explicit **"QA limitations"** callout listing every AC the QA stage will NOT be able to verify itself — method `manual` or `deploy-only`, and `live-e2e` when the harness or docker is known to be unavailable in the run's environment — each with what it will ship as instead (the named post-merge or human step). The user accepts that trade-off now, at sign-off, not by surprise in the PR's waiver list; if too much of the brief is unverifiable, that's the moment to rework the ACs or the approach. Writing `brief.md` is persistence, not presentation: the user must be able to approve or correct without opening any file or tool output. Only after explicit sign-off: record ACs in `forge.yaml`, set `stage: research` (or `implement` in `pr` mode with no open design questions), create the branch, commit `brief.md`.
