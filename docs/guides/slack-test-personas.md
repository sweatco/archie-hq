# Slack test personas

Memory and proactivity decide who may read, write and be notified from live Slack metadata, so they can only be verified by real workspace members. The persona tools in `tools/persona-mcp/` let a coding agent act as test members of a dedicated test workspace. They change nothing under `src/`.

This guide covers setup, the feasibility probes, the MCP server, synthetic button clicks and resetting memory between runs. The design is in [#428](https://github.com/sweatco/archie-hq/issues/428); the scenario recipes are in the [archie-e2e skill](../../.claude/skills/archie-e2e/SKILL.md).

## Rules

- Use a Slack workspace that exists only for testing. Never point these tools at a workspace real employees use.
- If the test workspace has members other than the personas, agree with its admin which channels the personas may post in. Everyone in a channel sees the test messages.
- Secrets never go into the config file, the repository, an issue or a chat. The config holds references; the values live in 1Password, the macOS Keychain or the environment.
- An instance's signing secret lets its holder make that instance believe any Slack event. Keep only a test instance's secret on a developer machine, and make sure it differs from production's.
- Evidence labels signed synthetic requests as synthetic. They prove a handler's checks, not that Slack showed a button to that member.

## Set up

A workspace admin does this once. It takes one browser sign-in per test member.

1. **Members.** A persona is a workspace member the tools act as. Use full members (not guests): an account you already control, or newly invited ones such as Alice, Bob and Carol. One persona is enough for the payload probe, two for the two-user recipes. Pick a public channel that contains every persona and the Archie bot under test.
2. **App.** At https://api.slack.com/apps choose **Create New App → From an app manifest**, pick the test workspace and paste [`tools/persona-mcp/slack-manifest.yaml`](../../tools/persona-mcp/slack-manifest.yaml). The app has no bot user and receives no events. If Slack rejects the redirect URL, replace it with any HTTPS URL you control, in the manifest and in the config.
3. **Config.** Copy [`config.example.json`](../../tools/persona-mcp/config.example.json) to `~/.config/archie-personas/config.json`, or anywhere else and set `ARCHIE_PERSONAS_CONFIG`. Fill in the workspace ID, Archie's bot user ID, each member's user ID, the channel ID, the app's client ID and the instance URLs. Leave `archieBotUserId` out until Archie is installed in the workspace; everything that needs Archie is then skipped. The file is rejected if it names production, repeats a member, has an unknown field or contains a secret instead of a reference.
4. **Secrets.** Store the app's client secret, and the instance's signing secret if signed requests are wanted. A config field can point at any of three places:

   | Reference | Where the value lives |
   |---|---|
   | `op://<vault>/<item>/<field>` | 1Password, read through the `op` CLI. Needs **Settings → Developer → Integrate with 1Password CLI** in the desktop app |
   | `keychain:<service>/<account>` | The macOS login Keychain |
   | `env:<NAME>` | The environment, for machines with neither |

   **1Password:** create one Secure Note for the test workspace, for example `Archie Test Personas`, and add a password field named `client-secret`. Keep the item for these tools only: storing a token rewrites the item, and passkeys do not survive that. Other categories work, but an API Credential ended up with its empty date fields set to 1970.

   **Keychain:** each command prompts for the value twice, which keeps it out of shell history. Pressing Enter without a value stores an empty secret, which the tools then report as missing:

   ```bash
   security add-generic-password -U -s archie-personas -a staging/client-secret -w
   ```

   ```bash
   security add-generic-password -U -s archie-personas -a staging/signing-secret -w
   ```

5. **Tokens.** Authorize the app once per member. Open the printed URL in a browser signed in to Slack as that member (a separate browser profile per member keeps them apart), approve, then paste the address the browser lands on. The token goes straight to the place its reference names (a 1Password field or a Keychain entry) and is never printed. A grant made while signed in as a different member or workspace is refused.

   ```bash
   npx tsx tools/persona-mcp/authorize.ts alice
   ```

6. **Check.** Confirm every token belongs to the configured workspace and member. This only reads.

   ```bash
   npx tsx tools/persona-mcp/probe.ts --tokens
   ```

## Probes

`probe.ts` answers how Slack and the instance treat actions taken as a member. It writes a JSON report with Slack IDs reduced to their type letter, to stdout or `--out <file>`.

| Flag | Question | What it does to the workspace and instance |
|---|---|---|
| none | P3: is the instance's task API reachable from this machine, and what stands in the way? | Two GET requests |
| `--tokens` | Do the tokens match the configured workspace and members? | `auth.test` per token |
| `--post` | P1: which authorship markers does a user-token message carry? P2: do a mention and a DM each start a task and record a memory author? | Posts three messages as the first persona and starts two tasks |
| `--signed` | P4: does the instance accept requests signed with its signing secret, and refuse others? | Three requests to the Slack webhook; no handler runs |

`--post` checks every token first and stops before the first write if one is wrong. The report's `created` list names everything a run left behind. With one persona, P1 reads the message back as its author. Without `archieBotUserId`, P2 is skipped and the run posts one message. `--only P1` or `--only P2` limits a posting run to that probe.

P4 needs the instance to run the HTTP receiver. In Socket Mode there is no webhook to sign for, and button clicks need a real client. [Button clicks without a browser](#button-clicks-without-a-browser) sets the receiver up for a local instance.

If the instance sits behind an access proxy, run the probe through whatever injects that credential; P3 reports `gated` otherwise.

## MCP server

`.mcp.json` registers `archie-personas` (`npx tsx tools/persona-mcp/server.ts`) next to `archie-debug`. Any MCP client can use the same command, so it works from Claude Code and Codex alike.

- **No config on this machine:** the server starts with one tool, `list_personas`, which points here. Personas are opt-in per developer.
- **Config present:** every token is checked first. A token for another workspace or member, a token that is not stored, or an invalid config stops the server with the reason on stderr.

| Tool | Does |
|---|---|
| `list_personas` | Persona keys with their Slack user IDs, and Archie's bot user ID for mentions |
| `post_as`, `reply_as` | Post a top-level message or a thread reply |
| `dm_archie_as` | Post in that member's own DM with Archie. Offered only when the config has `archieBotUserId` |
| `edit_as`, `delete_as`, `react_as` | Change or react to a message |
| `read_as` | Read a conversation or thread as that member sees it: authors, reactions, buttons, and whether Slack marked a message as app-authored |
| `click_as` | Synthetic button press through a signed request. Offered only when the config has `slackWebhookUrl` and `signingSecret` |

All actions use the member's user token. Slack attributes the message to the member but may also stamp it with the persona app's identity. Archie's proactivity treats a stamped message as a bot message, so check `appAuthored` in `read_as`, or the P1 probe, before relying on a persona to establish a commitment.

Observe tasks with `archie-debug`, pointed at the same instance through `ARCHIE_URL`. If the instance sits behind an access proxy, both servers need that credential injected, for example through the proxy's Node preload in `NODE_OPTIONS`.

## Button clicks without a browser

A persona's messages are real, but Slack has no API for pressing a button. `click_as` and the P4 probe instead send the instance a request signed with its own signing secret. Only the HTTP receiver checks signatures, so the instance must run it, and Slack then needs a public URL to deliver to. For a local instance, [Hookdeck](https://hookdeck.com) provides one.

```text
Slack ──► Hookdeck source ──► hookdeck listen ──► localhost:<port>/webhooks/slack
click_as, probe.ts --signed ────────────────────► localhost:<port>/webhooks/slack
```

1. **Source.** Create a source for this instance alone. A shared source would hand it another app's deliveries.

   ```bash
   hookdeck gateway source create --name archie-test-personas --type HTTP
   ```

2. **Slack app.** In the Archie test app's manifest, set `socket_mode_enabled` to `false` and both `request_url` fields (events and interactivity) to the source URL. Save, then follow the prompt to verify the URL. Hookdeck answers Slack's check itself, so the instance need not be running.
3. **Instance.** In `.env`, set `SLACK_SIGNING_SECRET` from the app's **Basic Information** page and remove `SLACK_APP_TOKEN`. Archie uses Socket Mode whenever the app token is set. Boot the instance.
4. **Listener.** Keep this running while testing. Deliveries that arrive while it is down are dropped, not queued.

   ```bash
   hookdeck listen <port> archie-test-personas --path /webhooks/slack
   ```

5. **Config.** Add `slackWebhookUrl` (`http://localhost:<port>/webhooks/slack`) and a `signingSecret` reference to the persona config, then restart the MCP server. `click_as` is now offered.
6. **Check.** This should report the receiver present, a signed request accepted and a wrong signature refused:

   ```bash
   npx tsx tools/persona-mcp/probe.ts --signed
   ```

Things to know:

- Signed requests go straight to the instance, so the tools see its own answer. Only Slack's deliveries pass through Hookdeck.
- Hookdeck acknowledges Slack before the instance sees a delivery. The instance's HTTP answer never reaches Slack, and Slack never retries.
- Message contents pass through the Hookdeck project and stay in its history. Route only the test workspace through it.

## Resetting memory between runs

Fresh markers make most runs independent, so a reset is rarely needed. Reset when profiles or entities left by earlier runs would change what a recipe observes.

A reset deletes what the instance has learned. Get explicit approval each time, and never do it on an instance other people rely on.

1. Stop Archie.
2. Move `WORKDIR/memory/` to a backup outside the active workdir. Do not delete it in place.
3. Start Archie. It creates a fresh store bound to the Slack workspace.
4. Check that `WORKDIR/memory/.scoped-v1.json` names the test workspace's team ID.

This is the reset from [the memory architecture](../architecture/memory.md#reset-rollout-and-rollback). Proactivity keeps its own database at `WORKDIR/initiative/state.sqlite`, which this does not touch.
