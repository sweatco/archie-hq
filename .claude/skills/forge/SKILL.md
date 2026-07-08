---
name: forge
description: Run the Forge loop — take an idea, GitHub issue, or existing PR and produce a verified, tested pull request through staged, adversarially-verified development. Use when the user invokes /forge or asks to run Forge on an idea, issue, or PR. Design rationale lives in docs/proposals/forge.md.
---

# Forge — orchestrator playbook

You are the Forge orchestrator. You take one unit of work (an idea, an issue, or an existing PR) through staged development to a verified pull request. You coordinate; fresh-context subagents do the verification. Full design rationale: `docs/proposals/forge.md`.

## Ground rules

- **One run at a time.** Run state lives on the run's branch, so scan more than the working tree: check `openspec/changes/*/forge.yaml` here AND on every `forge/*` branch, local and remote (`git branch --list 'forge/*'`, `git ls-remote --heads origin 'forge/*'`, then `git show <branch>:openspec/changes/<change>/forge.yaml`). If an active run (stage not `done`/`abandoned`) exists anywhere, tell the user and offer to resume or abandon it. Never run two in parallel.
- **Fresh context for every verifier.** Spawn verification roles as subagents (Task tool) whose prompt contains ONLY: the role instructions from the stage file, paths to the artifacts they may read, and the output contract. Never include your conversation history, your reasoning, or the authoring agent's rationale. The rings get progressively blinder — respect each stage's stated inputs exactly.
- **Capped loops.** Each stage file states its revision cap (2–3 rounds). When a cap is hit with unresolved findings, stop and present the impasse to the user rather than looping.
- **Structured verdicts.** Every verification pass must end in an explicit verdict written to the change dir (`verdicts/<role>-round<N>.md`) and reflected in `forge.yaml`. A pass with no written verdict did not happen.
- **Two human gates.** Inception sign-off and the merge decision. Everything between runs autonomously; come back to the user only for an unverifiable AC, a genuine scope change, or a hit cap.
- **Show what you're asking to approve.** At any human gate, the chat message itself must contain the full content being approved — the brief with every AC verbatim at inception, the verification manifest at merge. Never ask for sign-off by pointing at a file you wrote or a tool action; the user must be able to decide without opening anything.
- **Persist before proceeding.** Update `forge.yaml` and commit artifacts to the run's branch at every stage boundary, so `/forge resume` always works. Invoking `/forge` IS the user's explicit request to commit on the run's branch (this satisfies the repo CLAUDE.md commit rule); it is never license to commit outside that branch.
- **Forge state is not scope creep.** Everything under `openspec/changes/<change>/` is run state, committed with `forge(<change>): …` messages. Reviewers exclude it from scope-creep judgment, and in `pr` mode these commits will appear in the PR's diff — that's intentional transparency, but if the PR's author isn't Archie or the operator, flag it to the user before committing state there. The repo's `.gitattributes` marks this path `linguist-generated`, so GitHub collapses the artifacts in PR diffs and reviewers see only the code expanded — keep run state under that path so the collapse applies.

## Run state: `forge.yaml`

Lives at `openspec/changes/<change>/forge.yaml`:

```yaml
run: <change-name>                # kebab-case, matches the change dir
source: { type: idea|issue|pr, ref: "<text | issue number | PR number>" }
repo: sweatco/archie-hq           # target repo. Run state ALWAYS lives in archie-hq's openspec/changes/, even when implementation targets archie-plugins (sibling checkout, its own branch)
branch: <feature branch>
stage: inception                  # inception | research | plan | implement | qa | ship | done | abandoned
stage_rounds: {}                  # e.g. { plan: 2, implement: 1 } — revision rounds consumed
acceptance_criteria:              # written at inception; statuses updated by QA/ship
  - id: AC1
    text: "<observable behavior>"
    method: unit|integration|live-e2e|manual|deploy-only
    status: pending               # pending | verified | waived | failed
    evidence: null                # path or link once verified; named post-merge step if waived
pr: null                          # PR number once opened
```

## Change directory

The run's artifacts live in `openspec/changes/<change>/`: `proposal.md`, `design.md`, `tasks.md`, `specs/` (OpenSpec artifacts), plus Forge's additions — `brief.md` (inception), `research.md` (dossier), `verification-plan.md`, `verdicts/`, `qa-evidence/`, and `forge.yaml`.

If the `openspec` CLI is on PATH, scaffold and validate the OpenSpec artifacts with it (as `/opsx:propose` does: `openspec new change`, `openspec status --json`, `openspec instructions <artifact> --json`). If not, create the same files by hand following the structure of `openspec/changes/archive/2026-07-01-debug-mcp-wait-for-task/` — do not block on the CLI.

## Entry points

Parse the invocation input:

- **Idea text** → full run from Stage 0.
- **`issue <n>`** → fetch the issue (GitHub MCP or `gh`); its body seeds the Stage 0 interview. Derive the change name from the issue title.
- **`pr <n>`** → finish-this-PR mode. Check out the PR's branch. Stage 0 runs as **reverse inception**, which begins with a mandatory code-grounding research pass (diff mapper, codebase context, base-branch drift — see the stage file) before any brief is presented; the brief is built from the PR *and* that fact-checked dossier, with contradictions surfaced. Reverse inception also writes `research.md` and `verification-plan.md` (Stages 1–2 are skipped, and Stage 4 requires the latter). Then run Stages 3→5 (finish, verify, QA, ship), returning to Stage 2 only if reverse inception exposed an unresolved design question. The change dir is named `pr-<n>-<slug>`.
- **`review <n>`** (optionally `qa-only`) → **zero-footprint review mode**, NOT a run: derive intent and ACs from the PR autonomously (no interview), run the review + QA rings, report findings in chat, and only on the user's explicit approval submit the review to the PR — the author keeps ownership; Forge never commits or pushes anything. Exempt from the one-run rule (nothing is written) and designed for worktrees. Follow `stages/review.md`, not the stage sequence.
- **`resume`** → locate the active run (same cross-branch scan as the one-run rule), check out its branch, report where it stands, and continue from `stage`.
- **`abandon`** → locate the active run, confirm with the user, set `stage: abandoned` and commit — this is the only way the one-run guard unblocks without finishing.

## Stage sequence

Work through the stage files in order, in this skill's `stages/` directory. Each file is self-contained: purpose, inputs, procedure, verification passes (with the exact subagent role prompts), exit criteria, and state updates.

1. `stages/0-inception.md` — interactive interview → `brief.md` with numbered, testable ACs. **Human sign-off gate.**
2. `stages/1-research.md` — parallel research lenses → `research.md`, adversarially fact-checked.
3. `stages/2-plan.md` — OpenSpec artifacts + `verification-plan.md`; completeness critic + red team; published to the user, **not** a gate.
4. `stages/3-implement.md` — execute `tasks.md`; spec-compliance reviewer + adversarial bug hunt with mutation-checked tests.
5. `stages/4-qa.md` — black-box QA against a live instance via the archie-debug MCP; independent verdict reviewer. Degrades to explicit waivers when the E2E harness or docker isn't available.
6. `stages/5-ship.md` — house-style PR with the verification manifest; CI watch; **human merge gate**; post-merge archive.

Read a stage file when you reach that stage — do not preload all of them.

## Git discipline

- Create the run's feature branch off the base branch at Stage 0 (`forge/<change-name>`, or reuse the PR's branch in `pr` mode). Record it in `forge.yaml`.
- Commit artifacts at stage boundaries with `forge(<change>): <stage> — <summary>` messages; implementation commits follow the repo's normal conventions.
- Never force-push someone else's branch; in `pr` mode rebase only with the user's knowledge if the branch is shared.
