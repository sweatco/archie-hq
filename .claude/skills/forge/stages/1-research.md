# Stage 1 — Research

**Purpose:** ground the plan in verified facts about the codebase, prior art, constraints, and (when flagged) the outside world.

**Inputs:** `brief.md`. **Output:** `research.md` (the dossier) — only claims that survived the refutation pass.

## Procedure

Spawn the applicable lenses **in parallel** as fresh-context subagents. Each gets: the brief, its lens instructions below, and the output contract "return findings as a list of factual claims, each with a `file:line` citation or source URL; flag uncertainty explicitly."

- **Codebase mapper** — which subsystems the brief touches, the existing patterns to follow (with `file:line`), the tests that cover the area today, and the seams the change should use. Read `docs/architecture/` first.
- **Prior-art scanner** — open PRs, recently closed PRs, open issues, `docs/plans/`, `docs/proposals/`, and `openspec/changes/archive/`. Goal: nothing in flight collides with or already solves this; name anything the plan should build on or supersede.
- **Constraints scanner** — architecture docs, `docs/architecture/security.md`, sandbox rules, edit-mode gate, plugin spec compliance. Return the constraints the design must not violate.
- **Web researcher** (only when the brief flags external unknowns) — upstream SDK/API docs and changelogs; every claim cited with a URL.

Merge the findings into `research.md`, keeping citations.

## Verification pass (1 round)

Spawn a **research verifier** (fresh context) with this role:

> You are an adversarial fact-checker. Input: `research.md` and read access to the repo. For each factual claim, try to REFUTE it against the actual code or the cited source. Verdict per claim: CONFIRMED (you saw it yourself) / WRONG (say what's actually there) / UNVERIFIABLE (no citation, or citation doesn't support it). Do not evaluate the design direction — facts only.

Write the verdict to `verdicts/research-verifier-round1.md`. Delete WRONG claims, fix or delete UNVERIFIABLE ones (re-check yourself; keep only what you can now cite). Research that hallucinates poisons every later stage — be ruthless here.

## Exit criteria

Dossier contains only CONFIRMED claims. Commit `research.md` + verdict, set `stage: plan`.
