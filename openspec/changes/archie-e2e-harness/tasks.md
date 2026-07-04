## 1. Shared config and exec plumbing (`tools/e2e/`)

- [x] 1.1 Create `tools/e2e/config.ts` with a pure `resolveBaseUrl(env, dotenvText)` mirroring the debug MCP precedence (`ARCHIE_URL` → `PORT` env → `.env` PORT → `http://localhost:3000`) — it receives the `.env` content as an already-read string (the CLI `main` does the disk read; the pure function never touches the filesystem) — plus a `resolveTimeoutSeconds(flag, env, default)` helper for boot/evidence tunables
- [x] 1.2 Add `tools/e2e/config.test.ts` covering all four precedence branches and the timeout override chain (flag beats env beats default); confirm vitest picks it up via the existing `tools/**/*.test.ts` include
- [x] 1.3 Create `tools/e2e/exec.ts`: a thin typed wrapper over `child_process` for `docker compose …` invocations (returns `{code, stdout, stderr}`), injected as a dependency everywhere so cores stay fake-able

## 2. Boot from branch

- [ ] 2.1 Create `tools/e2e/boot.ts` with the pure core `waitForHealth(deps, opts)` — injected `fetch`, compose-`ps` reader, and clock; polls `/health` every 5s until 200, fails fast when the `archie` container is exited/restart-looping, gives up at the cap (default 600s) — returning a structured result (`healthy | container_exited | timeout`, plus the `/health` body or failure detail)
- [ ] 2.2 Add a pure diagnostics formatter in `boot.ts` that renders the failure block (compose `ps` table + last-100-lines log tail) from injected strings
- [ ] 2.3 Add `tools/e2e/boot.test.ts` with fake fetch/ps/clock: immediate healthy; healthy after N polls; container exit → fail-fast before the cap; cap reached → `timeout`; diagnostics formatter renders ps + log tail
- [ ] 2.4 Wire the CLI `main` preflight (mandatory, first step): `.env` exists at the repo root and `ANTHROPIC_API_KEY` is non-empty; on failure exit non-zero naming the missing item, with no compose invocation
- [ ] 2.5 Wire compose-up with the exit code trapped: `docker compose up --build -d` via the exec wrapper; on non-zero exit, collect diagnostics (`docker compose ps` + `docker compose logs --no-color --tail=100 archie`), print them, and exit non-zero BEFORE entering the health poll loop — cover the ordering with an orchestration test (fake exec failing compose-up → zero `/health` fetches attempted)
- [ ] 2.6 Only on compose-up success, call `waitForHealth` with real deps: success prints base URL + `/health` body; poll-phase failure prints the same diagnostics block and exits non-zero; support `--timeout-seconds` and `E2E_BOOT_TIMEOUT_SECONDS` (default 600s)

## 3. Evidence writer

- [ ] 3.1 Create `tools/e2e/evidence.ts` defining the `archie-e2e-evidence/v1` schema types and a pure `validateEvidence(payload)` — required fields present, `assertions` non-empty, each assertion has `id/description/expected/observed/pass`, `result` equals the AND of assertion passes, `terminal_state` in the allowed union — returning structured errors
- [ ] 3.2 Add a pure `renderEvidenceMarkdown(evidence)` producing the reviewer-facing `.md` (scenario, ACs, timestamps, assertion table with pass/fail, excerpts as fenced blocks, verdict)
- [ ] 3.3 Add `tools/e2e/evidence.test.ts`: valid payload passes; missing assertions / inconsistent `result` / bad `terminal_state` rejected with named errors; markdown render includes every assertion and the verdict; stdin EOF mid-JSON (truncated input) → classed error, non-zero exit path, and NO files on disk
- [ ] 3.4 Wire the CLI `main` with all-or-nothing semantics: read stdin fully into memory then parse (truncated/malformed JSON → clear classed error, e.g. "truncated JSON input from stdin", exit non-zero, no files written); `--in <file>` validates existence/readability before open; on valid payload write `<out-dir>/<scenario>.json` + `<out-dir>/<scenario>.md` atomically via temp-file + rename, transactionally (both files land or neither; clean up temps on failure); destination from `--out-dir` / `E2E_EVIDENCE_DIR` / default `./e2e-evidence/`; invalid payload exits non-zero printing the validation errors, writing nothing
- [ ] 3.5 Add `e2e-evidence/` to `.gitignore`

## 4. Teardown

- [ ] 4.1 Create `tools/e2e/teardown.ts` with a pure `parseComposePs(jsonLines)` → list of remaining project containers, tolerant of empty output and both array/NDJSON `docker compose ps --format json` shapes
- [ ] 4.2 Add `tools/e2e/teardown.test.ts`: empty output → clean; leftover container → named in the failure; malformed line → clear parse error
- [ ] 4.3 Wire the CLI `main`: `docker compose down`, then `docker compose ps --format json`; clean → print confirmation line (suitable for evidence), survivors → list them and exit non-zero

## 5. Skill document

- [ ] 5.1 Create `.claude/skills/archie-e2e/SKILL.md` with frontmatter (`name: archie-e2e`, trigger-rich `description`) and the lifecycle overview: boot → drive → evidence → teardown, prerequisites (docker, `.env` with `ANTHROPIC_API_KEY`, no Slack tokens needed), an explicit supersede note re PR #71 (this skill takes the path; the Slack round-trip rebases on top), and a rollback note (delete `.claude/skills/archie-e2e/` + `tools/e2e/` — no side effects, nothing else references them)
- [ ] 5.2 Document the boot invocation (`npx tsx tools/e2e/boot.ts`), the preflight → compose-up-trapped → poll ordering, the timeout override, the fail-fast behavior, and what the failure diagnostics contain; record observed cold/warm boot times once measured (with the ~2×-cold-time tuning guidance)
- [ ] 5.3 Document the two scenario recipes as exact MCP call sequences — basic (nonce → `create_task` → `wait_for_task` loop with cursor resume → assert `completed` + PM reply via `get_log`/`get_events`) and edit-mode (change request against a configured repo → `approval_requested` → `approve(type: edit_mode)` → continue waiting → `completed`); recipe scenario names must exactly match the evidence files' `scenario` field values; include a one-line warning that `wait_for_task`'s nonce scan covers only the 25 most-recent tasks (on a long-lived instance old nonces fall out of the window — remedy: fresh boot), the serial-only constraint, and the edit-mode prerequisite (a configured engineering repo in the workdir) with the BLOCKED reporting shape when it is unmet
- [ ] 5.4 Document the evidence format (`archie-e2e-evidence/v1` field-by-field), the writer invocation and its all-or-nothing write semantics, and the destination split: `./e2e-evidence/` is the gitignored local default, `openspec/changes/<change>/qa-evidence/` is the committed Forge Stage 4 target (`--out-dir` / `E2E_EVIDENCE_DIR`)
- [ ] 5.5 Document teardown (`npx tsx tools/e2e/teardown.ts`) and the no-containers-remain guarantee

## 6. Verification

- [ ] 6.1 Targeted typecheck over `tools/e2e/*.ts` (`tsc --noEmit`, mirroring the debug-mcp precedent since repo `typecheck` scopes to `src/`); `npm run typecheck`, `npm run build`, `npm test` all green with the new tests included in the run
- [ ] 6.2 Footprint check: diff against the branch point is confined to `.claude/skills/archie-e2e/`, `tools/e2e/`, `.gitignore`, and docs — `src/` and `tools/debug-mcp/` untouched
- [ ] 6.3 Live smoke on this branch: boot → basic scenario → edit-mode scenario → evidence files written and validating → teardown clean — the dry run for the self-hosted Stage 4 pass (evidence lands under `openspec/changes/archie-e2e-harness/qa-evidence/`)
