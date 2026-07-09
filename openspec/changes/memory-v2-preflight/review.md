# Adversarial Review

## Verdict

- **Status**: issues-found → resolved (fix run hit the 2-iteration cap; a follow-up verify-only run confirmed 11 further findings, all then fixed by hand — see below)
- **Iterations**: 2 (fix run) + 1 (verify-only run)
- **Codex available**: true (both runs)

Run `wf_48108da7-beb` (fix loop): 4 artifacts reviewed, 17 agents, 16 findings confirmed across both iterations, 16 fixed, 0 skipped, 1 rejected in synthesis #2. Run `wf_a3159eb4-2d4` (verify-only, fresh reviewers over the amended artifacts): 11 confirmed (7 medium, 4 low), 0 rejected; all 11 applied to the artifacts by hand in-session. `openspec validate` clean after every pass.

## Findings Fixed

Iteration 1 (7 confirmed, 7 fixed):

- claude-1 — high — Worst-case token bound and per-spawn estimates omitted user-preferences and recent-activity blocks the same flag flip enables
- claude-4 — medium — Replay scope ignored snapshot metadata: dynamic and non-assigned agent spawns were structurally excluded
- claude-3 — medium — "Byte-for-byte" reproduction claim was wrong: replay uses end-of-task artifacts, real spawns see spawn-time state
- claude-2 — medium — D4 mandated hand-copying a username mapper that is already exported
- codex-missed-1 — medium — Replaying historical tasks against a post-task store snapshot leaks self/future knowledge into "would-be" selections
- claude-5 — low — Spec delta permanently SHALL'd a script the design declares disposable
- claude-6 — low — Budget/cap env values were an uncaptured selection input

Iteration 2 (9 confirmed, 9 fixed):

- codex-1 — high — Store-review report omitted injected non-entity blocks (user_preferences, recent_activity)
- claude-1 — medium — Local-agent-config fallback was unreachable under the mandated `ARCHIE_WORKDIR=<snapshot>` run mode
- claude-2 — medium — Metadata-first repo-selector resolution couldn't express prod's primary for multi-repo agents
- codex-2 — medium — Worst-case token bound's user term was sample-derived, not a true bound
- claude-missed-1 — medium — Store cleanup (task 3.2) had no specified path to the prod store; suggested command edits a local copy
- claude-5 — low — Headline MUST NOT (read-only) had no verifying scenario
- claude-3 — low — Budget echo omitted `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX`
- claude-missed-2 — low — D6's launchd risk mitigation was factually wrong (StartInterval firings during sleep are missed, not deferred)
- codex-missed-1 — low — Worst-case user-preference term undercounted XML wrapper overhead

Verification round `wf_a3159eb4-2d4` (11 confirmed, 11 hand-fixed):

- codex-1 — medium — Budget env names `ORG_INJECT_MAX`/`ENTITY_INJECT_MAX` didn't match the `ARCHIE_MEMORY_*` names the code reads; echo now goes through the flag accessors, not `process.env`
- claude-1 — medium — `--plugins-dir` checkout was unpinned/unrecorded; now pinned to the prod `ARCHIE_PLUGINS_BRANCH` tip and its HEAD SHA/branch/dirty flag echoed in the report header
- claude-4 — medium — Prod-store cleanup raced the in-process serialized write queue; now required only while the app is stopped or verifiably idle, with a defined landed-confirmation
- codex-2 — medium — Worst-case bound needed production-rendered user/recent-activity blocks but only the entity render path was exported; user_preferences/recent_activity wrappers now exported too
- codex-3 — medium — `participants` includes owner-assignments that never spawned; `agent_sessions` is now the sole replay source, `participants` a labeled supplementary row
- codex-4 — medium — Read-only verification hashed files only; now also diffs the full tree listing so forbidden new directories are caught
- claude-missed-1 — medium — `WORKDIR` binds at module load as fact; positional snapshot-path mode dropped, `ARCHIE_WORKDIR` is the only entry point with a wrong-workdir guard
- claude-2 — low — `plugin` selector comes from `.claude-plugin/plugin.json` `name`, not agent frontmatter; agent-id ↔ file mapping documented
- claude-5 — low — Manual cleanup left the persisted always-injected `entities/index.md` stale; index rebuild + rendered-index confirmation now required
- codex-missed-2 — low — Store-review reading list now includes `memory/entities/index.md` with the same suspicious-content grep
- claude-6 — low — launchd default environment broke the pull script's `mapfile` auto-detect (macOS bash 3.2); container name now passed explicitly, runs logged to `snapshot.log`

## Open Questions

None left unfixed or skipped. Residual caveat: the 11 hand-applied fixes from the verification round were not themselves re-debated (stopping the review-fix regress deliberately after three rounds); they are doc-level amendments applying the reviewers' own fix recommendations verbatim.

## Implementation review

Pending
