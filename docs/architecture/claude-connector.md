# Claude Connector

People can talk to Archie from Claude (the Claude Desktop app or Claude Code) as well as from Slack. A small local MCP server, `extension/server.mjs`, runs on the person's computer and talks to a `/mcp` namespace on the Archie server (`src/connectors/claude/`). The connection to Archie never goes through Anthropic's cloud: the laptop reaches the server over whatever private network the deployment provides. What Archie returns reaches the model as tool results, like any other tool's output.

A Claude session is the person's Slack DM environment with Archie, reached from somewhere else. It has the same memory scope, the same containment and the same abilities, with one exception: explicit memory saves (`remember_preference`, `remember_fact`) cite a Slack message and need a Slack approval card, so they are unavailable from Claude. Its replies come back only through Claude. A session itself never posts to Slack; the only Slack messages are the DM replies to the person's own "connect claude" / "disconnect claude", and whatever a trigger the person approves from Claude later delivers to their DM, as any DM trigger does.

## Identity

1. The person says `connect claude` in their DM with Archie. `handleClaudeCommand` (`src/connectors/claude/dm-commands.ts`) runs inside `handleSlackEvent` right after the external-author bail-out, before any task routing, so no task is created and no PM wakes. It refuses external users itself (the bail-out before it fails open on a lookup error, and a credential must not) and replies in the same DM, in the same thread when the Slack assistant view threads the message, with a one-time code.
2. The person gives the code to Claude, which calls `connect_archie(code)`. The extension posts it to `POST /mcp/connect` and gets back a long-lived credential bound to that Slack user and their DM. It stores the credential in `~/.archie/claude.json` (mode 0600, keyed by Archie URL) and tells the model only "Connected to Archie." The credential never reaches the model and never appears in Slack.
3. `disconnect claude` in the DM revokes every credential and pending code of that person.

Codes are 8 characters, single use and valid for 10 minutes. `src/connectors/claude/connections.ts` keeps codes and credentials in `${SECRETS_DIR}/claude-connections.json` as sha256 hashes only, so the file needs no encryption.

Every `/mcp` call except `/connect` carries `Authorization: Bearer <credential>`. The middleware resolves it to a connection and then looks the person up in Slack on every request: a deactivated or external account gets 401 even though its credential still exists. The same lookup gives the name that inbound lines are attributed to, and the name and email of the approver, so an edit-mode or merge approval from Claude authors commits as that person.

## Sessions

Sessions work like subagents. `ask_archie(message, session_id?)` returns at once: without an id it starts a task, with one it continues that task. `check_archie(session_id)` returns what is new since the previous check: Archie's replies, whether it is working, done or paused, and any approvals waiting for the person. While Archie is working with nothing new, the extension keeps polling for up to a minute before it answers, and its description tells the model to keep checking until Archie replies, asks for an approval or finishes.

| route | does |
|---|---|
| `POST /mcp/connect` | Redeem a code for a credential |
| `POST /mcp/sessions` | Start a task (201) or message one (200); returns `{ session_id }` |
| `GET /mcp/sessions/:id?after=N` | Replies since event N, status, pending approvals, new cursor |
| `GET /mcp/sessions/:id/approvals/:aid` | One approval's state |
| `POST /mcp/sessions/:id/approvals/:aid` | Decide it as the connected person |

A session id is a task id. It is resolved with `findTaskOnDisk`, and the task's `metadata.created_by` must be the connected person, otherwise the route answers 404 and does nothing. Tasks started from Slack have no `created_by`, so they are never reachable through `/mcp`.

A new session is a task set up like a schedule-fired DM task (see [Triggers](triggers.md)): `home_channel` and `memory_destination` are the person's DM, so trigger proposals bind to that DM with the person as creator, memory is private to the DM, and the DM's standing context applies. Unlike a fired task, its default channel is the CLI channel from the first moment, so `post_to_user` and approval cards never reach Slack: replies are `message` events in `events.jsonl`, which `check` reads. Inbound lines name the person as `<@U…:Name> in claude`, the marker the people section reads. The person is also recorded in `memory_authors`.

The extension keeps each session's cursor in memory, so after the extension restarts the first check replays the whole session.

### Files

Archie's files come back in `check` as their text when they are UTF-8 without NUL bytes and at most 100 000 bytes, otherwise as a one-line note. `Task.logFilesUpload` carries the posted paths on its `message` event for this. `post_files_to_user` checks a path against the PM's sandbox when it is posted, but the server reads it later and unsandboxed, so `readAttachment` opens the file without following a final symlink and without blocking on a FIFO, then requires the opened inode to be the one a path inside the task folder names, requires a regular file, and reads at most the cap. Uploads from Claude to Archie are not supported.

## Approvals

The model cannot approve anything. `show_archie_approval(session_id, approval_id)` only shows the request to the person (it is annotated read-only and cannot decide anything), choosing the UI from what the client declared at `initialize`:

- **MCP Apps** (Claude Desktop): an in-chat card at `ui://archie/approval-v1.html` with Approve and Deny. The buttons call `archie_decide`, and the card reads its state through `archie_approval_state` on load, so a decided approval shows the decision instead of buttons. Both tools are marked `_meta.ui.visibility: ["app"]`, which hides them from the model. `archie_decide` also refuses any client that did not declare MCP Apps, because only such a host hides it. Claude Desktop caches a card by URI, so the version in the URI changes whenever the card does.
- **Elicitation** (Claude Code): an Approve/Deny form showing Archie's own request text.
- **Neither**: refused.

The tool result tells the model the current state either way.

An approval id is the index of its `approval:requested` event in the task's event log. A decision goes through `resolveApproval` (`src/connectors/api/routes.ts`), the same branches as `POST /api/tasks/:id/approve`, with the connected person as approver. That includes trigger approval: `approved_by` is their Slack id. The `approval:resolved` it emits carries `approval_id` and `approver_name`. A refused decision (the engine answers 409 because the request is gone) is still emitted, marked `stale`, and the view shows it as no longer pending. A trigger approval refused because the person is at the active-trigger cap emits nothing and stays pending, so it can be approved once a slot is free. `/mcp` decisions are serialized per task and re-read after queued event writes, so `/mcp` never resolves one approval twice.

The view folds the log: a decision settles every earlier pending request for the same item (same type, ref and PR), so a re-asked request cannot be approved a second time. An operator resolution through `/api` carries no id or ref, so it settles only the one pending request of its type, and nothing when several are pending.

## Deployment

Expose `/mcp` to the people who use Claude, alongside the Slack and GitHub webhooks and `/oauth/callback`. Never expose `/api`: it is unauthenticated and shows every task. The install steps are in [Talking to Archie from Claude](../guides/claude-extension.md).
