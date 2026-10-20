# Verdict — red team, round 1

**Role:** adversarial plan review (fresh context). **Inputs:** brief, research dossier, plan artifacts, repo. **Date:** 2026-07-04.

## Verdict: 2 blocking objections, 2 non-blocking

### 1. BLOCKING — boot CLI must fail fast on `docker compose up` non-zero exit

Design specifies fail-fast on container-exit during the poll loop, but no explicit pre-poll guard: if `docker compose up --build -d` itself exits non-zero (daemon down, build failure, permissions), an implementation that proceeds to health polling burns the full 600s timeout on a container that never started. Task 2.4 must mandate the sequence: preflight checks → compose up, trap non-zero exit → diagnostics (compose ps + logs tail) + exit non-zero BEFORE the poll loop → only on success enter `waitForHealth`.

### 2. BLOCKING — evidence writer needs atomic input and atomic writes

Evidence files are committed (Stage 4 writes into `openspec/changes/<change>/qa-evidence/`), so partial/malformed files are silent poison. Task 3.4 must specify: read stdin fully then parse (truncated JSON → clear error, exit non-zero, NO files written); write via temp-file + rename, both files or neither; `--in <file>` validates existence/readability first. Task 3.3 adds a test: stdin EOF mid-JSON → error, no files on disk.

### 3. NON-BLOCKING — decomposition acceptable; add explicit live-smoke task

19 tasks defensible (pure cores + tests + docs mirrors debug-mcp precedent). The verification plan's live smoke on this branch is an implicit 20th task — list it explicitly (task 6.3: boot → basic → edit-mode → evidence validates → teardown clean).

### 4. NON-BLOCKING — nonce-window overflow warning in recipes

`wait_for_task` nonce scan covers 25 recent tasks. On a long-lived dev instance with accumulated tasks, an e2e nonce can fall outside the window → confusing `not_found`. SKILL.md recipes should carry a one-line warning + remedy (fresh boot).

### Accepted trade-off (not an issue)

Agent-driven scenarios vs scripted runner: deterministic parts already live server-side in the MCP; recipes pin the call sequence; evidence validator rejects incomplete records; Stage 4 QA prompt already cites the exact steps.

### Security & constraint checks

All 10 binding constraints from dossier §6 verified respected (MCP untouched, no src/ changes, no Slack creds, no new required env vars, bounded health wait, models untouched, CI green requirements, evidence from MCP + workdir).

## Resolution required

Fix tasks 2.4 and 3.4 (+ test in 3.3) as above; re-run red team not required if fixes are verbatim task-spec amendments — orchestrator re-check suffices per stage rules ("re-run only the critic(s) whose findings were addressed").
