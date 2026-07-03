/**
 * Public OAuth callback endpoint.
 *
 * Mounted at `/oauth/callback` on the existing Express app. Pending records
 * are written by either the operator CLI (legacy shared connect) or the
 * daemon's wall-click handler (per-user connect); this handler finishes the
 * exchange when the provider redirects back here. Per-user pendings carry a
 * durable (task, request, user) correlation — the callback stores the token
 * under that user and wakes exactly the parked task the request came from.
 */

import type { Application, Request, Response } from 'express';
import { logger } from '../../system/logger.js';
import { exchangeCodeForTokens, clientAuthFor } from '../../system/oauth/flow.js';
import { withKeyMutex } from '../../system/secrets-vault.js';
import {
  readPendingRecord,
  readPendingSealed,
  deletePendingRecord,
  markPendingError,
  writeOAuthRecord,
  writeUserOAuthRecord,
  reapStalePending,
} from '../../system/oauth/storage.js';
import type { OAuthPendingRecord } from '../../system/oauth/types.js';
import { Task } from '../../tasks/task.js';

const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const REAPER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function mountOAuthRoutes(app: Application): void {
  app.get('/oauth/callback', async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const errorParam = typeof req.query.error === 'string' ? req.query.error : null;
    const errorDescription = typeof req.query.error_description === 'string' ? req.query.error_description : null;

    if (!state) {
      res.status(400).type('html').send(renderResultPage({
        ok: false,
        title: 'Missing state',
        message: 'The OAuth provider did not include a state parameter.',
      }));
      return;
    }

    // Provider-side error — surface it on the pending file so the CLI
    // exits with a useful message.
    if (errorParam) {
      const message = `${errorParam}${errorDescription ? `: ${errorDescription}` : ''}`;
      await markPendingError(state, message).catch(() => {});
      res.status(400).type('html').send(renderResultPage({
        ok: false,
        title: 'Authorization failed',
        message,
      }));
      return;
    }

    if (!code) {
      const message = 'Missing authorization code';
      await markPendingError(state, message).catch(() => {});
      res.status(400).type('html').send(renderResultPage({
        ok: false,
        title: 'Authorization failed',
        message,
      }));
      return;
    }

    // Serialise per-state so duplicate redirects (e.g. a reload of the
    // callback URL) don't race the exchange.
    try {
      const result = await withKeyMutex(`pending:${state}`, () => completeFlow(state, code));
      res.status(200).type('html').send(renderResultPage(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('oauth', `Callback failed for state=${state}`, err);
      res.status(500).type('html').send(renderResultPage({
        ok: false,
        title: 'Authorization failed',
        message,
      }));
    }
  });

  // Periodic cleanup so abandoned authorize attempts don't pile up.
  startPendingReaper();

  logger.plain('OAuth routes: GET /oauth/callback');
}

interface CallbackOutcome {
  ok: boolean;
  title: string;
  message: string;
  serverName?: string;
}

async function completeFlow(state: string, code: string): Promise<CallbackOutcome> {
  const pending = await readPendingRecord(state);
  if (!pending) {
    return {
      ok: false,
      title: 'Unknown state',
      message: 'No pending OAuth attempt matches this callback. The flow may have expired or already completed.',
    };
  }

  if (pending.completed_at) {
    return {
      ok: false,
      title: 'Already used',
      message: `This authorization has already been ${pending.error ? 'rejected' : 'consumed'}.`,
    };
  }

  // Hard-stop on stale pendings — defence-in-depth alongside the reaper.
  const ageMs = Date.now() - pending.created_at * 1000;
  if (ageMs > PENDING_TTL_MS) {
    await deletePendingRecord(state).catch(() => {});
    return {
      ok: false,
      title: 'Authorization expired',
      message: 'This authorization attempt has expired. Run the connect command again.',
    };
  }

  const sealed = await readPendingSealed(pending);

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      as: { issuer: pending.issuer, token_endpoint: pending.token_endpoint },
      client: { client_id: sealed.client_id },
      clientAuth: clientAuthFor(sealed.client_secret),
      code,
      state,
      redirectUri: pending.redirect_uri,
      codeVerifier: sealed.code_verifier,
      resource: pending.resource,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markPendingError(state, message);
    return {
      ok: false,
      title: 'Token exchange failed',
      message,
      serverName: pending.server_name,
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = typeof tokens.expires_in === 'number' ? nowSec + tokens.expires_in : nowSec + 3600;

  // Per-user (Slack-initiated) flow: the token belongs to the clicking user;
  // client credentials stay in the shared client record written at click time.
  if (pending.slack_user_id) {
    await writeUserOAuthRecord(
      {
        server_name: pending.server_name,
        slack_user_id: pending.slack_user_id,
        label: pending.label,
        expires_at: expiresAt,
        created_at: nowSec,
        updated_at: nowSec,
        issuer: pending.issuer,
        token_endpoint: pending.token_endpoint,
        scopes: pending.scopes,
        resource: pending.resource,
      },
      {
        access_token: tokens.access_token,
        refresh_token: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
        token_type: tokens.token_type,
      },
    );
    await deletePendingRecord(state);
    logger.system(`OAuth: user ${pending.slack_user_id} connected MCP server "${pending.server_name}"`);

    const wake = await completeTaskAuthRequest(pending);
    return {
      ok: true,
      title: 'Connected',
      message:
        wake === 'resumed'
          ? `"${pending.server_name}" is now authorized with your account. The task resumes automatically — you can close this tab.`
          : wake === 'consumed'
            ? `Your account is connected to "${pending.server_name}", but the task request had already been completed. Your credentials are stored for future use.`
            : `Your account is connected to "${pending.server_name}". The originating task could not be woken automatically — it may have finished or been removed.`,
      serverName: pending.server_name,
    };
  }

  await writeOAuthRecord(
    {
      server_name: pending.server_name,
      label: pending.label,
      expires_at: expiresAt,
      created_at: nowSec,
      updated_at: nowSec,
      issuer: pending.issuer,
      token_endpoint: pending.token_endpoint,
      scopes: pending.scopes,
      resource: pending.resource,
    },
    {
      access_token: tokens.access_token,
      refresh_token: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
      client_id: sealed.client_id,
      client_secret: sealed.client_secret,
      token_type: tokens.token_type,
    },
  );

  await deletePendingRecord(state);
  logger.system(`OAuth: connected MCP server "${pending.server_name}"`);

  return {
    ok: true,
    title: 'Connected',
    message: `Archie now has credentials for "${pending.server_name}". You can close this tab.`,
    serverName: pending.server_name,
  };
}

type WakeOutcome = 'resumed' | 'consumed' | 'unavailable';

/**
 * Resolve the parked (task, server) request this authorization completes and
 * wake the task. Serialized per (task, server) — the same key the wall click
 * handler holds — so duplicate or racing callbacks can't double-bind: the
 * loser finds the request already consumed and no-ops. `Task.get` loads from
 * persistence, so completion survives a daemon restart between click and
 * callback.
 */
async function completeTaskAuthRequest(pending: OAuthPendingRecord): Promise<WakeOutcome> {
  const { task_id: taskId, auth_request_id: authRequestId, slack_user_id: slackUserId, server_name: serverName } = pending;
  if (!taskId || !authRequestId || !slackUserId) return 'unavailable';
  try {
    const woke = await withKeyMutex(`mcp-auth:${taskId}:${serverName}`, async () => {
      const task = await Task.get(taskId);
      return task.completeMcpAuthRequest(authRequestId, serverName, slackUserId);
    });
    return woke ? 'resumed' : 'consumed';
  } catch (err) {
    logger.error('oauth', `Authorized "${serverName}" for ${slackUserId} but failed to wake task ${taskId}`, err);
    return 'unavailable';
  }
}

function renderResultPage(outcome: CallbackOutcome): string {
  const accent = outcome.ok ? '#15803d' : '#b91c1c';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(outcome.title)} — Archie</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #0f172a; color: #e2e8f0; min-height: 100vh; margin: 0;
         display: flex; align-items: center; justify-content: center; padding: 2rem; }
  .card { background: #1e293b; border-radius: 12px; padding: 2rem 2.5rem; max-width: 520px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.4); border-top: 4px solid ${accent}; }
  h1 { margin: 0 0 0.5rem; font-size: 1.5rem; color: ${accent}; }
  p { line-height: 1.5; }
  code { background: #0f172a; padding: 0.1rem 0.4rem; border-radius: 4px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(outcome.title)}</h1>
    <p>${escapeHtml(outcome.message)}</p>
    ${outcome.serverName ? `<p><strong>Server:</strong> <code>${escapeHtml(outcome.serverName)}</code></p>` : ''}
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function startPendingReaper(): void {
  void reapStalePending(PENDING_TTL_MS).catch((err) =>
    logger.error('oauth', 'Pending reaper failed', err),
  );
  const timer = setInterval(() => {
    void reapStalePending(PENDING_TTL_MS).catch((err) =>
      logger.error('oauth', 'Pending reaper failed', err),
    );
  }, REAPER_INTERVAL_MS);
  // Don't keep the event loop alive just for cleanup.
  timer.unref?.();
}
