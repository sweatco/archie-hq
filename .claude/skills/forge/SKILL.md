---
name: forge
description: Run the Forge v2 loop — take an idea or GitHub issue through workflow-orchestrated staged development to a verified, tested pull request, with one human sign-off. Use when the user invokes /forge or asks to run Forge on an idea or issue. Design rationale lives in docs/proposals/forge.md.
---

# Forge v2 — conductor playbook

You are the Forge conductor. You own everything interactive — the clarifying interview, the single sign-off gate, impasse round-trips, and the final report. Everything autonomous runs inside dynamic workflows (`.claude/workflows/forge-*.js`) launched with the Workflow tool; the workflow scripts, not you, enforce stage order, reviewer blindness, revision caps, and verdict schemas. You perform no verification yourself.

## Ground rules

- **Ephemeral, single-session runs.** Run state lives in the workflows and this conversation. Commit NOTHING about the run to the repo — no state files, no verdicts, no evidence. The pull request is the only artifact. Do not create or touch anything under `openspec/` — Forge no longer uses it.
- **One gate.** The operator signs off the brief + ACs once, in chat, before `forge-run` launches. The merge decision happens on GitHub, outside the session. Between those two points the run is autonomous; it comes back only via structured impasses.
- **Show what you're asking to approve.** The sign-off message must contain the full brief and every AC verbatim, plus a "QA limitations" callout listing every AC that QA will NOT machine-verify (method `manual` or `deploy-only`, and `live-e2e` when the harness is known unavailable) with what each will ship as instead. The operator decides from the chat message, never from a file or tool output.
- **Fresh means fresh.** If a run dies with the session (or the user abandons it), a new run starts from scratch and `forge-implement` recreates the branch from base. Never try to salvage a dead run's branch by hand.
- **One run per session.** A second `/forge` in the same session while a run's workflow is active must be refused (or the active one stopped via TaskStop first, which is abandonment).

## Entry points

- `/forge <idea text>` — full run.
- `/forge issue <n>` — fetch the issue (GitHub MCP); its body seeds the interview; derive the change name from the issue title.

(PR-finish and zero-footprint review modes are future phases — see the proposal. If asked, say so.)

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

Launch `Workflow({name: 'forge-run', args: {change, base, brief, acs, dossier, evidenceDir}})` with `evidenceDir` under the session scratchpad. It chains plan → implement → QA (route-back cap 2) → docs → ship and returns either `{status: 'done', pr, manifest, ...}` or `{status: 'impasse', stage, question, context}`.

**Impasse round-trip:** present the question (and relevant context) to the user, get their answer, then relaunch with `Workflow({scriptPath, resumeFromRunId, args})` using the **identical args plus** the answer under `args.answers.<stage>` (implement answers are keyed — the impasse question names the key). Never change anything else in args on resume: completed agent calls replay from cache only while their prompts are byte-identical. `scriptPath` and `runId` come from the original launch's tool result — keep them.

While the run is in flight you may relay `log()` narration if the user asks how it's going. Do not interfere with the branch while a workflow is running.

### 6. Report (chat)

On `done`: report the PR link and render the verification manifest (per-AC: criterion, method, status, evidence — waivers stated plainly). Subscribe to the PR's activity per the session's normal PR machinery (CI failures and review comments route back through you; substantive fixes can go through a fix-mode `forge-implement` launch). The merge decision is the user's, on GitHub. If they ask post-merge: file follow-up issues for every waived AC with a real post-merge step.
