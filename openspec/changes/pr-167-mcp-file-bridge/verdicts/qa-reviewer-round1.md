# QA verdict review — round 1

Independent audit of `qa-evidence/` against the ACs and verification plan. Auditor re-verified primary data itself: recomputed the fixture PNG's SHA-256, independently decoded the stub recording's `data_base64` and byte-compared (`Buffer.equals === true`), read the stub server source to confirm it records raw incoming arguments verbatim, and cross-checked task id, nonce, relay strings, and timestamps across `events.txt`, `knowledge-log.txt`, `stub.log`, and `file-bridge-delivery.json`.

- AC1: VERIFIED — `shouldAttachFileBridge` seam tests (real PM/repo predicates) match the plan's sanctioned fallback; AC7's live run shows a plugin agent actually holding and using the tool.
- AC2: **UNCONVINCING** — rejection and no-outbound-call asserted, but no test pinned the claimed "error lists connected servers"; the regex only checked the unknown server's name.
- AC3: VERIFIED — separate stdio and legacy-SSE tests each assert rejection with no connect.
- AC4: VERIFIED — `[readable, unreadable]` case asserts error surfaced, `readFile` never called, no connect.
- AC5: VERIFIED — single-file and 6MB+5MB sum cases reject before any read, plus a TOCTOU re-check case.
- AC6: VERIFIED — base64 injection per argument, merge with file-wins collision, transport built with server url + CF-Access headers, verbatim result, `isError` surfaced, client closed.
- AC7: VERIFIED — auditor-recomputed fixture SHA matches the independently decoded stub recording byte-for-byte; agent relay of `STUB-RECEIVED-OK-forge-qa` present in events and PM reply; ids/timestamps consistent (stub call 15:18:00.239Z inside the courier agent's active window 15:17:38–15:18:12).
- AC8: WAIVED-OK — declared waiver (backend #13905 unmerged) with named post-merge step.

Minor note: `boot.log` lacks the "Plugins loaded: qa-e2e-stub" line the runner's summary cites; plugin registration demonstrated conclusively by the live agent reaching the stub during the task window.

**OVERALL: FINDINGS** (AC2 routed back to Stage 3 for a test-assertion fix.)
