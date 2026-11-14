# Connecting an OAuth MCP server

Use these commands on the daemon's host with the same secrets directory and master key. The [secrets module map](../architecture/secrets.md) owns the vault, callback and refresh contracts; [plugin configuration](../architecture/plugin-system.md#the-root-mcp-config) owns the server definition.

## Prerequisites

The server must be configured in the plugins repository's root `.mcp.json` as an HTTP or SSE endpoint. Configure `ARCHIE_SECRETS_KEY` and `ARCHIE_PUBLIC_URL` through the deployment's secret/configuration process; `ARCHIE_SECRETS_DIR` overrides the shared storage directory. The provider must be able to redirect the browser to the daemon's `/oauth/callback` URL. The CLI validates the master key before its commands run.

If an existing vault is present, preserve its key. Replacing the key does not re-encrypt existing records. Keep credentials out of command transcripts, repository files and diagnostic output.

## Connect and verify

```bash
npm run oauth:connect -- <server-name>
```

Open the printed authorization URL and complete provider consent. The CLI waits for the daemon callback to exchange the code and write the encrypted record. Then inspect metadata:

```bash
npm run oauth:list
```

A listed record proves that credentials were stored, not that the provider accepts every intended scope. On an authorized task, verify a harmless read through the configured server and inspect any binding failure. Credentials are bound at SDK spawn; a message in an already-running stream does not automatically refresh them.

## Refresh, reconnect and revoke

```bash
npm run oauth:refresh -- <server-name>
npm run oauth:connect -- <server-name>
npm run oauth:revoke -- <server-name>
```

Refresh forces token rotation through the existing refresh path. Reconnect replaces the stored record after consent. Revoke deletes the local record only; provider-side revocation is a separate operation in the provider's administration interface.

If discovery or dynamic registration fails, inspect the CLI error and the provider's registration requirements. The CLI supports manually registered client options; see [`src/cli/oauth.ts`](../../src/cli/oauth.ts) for the accepted flags and handle any secret through an approved local credential workflow. If the callback cannot be reached, verify the public URL and shared secrets directory before retrying. Failed spawn-time refresh removes that server from the spawn configuration while other servers can continue.
