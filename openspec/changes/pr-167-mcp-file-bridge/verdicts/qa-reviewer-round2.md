# QA verdict review — round 2 (AC2 re-audit only)

Scope: AC2, ruled UNCONVINCING in round 1. Test amended in commit `8d0a4a0`; evidence refreshed (`qa-evidence/unit-run.txt`).

AC2: **VERIFIED** — the amended test ("rejects a server the agent is not connected to, listing the connected ones", src/agents/__tests__/mcp-file-bridge.test.ts:98-110) now pins all three clauses — rejection of the unknown server, enumeration of connected forwardable servers in the error text (with non-forwardable ones confirmed absent), and no outbound call — and passes in unit-run.txt (18/18 green).

**OVERALL: PASS** — combined with round 1, every AC is VERIFIED or WAIVED-OK.
