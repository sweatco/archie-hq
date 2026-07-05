# Verdict — adversarial bug hunter, round 1

**Role:** blind bug hunt with mutation-checked tests (fresh context). **Inputs:** diff `4cb1282...HEAD`, repo read access, typecheck/vitest/node allowed (no docker). **Date:** 2026-07-04.

## Verdict: FINDINGS — 1 blocking, 6 non-blocking

### 1. CONFIRMED, blocking — transient `compose ps` failure aborts a healthy boot as `container_exited`

`runBoot` wires `readPs` as `async () => (await deps.exec(...)).stdout` (`boot.ts:219`), but `makeExec` never rejects (`exec.ts:41-45` — failures resolve `{code!=0, stdout:''}`). `waitForHealth`'s designed skip-the-tick catch (`boot.ts:137-142`) is therefore unreachable in production: a transient ps failure yields empty stdout → `archieContainerState('')` → `{found:false}` → `container_exited: "archie container not present"` → boot exits 1 even though `/health` would have gone 200 next poll. Reproduced with a scratch harness against the real `runBoot`. Companion test theater: `boot.test.ts:124-141` passes a *rejecting* `readPs` fake — a failure shape production can't produce; the reachable shape is untested and buggy. **Fix:** `readPs` must inspect `.code` and throw/skip on non-zero; add `runBoot`-level test with fake exec returning `{code:1, stdout:''}` for ps.

### 2. CONFIRMED, non-blocking — truncation classifier misses common Node 20 EOF messages

`evidence.ts:231` regex misses `Expected ',' or '}' after property value...` (truncation after a complete value) → labeled `invalid JSON` instead of `truncated`. Exit code/zero-write semantics unaffected; label accuracy only.

### 3. CONFIRMED, non-blocking — flags with missing values silently ignored

`evidence.ts --in` with no value falls back to stdin silently (`evidence.ts:346-349`); `boot.ts --timeout-seconds` with no value falls through to env/default (`boot.ts:242-243`). Should exit 2 like unknown args.

### 4. PLAUSIBLE, non-blocking — /health probe has no per-request timeout

Bare `fetch()` (`boot.ts:288-291`); a wedged container that accepts TCP but never responds stalls one probe up to undici's ~300s header timeout, so small `--timeout-seconds` values aren't honored. Fix: `AbortSignal.timeout(...)` per probe.

### 5. PLAUSIBLE, non-blocking — pair transactionality is in-process only; deterministic temp names race concurrent writers

Fixed temp names (`<scenario>.json.tmp`, `evidence.ts:270-271`); concurrent same-scenario writers can clobber temps and the loser's rollback unlinks the winner's landed `.json` (`evidence.ts:295`). SIGKILL between the two renames leaves `.json` without `.md`. Mitigated: SKILL.md mandates serial runs; crash window microseconds. Documented trade-off acceptable.

### 6. PLAUSIBLE, non-blocking — markdown fence breakout in evidence excerpts

Log lines dropped verbatim into a ``` fence (`evidence.ts:200-208`); a line starting with ``` closes the fence and the rest renders as active markdown in the reviewer-facing `.md`. Canonical JSON unaffected.

### 7. PLAUSIBLE, non-blocking — `E2E_EVIDENCE_DIR=""` writes to cwd

`??` at `evidence.ts:395` honors set-but-empty env; inconsistent with `config.ts` which treats empty as unset.

## Checked and cleared

Path traversal (scenario pattern rejects `.`/`/` before any write, no user data in exec argv); teardown false-clean (strict parser, loud failures, `--all` pinned by argv assertion); compose ps array+NDJSON shapes; timeout boundaries (0/negative rejected, ≥1 probe guaranteed, cap test mutation-checked); exec double-settle safe; full mutation sweep — all tests except Finding 1's guard the behavior they claim; PORT-regex parity with debug MCP byte-for-byte (pre-existing class); Ctrl-C mid-boot leaves containers by design (teardown is a separate documented step).
