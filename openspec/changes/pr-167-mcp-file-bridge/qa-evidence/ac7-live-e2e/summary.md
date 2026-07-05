# AC7 live E2E — summary

**Verdict: PASS** (all four assertions passed; scenario `file-bridge-delivery`, run 2026-07-05, single attempt, no retries needed).

## What ran

- **Branch/commit under test:** `archie/task-20260605-1434-l7is2a` @ `4434425`, booted live via the archie-e2e harness (`npx tsx tools/e2e/boot.ts`; see `boot.log`; healthy at `http://localhost:3000`, `/health` body `{"status":"ok","activeTasks":0}`).
- **Stub server:** `stub-server/stub-mcp-server.mjs` — a stateless Streamable HTTP MCP server (`@modelcontextprotocol/sdk` 1.29.0 `McpServer` + `StreamableHTTPServerTransport` over plain node `http`) on host port 8971, exposing `receive_file(name, data_base64)`. Each call's arguments are appended to `stub-server/recording.jsonl`; it returns the text `STUB-RECEIVED-OK-<name>`. Smoke-tested with a direct MCP client before the run (see `stub-server/stub.log`); the recording was truncated after the smoke test so it contains only the live-run call.
- **Fixture registration:** temporary plugin `qa-e2e-stub` (agent `file-courier-agent`, frontmatter `mcpServers: [qa-stub]`) added to the plugins checkout that `workdir/plugins` symlinks to, plus a `qa-stub` entry in `plugins/.mcp.json` pointing at `http://host.docker.internal:8971/mcp`. Reachability from inside the container was verified with `docker compose exec archie curl` (HTTP 406 from the MCP endpoint = reachable). Boot logs confirmed `Plugins loaded: ..., qa-e2e-stub` and `[qa-e2e-stub] file-courier-agent (global)`. Both fixture changes were reverted after the run.
- **Fixture file:** `forge-qa.png`, a real 48x48 RGB PNG with random pixel content, 7028 bytes, SHA-256 `991ed71e60f6390a96c703c7e76fd50f26646bdd7e807754142917aaadb10706` (see `fixture-sha256.txt`). Planted at `workdir/sessions/task-20260705-1516-btskgt/shared/attachments/forge-qa.png` immediately after `create_task` returned the task id, before any agent spawned.
- **Drive:** through the archie-debug MCP (spawned per `.mcp.json` registration via `call-debug-tool.mjs`, a minimal stdio MCP client): nonce `E2E-cfba1016` → `create_task` → `wait_for_task(nonce)` → `wait_for_task(task_id, cursor)` → `STATE=completed`. No approval gate fired.

## Assertions (all pass)

1. **Byte-exact delivery** — the stub's single recorded `receive_file` call has `data_base64` decoding to 7028 bytes with SHA-256 `991ed71e...b10706`, `Buffer.equals(fixture) === true`. Evidence: `stub-server/recording.jsonl`, `sha-comparison.txt`.
2. **Named extra argument** — the recorded call has `name === "forge-qa"` alongside the file argument. Evidence: `stub-server/recording.jsonl`.
3. **Response relayed** — `file-courier-agent` reported `STUB-RECEIVED-OK-forge-qa` verbatim to `pm-agent`, and the PM's final user reply quotes it verbatim. Evidence: `knowledge-log.txt`, `events.txt`.
4. **Task completed** — `wait_for_task` returned `STATE=completed`; the event stream ends `task:completed` at `15:18:23.921Z`. Evidence: `events.txt`, `file-bridge-delivery.json`.

Canonical evidence pair (harness-validated writer): `file-bridge-delivery.json` + `file-bridge-delivery.md`.

## Timeline

- 15:16:40Z nonce minted; 15:16:52Z task `task-20260705-1516-btskgt` created and fixture planted; 15:17:29Z PM assigned `file-courier-agent`; 15:18:00.239Z stub received the call; 15:18:12Z courier reported back; 15:18:18Z PM replied to user; 15:18:23Z task completed. End-to-end: ~91 s.

## Files in this directory

| File | What it is |
|---|---|
| `boot.log` | Full harness boot output (build + health poll) |
| `stub-server/stub-mcp-server.mjs` | The stub Streamable HTTP MCP server |
| `stub-server/recording.jsonl` | The stub's recorded call (the load-bearing evidence) |
| `stub-server/stub.log` | Stub stderr: startup, smoke test, live call |
| `forge-qa.png` / `fixture-sha256.txt` | The planted fixture and its recorded SHA-256 |
| `sha-comparison.txt` | Recomputed decode-and-compare of recording vs fixture |
| `knowledge-log.txt` / `events.txt` | Full task knowledge log and event stream |
| `file-bridge-delivery.json` / `.md` | Validated `archie-e2e-evidence/v1` pair |
| `call-debug-tool.mjs` | Driver used to call archie-debug MCP tools over stdio |

## Notes / observations

- The archie-debug MCP tools were not attached to the QA session directly; they were driven over the MCP protocol with a minimal stdio client spawning the server exactly as `.mcp.json` registers it (`npx tsx tools/debug-mcp/server.ts`). Functionally identical to the skill's recipes.
- The macOS `docker-credential-desktop` hang documented in the archie-e2e skill's prerequisites occurred on this machine; the skill's remedy (scratch `DOCKER_CONFIG` without `credsStore`, plus explicit `DOCKER_HOST` for the Docker Desktop socket) was applied for the run.
- Cold `--build` boot time observation for the harness doc: compose build ~45 s + health ~2 min, well inside the 600 s default cap.
- The `file-courier-agent`'s domain prompt told it the tool name (`send_file_to_mcp_tool`) and where task attachments live; no built-in prompt layer mentions the bridge tool, so real plugin agents will rely on tool discovery or their own domain prompts. Not an AC violation — noted as a rollout observation.
