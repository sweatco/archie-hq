# Proposal: Forge v2 — ephemeral, workflow-orchestrated idea → verified PR loop

> **Status:** Accepted — in execution. Supersedes the staged-skill design previously in this file (accepted June 2026, implemented as `.claude/skills/forge/`). The verification philosophy of v1 — fresh-context adversarial reviewers, progressive blindness, capped loops, structured verdicts, live black-box QA — carries over unchanged. What changes is the execution substrate and the state model.

## Summary

Forge takes one unit of work — an idea described in chat or a GitHub issue — and produces a verified, end-to-end-tested pull request, with exactly **one human intervention** (acceptance-criteria sign-off) between intake and the open PR. v2 rebuilds the loop on Claude Code **dynamic workflows** (the `Workflow` tool): the stage sequence, fan-outs, revision caps, and verdict contracts become deterministic control flow in a script instead of prose rules an orchestrating model must remember to follow. Runs are **ephemeral and single-session**: no run state is committed to the repo, no cross-session resume exists, and the **pull request is the only artifact**. If a session dies mid-run, the run is restarted fresh.

Forge v2 is one step toward a self-improvement loop for Archie: today the single human gate lives in chat; the architecture is built so that gate can later migrate to the GitHub issue conversation, making the loop fully issue-driven and headless.

## Why v2

v1 (see git history of this file) designed the right verification loop but put it on the wrong substrate, in two ways.

**The orchestrator was a conversation.** A long-lived chat context degrades over an hours-long run — it gets summarized, drifts, and can violate its own rules (leaking context to "fresh" reviewers, looping past caps, skipping a verdict). v1 compensated with bold prose: "never include your history", "capped loops", "a pass with no written verdict did not happen". In a workflow script every one of those rules becomes structural: `agent()` calls are context-blind by construction, caps are `while (round < 3)`, verdicts are schema-forced structured output, and stage order is sequential `await`s. The guarantees stop being aspirations and become properties of the control flow.

**The state model served a persona we don't have.** `forge.yaml`, the OpenSpec change directory, cross-branch run scans, `/forge resume`, `/forge abandon`, stage-boundary state commits — all of it existed so a human operator could resume an interrupted run days later on a laptop. The actual target persona is a session (eventually headless) that picks up work, runs to a PR, and dies. For that persona the durable, human-facing state already has a home: the issue thread and the PR. Killing the in-repo state deletes roughly a third of v1's rulebook because the rules' reason-for-being evaporates.

## Design principles

- **Ephemeral, single-session runs.** Run state lives in the workflow script's variables and the session. Nothing about the run is committed to the repo. A dead session means a fresh restart — and a fresh restart **recreates the feature branch from base**, so a half-implemented branch from a dead run never leaks into a new run that may plan differently.
- **The PR is the only artifact.** Brief, acceptance criteria, and the verification manifest (AC table with evidence and explicit waivers) live in the PR description. Durable documentation lives where documentation already lives (`docs/`), updated by a dedicated stage inside the run. Durable regression value lives as real tests committed in the PR. No OpenSpec, no `forge.yaml`, no verdicts directory.
- **Human gates are seams between workflows, never pauses inside them.** Workflows run autonomously to completion or to a structured early return. The one in-chat intervention (AC sign-off) sits between the research workflow and the main run workflow. The merge decision already lives on GitHub — the session ends when the PR is open.
- **Guarantees as control flow.** Fan-outs, blindness, caps, and verdict schemas are encoded in the workflow scripts. A stage cannot be skipped, a loop cannot exceed its cap, and a verification pass cannot fail to produce a verdict.
- **Bounded changes only.** A sizing judgment after research either confirms the change fits one run or routes into a split that decomposes it into independently shippable iterations filed as GitHub issues (see Split below).

## Architecture

A thin **conductor skill** (`/forge`) owns everything interactive; **workflows** own everything autonomous.

```
/forge <idea | issue N>
  1. conductor: clarifying questions in chat
  2. Workflow forge-research → fact-checked dossier (returned as JSON, committed nowhere)
       └─ tail: sizing judge — does this fit one run?
  3a. FITS    → conductor drafts brief + numbered ACs from the dossier
  3b. TOO BIG → decomposition proposes independently shippable iterations
  ── THE human intervention: sign-off in chat on the brief+ACs (3a)
     or on the split (3b → issues filed, run continues with iteration #1) ──
  4. Workflow forge-run(brief, ACs, dossier)
       plan       planner → completeness critic ∥ red team, capped revision loop
       implement  branch created off base; per-task implementer agents commit;
                  spec-compliance reviewer ∥ adversarial bug hunter (mutation-
                  checked tests), capped loop
       qa         boot from branch (archie-e2e harness), drive the debug MCP,
                  black-box evidence per AC; independent verdict reviewer
       docs       locate the docs describing the touched subsystem, update them,
                  adversarially verify doc-vs-diff; rides in the same PR
       ship       push branch, open PR — verification manifest as the
                  Verification section
       returns { status: done, pr, manifest, plan, ... }
             | { status: impasse, stage, question, context, reason?, terminal? }
  5. conductor: report PR + manifest summary in chat. Session's job is done.
     The merge decision happens on GitHub, on the operator's schedule.
```

The conductor: parses the invocation (idea text or `issue <n>`), runs the interview, launches the workflows, presents gate content **verbatim in chat** (the full brief and every AC — the operator must be able to decide without opening anything), files split issues after approval, handles impasse round-trips, and reports the result. It performs no verification itself.

`forge-run` composes the stages as child workflows (`workflow('forge-plan')` etc. — one level of nesting, which is the platform limit), so each stage is independently testable and independently invocable by the conductor — which is also how PR-mode entry (`/forge pr <n>`-style "finish this PR") slots in later: run the chain starting at implement.

### Stage contracts

Every stage keeps v1's verification structure, now schema-enforced:

- **Research** — parallel lenses (codebase mapper, prior-art scanner, constraints scanner, web researcher when flagged) → merged dossier → one adversarial fact-checking pass that refutes each claim against code or cited source; only CONFIRMED claims survive. Output: structured claim list with `file:line`/URL citations.
- **Plan** — planner (input: brief + dossier only) → verification plan mapping every AC to its method (unit / integration / live-e2e / manual / deploy-only) → completeness critic and red team run concurrently → capped revision loop (3 rounds).
- **Implement** — feature branch created from base; tasks executed sequentially by implementer agents that commit per task (a fresh agent per task keeps contexts small; the branch, not a checklist file, is the progress record); full gate (typecheck, build, tests) → spec-compliance reviewer and adversarial bug hunter run concurrently, blind to implementer reasoning; every new test mutation-checked; capped loop (3 rounds).
- **QA** — receives only the ACs and verification plan (deliberate ignorance, per the QA plugin's model: never the implementation diff; the test suite itself is fair game, since naming a covering test case is part of the job); boots the system under test from the branch via the archie-e2e harness; drives real scenarios through the archie-debug MCP; records evidence per AC; a second independent reviewer rules each AC verified / unverified / waived-with-named-post-merge-step. Failures route back to implement with the failing scenario attached.
- **Docs** — a locator/updater agent finds the `docs/` pages describing the touched subsystem (or determines a new page is warranted) and updates them to match what actually shipped; a fresh verifier reads the updated docs against the diff — stale claims, missed sections, and invented behavior are findings. Runs after QA so docs describe verified behavior; merges atomically with the code.
- **Ship** — assemble the PR in house style (What & why / How it works / Verification), the manifest as the Verification section, push, open the PR ready-for-review. CI-watching and review-feedback handling use the session's existing PR-subscription machinery, outside the workflow.

### Review mode (`/forge review <n>`)

The zero-footprint mode from v1 survives, and it is the purest workflow of all — stateless fan-out, no gates, nothing written. It also reviews the **local branch**: `/forge review` / `/forge qa` without a PR number run the same machinery on the current checkout's committed diff against base — intent derived from commit messages, or taken verbatim from the operator (`/forge qa "intended behavior"`), with uncommitted changes flagged as unreviewed. `/forge qa <n>` is the QA-only alias for PRs. `forge-review` reviews and QAs an existing PR **without taking it over**: an ephemeral worktree isolates the checkout; fact-checked lenses (PR context, diff mapper, base-drift check) ground it; an agent derives the intent and numbered ACs from the PR autonomously with every assumption flagged (the PR's own "couldn't verify" admissions become ACs); the review ring (claims-vs-diff + adversarial bug hunter with mutation-checked tests, skipped in `qa-only`) and the blind QA ring run against the derived contract; the worktree is torn down. Unlike `forge-run` it never impasses — a dead agent or unavailable infra degrades into an explicit `gaps` entry in the report rather than a stop. The conductor renders the report in chat, iterates via relaunches with the operator's corrections, and — only on the explicit go — submits the review to GitHub with honest attribution and line-anchored comments. Follow-up rounds relaunch with the previously reviewed SHA and findings, ruling each fixed / unaddressed / regressed. Review mode is exempt from one-run-per-session (it writes nothing); its only shared resource with an active run is the docker boot during live QA.

## Split: bounded changes, issues as the queue

A single run cannot safely absorb an arbitrarily large change — the caps, the single QA boot, predictable cost, and the single-session lifetime all assume a bounded diff. Sizing happens **after research, not before**: the codebase decides how big a change is, not the idea's text.

The sizing judge at the tail of `forge-research` returns fits-one-run or too-big with reasons (subsystems touched, migration surface, AC count, cross-repo reach), and on too-big proposes the ordered iterations itself, under one hard rule: **every iteration must be independently shippable and independently QA-able** — its own observable behavior, verifiable against a live instance, safe to merge alone. A split where some iteration's only AC is "code exists" is rejected. The conductor presents the split at the same single gate; on approval it files one GitHub issue per iteration and proceeds with iteration #1 in the current session.

Sizing will sometimes be wrong late — the plan stage discovers the change is deeper than the dossier suggested. That is not a failure mode but a detour: the planner has an explicit escape hatch (declare `exceedsScope` with a proposed split instead of forcing a plan), which surfaces as `{ status: 'impasse', stage: 'plan', reason: 'exceeds-scope', context: { proposedSplit } }`, and the conductor routes it into the split path — file the issues, start a fresh run for iteration #1.

Split is what turns Forge from a one-shot tool into a **queue generator whose queue is GitHub issues** — the exact substrate the future issue-driven loop consumes, one bounded run per issue, serially.

## Impasse protocol

Workflows never pause for humans; they **return early with a structured impasse**: `{ status: 'impasse', stage, question, context }`. The conductor surfaces the question in chat, collects the answer, and relaunches the same script with `resumeFromRunId` plus the answer in `args`. Completed `agent()` calls with unchanged prompts return cached results instantly, so the run re-enters at the point of the impasse rather than restarting. Legitimate impasse reasons match v1's escalation rules: an unverifiable AC, a genuine scope change (including exceeds-scope), or a revision cap hit with unresolved findings.

### Validated mechanics

The impasse → answer → resume round-trip is the hinge of the whole design, so it was probed live with a minimal two-stage workflow before this proposal was finalized: stage A leaves an observable side effect (appends a line to a marker file) and reports the line count; the script then returns a structured impasse unless `args.answer` is present; the run is then resumed from its run ID with the answer supplied. Findings:

- **The round-trip works.** The resumed run returned stage A's **cached** result instantly (0 subagent tokens, the marker file never gained a second line — the side effect did not repeat), executed only the post-impasse stage live, and read the human's answer from `args`.
- **Editing the script between resumes does not invalidate the cache**, as long as the completed `agent()` calls' `(prompt, opts)` pairs are unchanged — the fix below was applied mid-probe and stage A still replayed from cache. This means impasse handling can even ship small script corrections without losing completed work.
- **`args` can arrive as a JSON string rather than an object** (it did in the probe, silently re-triggering the impasse branch because `args.answer` was undefined on a string). Every Forge script must defensively normalize: `const input = typeof args === 'string' ? JSON.parse(args) : args`.
- Two rules follow from cached calls being matched on their exact `(prompt, opts)` pair: **pre-impasse agent prompts must never interpolate values that change between launches** (the human's answer is interpolated only into post-impasse prompts), and impasse answers always travel via `args`, never by editing prompts in the script.
- Replay is **positional**: the longest unchanged prefix of the call sequence replays from cache, and from the first divergent call onward everything runs live. This is what makes repeat-round loops sound — a re-review or re-QA after a live fix executes fresh even when its prompt is byte-identical to an earlier round's, because it sits after the divergence point. It is also why a call that previously returned a *failure* needs a differently-prompted retry path (activated by the operator's answer) to escape: unchanged, it replays its cached failure and re-impasses.

## What v1 machinery is deleted

- `forge.yaml` and its schema — the script's variables are the run state.
- The OpenSpec change directory, verdict files, and stage-boundary state commits — verdicts are schema-forced return values; the manifest lands in the PR body.
- The one-run-at-a-time cross-branch scan — a run is a session; running workflows are visible in the task list and stoppable there.
- `/forge resume` and `/forge abandon` — session death or TaskStop is abandonment; restart is fresh (branch recreated from base).
- The "Forge state is not scope creep" rules, `.gitattributes` linguist-collapse, and reviewer exemptions for `openspec/changes/` — nothing is committed, so nothing needs exempting.
- OpenSpec integration in Forge — replaced by the docs stage updating real documentation in the PR itself (see Relationship to OpenSpec below; the repo's `openspec/` directory itself stays).

## Relationship to OpenSpec

Forge v2 stops **using** OpenSpec, but the repo keeps the `openspec/` directory untouched — the archive and specs library remain valuable history, and the `opsx` skills keep working for anyone who wants them. What happens to each thing OpenSpec provided:

- **Artifact shapes** (`proposal.md` / `design.md` / `tasks.md` decomposition discipline) — kept, relocated: the plan stage's agents emit exactly these structures as **schema-enforced structured output**, validated at generation time with retries. That is stronger enforcement than CLI validation of a markdown file after the fact, and the artifacts flow between stages as data instead of being committed.
- **AC rigor** — was never OpenSpec's; the numbered-testable-ACs-with-declared-method contract is Forge's own inception discipline, now also schema-enforced at the gate, and — unlike anything OpenSpec did — actually *verified* per-AC by the QA stage with evidence published in the PR manifest.
- **The living spec library** (`openspec/specs/`, archive-on-merge) — Forge no longer writes to it. The durable, verified requirements corpus accumulates elsewhere: tests are executable specs, the future smoke suite is a verified scenario library, and every merged Forge PR carries its ACs + evidence in the description (a queryable AC history on GitHub for free). **Named re-entry path:** if real runs show the research stage suffering from the lack of a structured requirements corpus, the docs stage grows one agent that also emits the run's ACs as scenarios into a specs folder — a one-agent addition, no architectural change. Decide from observed pain, not anticipated pain.

## Future phases

- **Gate migration to GitHub.** The clarifying questions and the brief/AC sign-off move from chat to the source issue's conversation; the session waits on (or is re-triggered by) the human's issue reply. Nothing structural changes — the gate is already a seam between workflows; only its transport moves. This completes the issue-driven loop: issue in, questions and brief in the thread, PR out.
- **Smoke-test suite.** QA scenarios worth keeping get promoted into a smoke suite in the repo, run as a CI check on PRs before merge — the regression flywheel with a durable home in the test surface rather than run-state.
- **Auto-merge on green.** v2 ends at "PR open, ready for review"; merging stays human. Auto-merge on green CI + clean smoke suite is earned after the loop has produced a track record of clean runs.
- **PR-mode entry.** "Finish this PR" — taking over and completing someone's PR — re-enters the chain at implement with a reverse-inception research pass. (Zero-footprint review mode, by contrast, ships in v2 — see Review mode above.)

## Open questions

- **Model/effort tiering per stage** — implementer and reviewer agents likely inherit the session model, but cheap mechanical stages (evidence collection, doc formatting) could pin lower effort; decide from observed cost of the first real runs.
- **QA environment cost** — whether the `ARCHIE_E2E=1` cheap-model preset from v1's tooling list is still wanted for the system under test (probably yes; unchanged by this redesign).
- **Where the conductor's interview ends and the dossier begins** — v1 allowed web research during the interview; v2 leans toward asking only scope questions pre-research and letting the research workflow own all fact-finding, revisiting after the first runs.
