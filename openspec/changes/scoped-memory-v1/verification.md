# Live verification matrix

All scenarios run against a Docker instance booted from this worktree. Overlay a fresh temporary host directory onto the container's `WORKDIR/memory` path while sharing the rest of the normal `workdir`. Record a recursive digest of the symlinked host memory directory before boot and after teardown; they must match. Never move, delete, or seed the shared host memory path.

Use nonce-tagged Slack messages delivered through the configured Hookdeck route. Resolve and record the concrete workspace team ID, bot ID, internal test-user ID, public `#archie-test-channel` ID, internal private test-channel ID, and internal DM ID before scenarios. If no Slack Connect or restricted-guest fixture is available, exercise those classifications with the existing Slack client integration seam and record live Slack verification as unavailable rather than substituting a public channel.

Each scenario writes validated `archie-e2e-evidence/v1` JSON and Markdown under `openspec/changes/scoped-memory-v1/qa-evidence/<scenario>/`, including flag state, nonce, Slack event/request, task ID, relevant event/log excerpts, scoped-store file listing, memory-tool response when applicable, prohibited paths/results, and teardown status.

## Scenarios

1. **tools-off-public-trigger**
   - Flags: memory enabled, injection off, tools off.
   - Ingress: create a channel-bound scheduled trigger for `#archie-test-channel`, approve it, and fire it.
   - Assert: trigger task starts and delivers normally; persisted scope is public; public summary/activity are written after completion; no memory MCP server is registered.

2. **public-recall**
   - Restart with tools on and injection off, keeping only the isolated test memory.
   - Ingress: nonce-tagged public Slack thread in `#archie-test-channel` that establishes a harmless durable test fact, then a second public task querying that fact through the memory tools.
   - Assert: structured internal author recorded; first task writes only public corpus; search/read returns the nonce fact; no channel private file exists.

3. **private-channel-isolation**
   - Ingress: nonce-tagged thread in the internal private fixture, followed by a second task in the same channel and a task in `#archie-test-channel` using the same query.
   - Assert: only `private/channels/<private-id>.md` receives the compact outcome; same-channel private read returns it; public task cannot find/read it; no public profile/entity/activity/summary contains the private nonce.

4. **dm-isolation**
   - Ingress: nonce-tagged DM from the internal test user, followed by a second DM task and a public-channel task using the same query.
   - Assert: only `private/users/<user-id>.md` receives the compact outcome; matching DM can read it; public task cannot; no global artifact contains the DM nonce.

5. **mixed-audience-collapse**
   - Ingress: link an internal private task to a distinct public Slack thread using the supported task-routing path.
   - Assert: scope becomes none before memory read or delivery; neither private nor public memory is read or written afterward; delivery/trigger behavior itself remains operational.

6. **outsider-visible-no-memory**
   - Ingress: use a Slack Connect or restricted-guest fixture when available; otherwise run the classifier integration seam with Slack API fixture responses and a real live task for the unaffected delivery assertion.
   - Assert: scope is none; no public injection or tools are attached; no transcript is read by extraction; no memory artifact contains the nonce.

7. **lookup-failure-continuity**
   - Ingress: inject a `conversations.info` or membership lookup failure through the Slack client integration seam, then fire a scheduled channel trigger and process a Slack task.
   - Assert: an unexposed Slack task and scheduled trigger continue and deliver with scope none; an already-exposed task rejects the unclassified delivery; no memory read/write occurs; logs identify fail-closed memory classification without query/content leakage.

8. **private-to-public-transition**
   - Ingress: seed a private channel outcome in isolated memory, then make the classifier report the same channel as internal public for the next tool call.
   - Assert: the old private file is not read; public memory remains available because the current audience is verified internal; the old private outcome never appears in the response.
