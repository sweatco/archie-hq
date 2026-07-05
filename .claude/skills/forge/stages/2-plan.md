# Stage 2 — Plan

**Purpose:** produce the OpenSpec plan artifacts plus a verification plan, hardened by two different critics. The plan is **published, not gated** — the run proceeds after publishing.

**Inputs:** `brief.md` + `research.md` (nothing else — the planner must not see the interview or your reasoning).

**Outputs:** `proposal.md`, `design.md`, `tasks.md`, `specs/<capability>/spec.md` (OpenSpec shapes), and `verification-plan.md`.

## Procedure

Spawn a **planner** subagent with the brief + dossier. It writes the OpenSpec artifacts (use the `openspec` CLI scaffolding/templates when available; otherwise follow the archived-change structure) and `verification-plan.md`: a table mapping every AC id → verification method → the concrete scenario/check that will produce the evidence → where the evidence will live. `tasks.md` items must be small, ordered, and independently checkable (typecheck/tests per task).

## Verification loop (2 critics, cap: 3 rounds)

Spawn both critics **concurrently**, fresh-context, inputs = brief + dossier + the plan artifacts only.

**Completeness critic:**

> You verify a plan covers its contract. Inputs: brief (with ACs), research dossier, plan artifacts. For each AC: is it fully satisfied by the design, and does the verification plan give it a concrete, evidence-producing check? Then hunt for what's missing: edge cases, error paths, migrations for persisted state, rollback, recovery/restart interactions, docs the repo expects. Verdict: PASS, or a numbered list of gaps, each tagged blocking/non-blocking.

**Red team:**

> You try to kill this plan. Inputs: brief, dossier, plan artifacts. Attack: (1) blast radius — what else does this touch that the plan doesn't mention? (2) security & sandbox — does anything widen access or violate the constraints in the dossier? (3) simplicity — propose a materially simpler design that meets all ACs; if you can, the plan is over-engineered. (4) "what will this break that no test covers?" Verdict: PASS, or numbered objections, each tagged blocking/non-blocking.

Feed blocking findings back to the planner for revision; re-run only the critic(s) whose findings were addressed. Track rounds in `forge.yaml` `stage_rounds.plan`. If blocking findings survive round 3, stop and take the impasse to the user.

## Exit criteria

Both critics PASS (or only non-blocking notes remain — record them in `design.md` under "Known trade-offs"). **Publish**: post a compact summary of the plan to the user (goal, approach, task count, verification plan highlights, known trade-offs) and proceed without waiting. Commit artifacts + verdicts, set `stage: implement`.
