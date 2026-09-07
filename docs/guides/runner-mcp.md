# Use repository MCP tools inside a runner VM

`runner_mcp` lets an allowed repository agent use a stdio MCP server in its task's VM. For example, Sweatcoin declares `argent` in `.mcp.json` and pins `@swmansion/argent` in its project dependencies. The simulator, Argent, and its native backend all run inside Tart; Archie controls them through Orchard.

## Interaction workflow

1. Call `runner_sync` for an allowed profile, then use `runner_exec` to install the repository dependencies with its documented commands. Node.js and any required system tools belong in the prepared image.
2. Call `runner_mcp` with `profile`, `server: "argent"`, and a new UUID `request_id`. It returns the server identity, instructions, tools, and JSON input schemas, or a `result_path` to collect when the catalog is large.
3. Call `runner_mcp` again with a new request ID, `tool: "list-devices"`, and `arguments: {}`. Choose the simulator owned by this task.
4. Read the repository's Argent skills. Use `describe` to inspect the UI, `await-ui-element` for state assertions, and the discovered interaction tools to act. Pass the selected UDID in each call. Saved Argent flows can be replayed with `flow-execute`.
5. Collect screenshots, recordings, and reports with `runner_collect`. Paths in a guest MCP response refer to the VM. Copy files outside the synced repository into a repository-relative results directory before collecting them.
6. Release the VM when finished. Use `runner_open_debug` for a bounded human handoff.

Example invocation after discovering the tool schema:

```json
{
  "profile": "ios",
  "request_id": "a810e1a0-3099-4b5d-8cc1-1094e92b40c6",
  "server": "argent",
  "tool": "await-ui-element",
  "arguments": {
    "udid": "<this task's simulator UDID>",
    "condition": "visible",
    "selector": { "identifier": "signUpButton" }
  }
}
```

The response uses the ordinary runner command envelope. Poll `execId` with `runner_exec_poll` while running or `hasMore` is true. Concatenated stdout contains `{ "result_path": "…", "isError": false, "result": … }`. Check `isError` and the tool-specific verdict: a successful MCP exchange alone does not prove a UI assertion passed. A large response omits `result`; collect and read its complete JSON instead. Image blocks become guest image paths in the inline result, with the original MCP response preserved in the JSON artifact.

Reuse the same request ID if an invocation's response is lost. Use a new ID for a new logical action. The existing execution-history retention limit applies; a result that has been pruned cannot provide an indefinite deduplication guarantee.

## Boundaries

The repository's selected `.mcp.json` entry executes inside the VM and must use stdio. Environment placeholders resolve from guest variables only. Archie credentials are not supplied to it. The same agent/profile allowlist and task lease used by other runner tools apply.

Every call creates a fresh MCP session. Argent keeps its device state in a separate local service, so this works across calls. Other MCP servers may require a continuous session; that transport is not provided here. Cancellation closes the MCP client and stdio process, but a server's detached work may continue. VM release removes those backend services too.

The guest repository must make `@modelcontextprotocol/sdk` resolvable by Node. Sweatcoin's Argent dependency already provides it. On a fresh image, allow simulator boot and the first app launch to finish before navigation; the Sweatcoin verification needed 101 seconds to reach its initial welcome screen.

Request IDs deduplicate runner execution, not a server's internal retries. Argent 0.22.1 retries HTTP calls that exceed 30 seconds unless marked as long-running. Simulator boot hit this limit during verification. The test uses Argent's bundled CLI for boot, accessibility setup, and the initial app launch, since that client has no retry loop, then MCP for the recorded app interaction. An uncertain tool result still requires inspection before another action.

No setup command installs system tools. Argent's screen-recording tool requires `ffmpeg` in the image. The Sweatcoin test uses Xcode's `simctl recordVideo` to capture video when that encoder is absent, while its UI interactions use Argent MCP.
