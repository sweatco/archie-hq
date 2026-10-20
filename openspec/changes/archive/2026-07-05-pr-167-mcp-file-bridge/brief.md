# Brief — pr-167-mcp-file-bridge

Reverse inception for [PR #167](https://github.com/sweatco/archie-hq/pull/167) (`send_file_to_mcp_tool` file bridge for plugin agents). Reconstructed from the PR description, diff, and companion backend PR; confirmed and extended by the operator on 2026-07-05.

## Problem

Model-driven agents cannot paste binary file bytes into tool arguments (arguments are generated token-by-token; anything beyond a few KB is impractical and unreliable). An agent holding a file on disk (e.g. a Slack-attached image) has no way to feed those bytes to an MCP tool that needs them. This PR is the enabling piece for the offer image-swap capability; the backend side (`set_offer_image`, [sweatcoin-backend #13905](https://github.com/sweatco/sweatcoin-backend/pull/13905)) is still open.

## Goals

- Generic bounded tool `send_file_to_mcp_tool`: agent passes file PATH(s); the tool reads bytes, base64-encodes, and forwards one `tools/call` to one of the agent's own HTTP MCP servers with each file injected under its named argument.
- **Multi-file schema** (revision added in this run): `files: [{path, argument}]` array replaces the single `file_path`/`file_argument` pair; the 10 MB ceiling applies to the **sum** of file sizes.
- **SSE fix** (revision added in this run): only Streamable HTTP servers accepted; `sse` rejected explicitly. Current code accepts `type: 'sse'` but always connects with `StreamableHTTPClientTransport`, which would fail at runtime against a genuine old-style HTTP+SSE server (that transport was deprecated in the MCP 2025-03-26 spec revision).
- Reuse server config + auth headers from `agent.def.mcpServers` — no new secrets, no new registration.
- Wired to plain plugin agents only (the `else` branch in `spawnAgent`).

## Non-goals

- No PM or repo-agent access to the tool.
- No stdio or SSE forwarding.
- No new credential plumbing.
- No presigned-URL upload path (the right future direction if files outgrow the 10 MB ceiling; the bridge does not block it).
- The image-swap workflow itself (backend tool, prompts/skills) is out of scope.

## Constraints

- Additive only; existing tools, prompts, and sandbox boundaries untouched.
- Every file path must pass `assertReadable` against the agent's sandbox.
- Bytes never enter model context.
- 10 MB hard ceiling on the raw byte total per call.

## Blast radius / risk class

Single repo (archie-hq). Engine but additive: 2 new files (`src/agents/mcp-file-bridge.ts`, its test suite) + wiring in `src/agents/spawn.ts`, plus in-place revisions to the new files in this run. Risk: low-medium (new outbound MCP client path with reused credentials).

## Acceptance criteria

| ID | WHEN / THEN | Method |
|----|-------------|--------|
| AC1 | WHEN a plain plugin agent spawns THEN it has `send_file_to_mcp_tool`; PM and repo agents do NOT | integration (spawn wiring test) |
| AC2 | WHEN `server` is not among the agent's `mcpServers` THEN error lists connected servers; no outbound call | unit |
| AC3 | WHEN the target server is not Streamable HTTP (stdio **or sse**) THEN rejected; no connect | unit |
| AC4 | WHEN any path fails `assertReadable` THEN error surfaced; no connect; no other file read | unit |
| AC5 | WHEN the sum of file sizes exceeds 10 MB THEN rejected before reading | unit |
| AC6 | WHEN a valid call with 1..N files is made THEN each file is base64-injected under its argument, merged with `arguments` (files win collisions), the transport reuses the server's url + auth headers, and the target tool's response (incl. `isError`) is surfaced verbatim | unit |
| AC7 | WHEN a live Archie plugin agent is asked via a task to send a real sandbox file through the bridge to a stub HTTP MCP server THEN the stub receives byte-exact content under the right argument and the agent relays the tool's response | live-e2e (archie-e2e harness + local stub MCP server) |
| AC8 | Image-swap works against the real `set_offer_image` | deploy-only — post-merge step: run one dry-run swap once sweatcoin-backend #13905 deploys |

## QA limitations (accepted at sign-off)

- **AC8**: unverifiable in this run (backend PR unmerged; the tool exists on no live backend). Ships as the named post-merge step above.
- **AC7** is expected to run — docker (27.5.1) and the archie-e2e harness were confirmed available at inception. If stub-server registration proves infeasible in the harness, AC7 degrades to an explicit waiver and the PR merges on unit + integration evidence.

## Plan shape

PR mode: Stages 1–2 skipped (no open design questions). Stage 3 implements the two revisions (multi-file schema, SSE rejection) + the AC1 integration test + test updates, then spec-compliance review and adversarial bug hunt. Stage 4 runs live QA per `verification-plan.md`. Stage 5 ships through the existing PR.
