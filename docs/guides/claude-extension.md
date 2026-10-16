# Talking to Archie from Claude

Archie can be reached from the Claude Desktop app and from Claude Code through a small local extension. How it works is in [Claude Connector](../architecture/claude-connector.md).

## Server

Make `/mcp` reachable from the computers that will use it, for example over your private network. Connections are stored in `secrets/claude-connections.json`, so keep the secrets directory on a persistent volume. Expose only `/mcp`, the Slack and GitHub webhooks and `/oauth/callback`. Never expose `/api`: it has no authentication and shows every task.

Archie must be connected to Slack, because people connect from their DM with Archie.

## Build the extension

```bash
npm run extension:pack
```

This installs the extension's own dependencies into `extension/node_modules` and writes `dist/archie.mcpb`. The extension needs Node 20 or later.

## Claude Desktop

Open `dist/archie.mcpb` with Claude Desktop and set **Archie URL** to your server, e.g. `https://archie.example.com`. On a Team or Enterprise plan, an owner can upload the `.mcpb` once so members install it with one click.

## Claude Code

```bash
npm ci --prefix extension --omit=dev
claude mcp add archie --env ARCHIE_URL=https://archie.example.com -- node /path/to/archie-hq/extension/server.mjs
```

Claude Code shows approvals as a form in the terminal instead of a card.

## Connect

1. Say `connect claude` to Archie in your Slack DM. Archie replies with a code that works once, for 10 minutes.
2. Tell Claude to connect to Archie with that code.

The credential is stored in `~/.archie/claude.json` and is never shown to Claude. Connect once per computer.

Say `disconnect claude` in the DM to cut off every Claude you have connected.

## Use

Ask Claude to ask Archie something. Claude gets a session id back straight away, checks for Archie's replies, and continues the same session when you follow up. A session behaves like your DM with Archie: same memory, same tools, same limits, except that asking Archie to remember a preference only works in Slack. Its replies come back only to Claude. When Archie asks for approval, Claude shows you a card (or a form in Claude Code), and only you can press Approve or Deny.
