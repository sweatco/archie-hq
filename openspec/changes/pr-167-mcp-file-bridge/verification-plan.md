# Verification plan — pr-167-mcp-file-bridge

Expands each AC in `brief.md` into the concrete check that produces its evidence, and where the evidence lives. Stage 4 (QA) requires this file; Stage 3's verifiers use it to judge test coverage.

## Evidence locations

- Unit/integration: the test file path + test name; run output captured in `qa-evidence/unit-run.txt` at Stage 4.
- Live E2E: per-scenario evidence files under `qa-evidence/` written by the archie-e2e harness run.

## Per-AC checks

### AC1 — wiring: plugin agents only (integration)

New test (suggested: `src/agents/__tests__/spawn-file-bridge-wiring.test.ts`, or folded into an existing spawn test suite if one covers per-track MCP server assembly). Assert on the `mcpServers` map assembled by `spawnAgent` (or the extracted helper that builds it):

- For a plain plugin agent (no repo config, not PM): `mcpServers['file-bridge']` is present.
- For the PM agent and for a repo agent: `mcpServers['file-bridge']` is absent.

If `spawnAgent` is too entangled to instantiate in a unit test, extract the tool-assembly decision into a testable seam rather than waiving — the wiring line is currently the only untested code in the PR.

### AC2 — unknown server (unit)

Existing test "rejects a server the agent is not connected to" in `src/agents/__tests__/mcp-file-bridge.test.ts`. Update for the multi-file schema. Assert: error text lists connected servers; `callTool` never invoked.

### AC3 — non-Streamable-HTTP server (unit)

Existing test "rejects a non-http/sse server" — extend to two cases after the SSE fix: stdio server rejected AND `type: 'sse'` server rejected. Assert: no connect attempt in either case.

### AC4 — unreadable path (unit)

Existing test "surfaces an unreadable-path error and does not call out" — update for multi-file: with `files: [readable, unreadable]`, the call fails, no connect happens, and no bytes of the readable file are forwarded anywhere.

### AC5 — size ceiling on the sum (unit)

Existing single-file ceiling test, plus a new case: two files each under 10 MB whose sum exceeds it → rejected before any `readFile`.

### AC6 — happy path, 1..N files (unit)

Existing happy-path + isError tests updated for the array schema, plus a new two-file case. Assert: each file base64-injected under its own argument; merged with `arguments`; file arguments win collisions; transport constructed with the server's url + headers; result text and `isError` surfaced verbatim; client closed.

### AC7 — live E2E (archie-e2e harness)

Scenario, run via the archie-e2e skill from this branch:

1. Start a local stub Streamable HTTP MCP server (scratch script) exposing one tool `receive_file(name, data_base64)`; it records each call's arguments to a file and returns a distinctive success string.
2. Configure a plugin agent in the harness workdir with that stub as an MCP server (reusing the plugin fixture mechanism the harness provides).
3. Place a small binary fixture (e.g. a PNG with known SHA-256) in the agent's readable shared folder.
4. Drive a task through archie-debug MCP (nonce → create_task → wait_for_task) instructing the agent to send that file to `receive_file` via `send_file_to_mcp_tool`.
5. Assert from the stub's recording: `data_base64` decodes to the byte-exact fixture (SHA-256 match), extra argument `name` arrived alongside; and from the task transcript: the agent relayed the stub's distinctive response.

Evidence: stub recording + SHA comparison + task transcript excerpt → `qa-evidence/ac7-live-e2e/`.

Degradation: if the harness cannot register a custom plugin MCP server, record an explicit waiver verdict, downgrade AC7 to `waived` with a named follow-up, and surface it in the PR's verification manifest.

### AC8 — real `set_offer_image` (deploy-only, waived)

No in-run check possible (sweatcoin-backend #13905 unmerged). Post-merge step recorded in the PR manifest: once #13905 deploys, ask the ops agent to run one `set_offer_image` dry-run swap via the bridge and confirm the backend accepts the payload. Status stays `waived` with that step as evidence.
