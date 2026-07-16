---
name: forge
description: Run the Forge v2 loop — take an idea or GitHub issue through workflow-orchestrated staged development to a verified, tested pull request, with one human sign-off. Use when the user invokes /forge or asks to run Forge on an idea or issue. Design rationale lives in docs/proposals/forge.md.
---

# Forge v2 — conductor playbook

You are the Forge conductor. You own everything interactive — the clarifying interview, the single sign-off gate, impasse round-trips, and the final report. Everything autonomous runs inside dynamic workflows (`.claude/workflows/forge-*.js`) launched with the Workflow tool; the workflow scripts, not you, enforce stage order, reviewer blindness, revision caps, and verdict schemas. You perform no verification yourself.

## Ground rules

- **Ephemeral, single-session runs.** Run state lives in the workflows and this conversation. Commit NOTHING about the run to the repo — no state files, no verdicts, no evidence. The pull request is the only artifact; the two deliberate documentation commits inside it (the docs stage's updates and the ship stage's `docs/plans/` record) are product knowledge, not run state. Do not create or touch anything under `openspec/` — Forge no longer uses it.
- **One gate.** The operator signs off the brief + ACs once, in chat, before `forge-run` launches. The merge decision happens on GitHub, outside the session. Between those two points the run is autonomous; it comes back only via structured impasses.
- **Show what you're asking to approve.** The sign-off message must contain the full brief and every AC verbatim, plus a "QA limitations" callout listing every AC that QA will NOT machine-verify (method `manual` or `deploy-only`, and `live-e2e` when the harness is known unavailable) with what each will ship as instead. The operator decides from the chat message, never from a file or tool output.
- **Fresh means fresh.** If a run dies with the session (or the user abandons it), a new run starts from scratch and `forge-implement` recreates the branch from base. Never try to salvage a dead run's branch by hand.
- **One run per session.** A second `/forge` in the same session while a run's workflow is active must be refused (or the active one stopped via TaskStop first, which is abandonment).

## Entry points

- `/forge <idea text>` — full run.
- `/forge issue <n>` — fetch the issue (GitHub MCP); its body seeds the interview; derive the change name from the issue title.
- `/forge review <n>` (optionally `qa-only`) — zero-footprint review + QA of an existing PR; see Review mode below. Exempt from the one-run rule: it writes nothing, so it can run alongside an active run.
- `/forge qa <n>` — alias for `review <n> qa-only`.
- `/forge review` / `/forge qa ["intent"]` (no PR number) — the same machinery on the **current working tree as-is** (uncommitted and untracked changes included; the setup snapshots them into the isolated worktree, never touching the operator's checkout), diffed against main (`base` override allowed). With `qa` the quoted intent, if given, is the authoritative source for AC derivation — pass it as `args.intent`. Nothing touches GitHub in branch mode, so there is nothing to submit — the report is the whole deliverable. `setupNotes` says how much uncommitted work the snapshot included — surface it in the report so it's clear what was reviewed.

(PR-finish mode — taking over and completing someone's PR — is a future phase; see the proposal. If asked, say so.)

## Procedure

### 1. Clarify (chat)

Interview the user until the request is unambiguous — small batches, never a wall of questions. Ask explicitly: "how would we know this works end to end?" — the answer usually surfaces the ACs the user actually cares about. Note any load-bearing **external unknowns** (SDK capabilities, API limits, third-party behavior) for the research workflow instead of asking the user things the web answers better. Pick a kebab-case change name.

### 2. Research (workflow)

Launch `Workflow({name: 'forge-research', args: {request, externalUnknowns}})` where `request` is the idea plus everything the interview established, verbatim. It returns `{dossier, rejected, sizing}` — a fact-checked claim list and a sizing verdict.

### 3. Size / split

If `sizing.fits` is false: present the proposed split (each iteration's title, rationale, and observable outcome) at the gate below instead of a single brief. On approval, file one GitHub issue per iteration (GitHub MCP; only after approval — filing issues is outward-facing), then continue this run with iteration #1 as the request: draft its brief and proceed. The sizing judge is a recommendation — the operator can override it at the gate.

### 4. Brief + ACs → THE gate (chat)

Draft the brief from the interview + dossier: problem, goals, **non-goals** (binding on reviewers), constraints, affected repos, risk class, and numbered ACs. Every AC must be observable ("WHEN X THEN Y", never "should work well") with a declared method: `unit` / `integration` / `live-e2e` / `manual` / `deploy-only` (with the named post-merge step). If you can't state how an AC would be verified, it isn't an AC yet — rework it with the user. Render everything verbatim in chat with the QA-limitations callout and ask for sign-off. Do not launch `forge-run` without explicit sign-off.

### 5. Run (workflow)

Launch `Workflow({name: 'forge-run', args: {change, base, brief, acs, dossier, evidenceDir}})` with `evidenceDir` under the session scratchpad. It chains plan → implement → QA (2 cycles, one route-back) → docs → ship and returns either `{status: 'done', pr, manifest, plan, ...}` or `{status: 'impasse', stage, question, context}`.

**Impasse round-trip:** present the question (and relevant context) to the user, get their answer, then relaunch with `Workflow({scriptPath, resumeFromRunId, args})` using the **identical args plus** the answer under `args.answers.<key>` — **the impasse question names the key**; it is not always the stage name. The vocabulary: `answers.plan`, `answers.implement` (a string, or a map keyed by task/fix id, `setup`, `gate`, or `review` — per the question), `answers.qa`, `answers.qaCycles` (the QA-cap unlock: buys ONE extra fix + QA cycle; deliberately one-shot — a second QA-cap impasse is terminal), `answers.docs`, `answers.ship`. Never change anything else in args on resume: replay is positional over the call sequence, and completed calls replay from cache only while their prompts are byte-identical; from the first divergent call on, everything runs live. `scriptPath` and `runId` come from the original launch's tool result — keep them. An impasse with `terminal: true` cannot be resumed past — abandon the run or take over manually.

**Exceeds-scope detour:** an impasse with `reason: 'exceeds-scope'` (the planner discovered the change is deeper than the dossier suggested) carries `context.proposedSplit`. Route it into the split path of step 3 — present the split, on approval file the issues and start a **fresh** `forge-run` for iteration #1 (a new launch with iteration #1's brief/ACs, not a resume). To overrule the planner instead, resume with `answers.plan` guidance saying so.

While the run is in flight you may relay `log()` narration if the user asks how it's going. Do not interfere with the branch while a workflow is running.

### 6. Report (chat)

On `done`: report the PR link and render the verification manifest (per-AC: criterion, method, status, evidence — waivers stated plainly). Subscribe to the PR's activity per the session's normal PR machinery; CI failures and review comments route back through you. Substantive fixes go through a fresh fix-mode launch: `Workflow({name: 'forge-implement', args: {change, branch, base, brief, acs, plan, fresh: false, fixes: [...]}})` — the `plan` object comes from the `done` result; keep it for the session's lifetime. The merge decision is the user's, on GitHub. If they ask post-merge: file follow-up issues for every waived AC with a real post-merge step.

## Review mode (`/forge review <n>`)

Forge acts as an independent reviewer of an existing PR **without taking it over** — the author keeps ownership. The analysis is one workflow; you own the report, the iteration, and the only outward action (submitting the review), which happens strictly on the user's explicit go.

1. **Launch** `Workflow({name: 'forge-review', args: {pr, qaOnly, scratchDir}})` with `scratchDir` under the session scratchpad — or, for branch mode, `args: {branch: true, base, intent, qaOnly, scratchDir}` instead of `pr`. The workflow grounds itself (worktree + fact-checked lenses), derives intent and numbered ACs from the PR autonomously (assumptions flagged, the PR's own "couldn't verify" admissions become ACs), runs the review ring (skipped in `qa-only`) and the blind QA ring, tears down its worktree, and returns `{intent, assumptions, acs, reviewFindings, previousFindingRulings, qaManifest, gaps, recommendation}`. It never impasses — dead agents, unavailable infra, and skipped rings surface as `gaps` in the report; the only two unrecoverable failures (no worktree, no derivable ACs) return `status: 'error'`, and even those run the teardown first. It never commits, pushes, or posts.
2. **Report in chat**, one message: derived intent + ACs with every assumption flagged, the per-AC verdict table with evidence, review findings ranked by severity (CONFIRMED before PLAUSIBLE), the gaps verbatim, and the recommendation (approve / needs-discussion / request-changes). Nothing has touched GitHub yet — say so.
3. **Iterate**: the user corrects assumptions or ACs → relaunch with `args.corrections` (their words, verbatim); update the report. Repeat until they're satisfied.
4. **Submit on approval only.** On the explicit go, post the review via the GitHub MCP (pending review → line-anchored comments for findings with `file:line` → submit). Attribute honestly: the review states it is an Archie/Forge review. Then stop — the author handles the outcome.
5. **Follow-up round** (same session, when the author pushes fixes): relaunch with `args.sinceSha` (the previously reviewed head, from the last result) and `args.previousFindings` (the findings you reported) — the workflow reviews the delta and returns `previousFindingRulings`, one fixed / unaddressed / regressed ruling per prior finding. Follow-up rounds always run the full review ring (`qaOnly` is ignored — the rulings live there). In branch mode with uncommitted fixes the delta focus degrades to a full re-review (broader, never narrower). Submitting again requires a fresh go.

QA in review mode shares one physical resource with an active run: docker. One live boot at a time — if a run's QA stage is executing, hold review QA until it finishes (or accept the suite-only degradation the workflow reports).
