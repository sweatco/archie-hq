# Tasks — pr-167-mcp-file-bridge

Remaining work on top of the existing PR #167 diff (PR mode; Stages 1–2 skipped).

- [x] T1. Multi-file schema: replace `file_path`/`file_argument` with `files: [{path, argument}]` in `send_file_to_mcp_tool`; 10 MB ceiling applies to the sum; file arguments win collisions with `arguments`; update tool description.
- [x] T2. SSE fix: accept only `type: 'http'` (default) servers with a URL; reject `sse` and stdio explicitly with a clear message.
- [x] T3. Update `src/agents/__tests__/mcp-file-bridge.test.ts` for the new schema; add cases: sse server rejected (AC3), multi-file with one unreadable path → no connect (AC4), two files summing over ceiling → rejected before read (AC5), two-file happy path + collision-win (AC6).
- [x] T4. AC1 integration test: assert plain plugin agents get the `file-bridge` MCP server and PM/repo agents do not (extract a testable seam in `spawn.ts` if needed). Done via exported `shouldAttachFileBridge(def)` predicate on the real capability checks; `spawnAgent` wires through it.
- [x] T5. Full gate: `npm run typecheck`, `npm run build`, `npm test` all green (606 passed / 41 files).
