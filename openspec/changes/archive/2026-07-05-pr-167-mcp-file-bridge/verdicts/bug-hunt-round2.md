# Adversarial bug hunt — round 2

**Verdict: FINDINGS (4). Round-1 fixes verified correct (live-map resolution guaranteed by mutation-before-query ordering; disallowedTools check well-formed; all round-1 tests fail under mutation).**

1. **CONFIRMED (test gap)** — `src/agents/spawn.ts:523`. The live-map fix is only test-guarded inside `createSendFileToMcpTool`; the call-site wiring is not covered by any test. Mutating spawn.ts to pass `agent.def.mcpServers ?? {}` as the third argument — reintroducing exactly the round-1 bug — passes typecheck and the entire vitest suite: no test file imports spawn.ts, so the `liveServers` parameter contract is unenforced at the seam where the bug actually lived.
2. **PLAUSIBLE** — `disallowedTools` check missed the whole-server rule form `mcp__<server>` (no tool suffix), which the SDK honors to block every tool on a server. `disallowedTools: ['mcp__sweatco-admin']` would block direct calls but not the bridge.
3. **PLAUSIBLE** — the bridge consulted only `disallowedTools`, not the `tools` allowlist. A def restricting MCP access via an explicit `tools` list that includes the bridge tool could reach ANY tool on any connected http server, bypassing the allowlist (registry semantics: tools defined → use exactly what's listed). Related: the check reads `agent.def.disallowedTools` rather than spawn's effective list — equivalent today for bridge-eligible agents.
4. **PLAUSIBLE (minor)** — TOCTOU on the 10 MB ceiling: sizes checked via `stat`, files read afterwards; a file appended to in between exceeds the ceiling and is forwarded. Bounded to the agent's own sandbox-writable paths.

**Disposition:**
- Findings 2, 3, 4 fixed in commit `a05fc3c` (whole-server disallow form; allowlist enforcement in exact or whole-server form; post-read ceiling re-check), each with a mutation-killing test.
- Finding 1 accepted as a known unit-test gap: `spawnAgent` is a ~600-line side-effectful monolith no test imports; a unit test would require mocking its entire dependency surface. Mitigation: AC7's live E2E drives a real spawn and exercises the actual wiring end to end (a def-map regression at the call site would surface there whenever OAuth-bound or dropped servers are involved; the wiring itself — bridge present, resolving, forwarding — is fully exercised). Recorded in the verification manifest rather than silently dropped.
- The `agent.def.disallowedTools` vs spawn-effective-list divergence noted in finding 3 is accepted: equivalent for every bridge-eligible track today; noted in code comment territory only if it ever diverges.
