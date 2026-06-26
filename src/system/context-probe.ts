/**
 * context-probe.ts — DEBUG-ONLY transparent logging proxy for measuring the
 * real per-agent context (system prompt + tool schemas + messages) that Claude
 * Code sends to the Anthropic API.
 *
 * Why this exists: the SDK does NOT write the `system`/`tools` payload into the
 * session .jsonl — only the conversation messages. The full request only exists
 * in the HTTP call to the API, so the only way to see where an agent's context
 * tokens actually go (e.g. a 488K base context on a trivial agent) is to
 * intercept that request. `/context` is no help — in headless/SDK mode it
 * reports a stripped breakdown that omits tool/system definitions.
 *
 * How it works: when enabled, Archie starts this in-process reverse proxy on
 * localhost and points every spawned agent's ANTHROPIC_BASE_URL at it (see
 * spawn.ts). The proxy forwards each request to the real API untouched and pipes
 * the streamed response straight back — so behaviour is identical — but first
 * records the request's section sizes, tagged by the taskId + agentId it parses
 * out of the system prompt. Read the breakdown at $ARCHIE_WORKDIR/context-probe.log.
 *
 * ░░ HOW TO DISABLE ░░  Flip CONTEXT_PROBE_ENABLED to `false` and redeploy.
 * That fully removes the proxy from the request path (agents talk to the API
 * directly) with zero other changes. This is a temporary debugging aid; it
 * should be OFF in steady-state production.
 */
import http from 'node:http';
import https from 'node:https';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.js';

// ░░ MASTER SWITCH — set to false + redeploy to fully disable. ░░
export const CONTEXT_PROBE_ENABLED = true;

const PROBE_PORT = 8788;
const PROBE_HOST = '127.0.0.1';

// The real API endpoint to forward to. Captured at module load BEFORE anything
// could override ANTHROPIC_BASE_URL, so a deployment using a custom gateway
// still works and we never accidentally point the proxy back at itself.
const UPSTREAM_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const UPSTREAM = new URL(UPSTREAM_BASE);

// Derive the workdir directly from the env (same source of truth as
// system/workdir.ts) rather than importing it — keeps this debug module
// self-contained and decoupled from modules that tests routinely mock.
const WORKDIR = process.env.ARCHIE_WORKDIR || join(process.cwd(), 'workdir');
const LOG_PATH = join(WORKDIR, 'context-probe.log');

let listening = false;

/**
 * Base URL spawned agents should use so their API traffic flows through the
 * proxy. Returns undefined when disabled OR when the proxy isn't actually
 * listening — so a failed proxy never breaks agents (they fall back to the
 * real API directly).
 */
export function getProbeBaseUrl(): string | undefined {
  return CONTEXT_PROBE_ENABLED && listening ? `http://${PROBE_HOST}:${PROBE_PORT}` : undefined;
}

const estTokens = (s: string): number => Math.round(s.length / 3.7);

/** Pull a human label for the request out of the system prompt, best-effort. */
function attribute(systemText: string): { taskId: string; agentId: string } {
  const taskId = systemText.match(/Task:\s*(task-[\w-]+)/)?.[1] ?? 'unknown-task';
  const agentId =
    systemText.match(/You are the ([\w.\- ]+?),/)?.[1]?.trim() ??
    systemText.match(/\b([\w-]+-agent)\b/)?.[1] ??
    'unknown-agent';
  return { taskId, agentId };
}

/** Parse a captured /v1/messages body into a token breakdown. Never throws. */
function breakdown(body: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(body);
    if (!j || (!j.system && !j.messages)) return null;
    const systemText = Array.isArray(j.system)
      ? j.system.map((s: any) => s?.text ?? '').join('')
      : (typeof j.system === 'string' ? j.system : '');
    const tools = Array.isArray(j.tools) ? j.tools : [];
    const toolsStr = JSON.stringify(tools);
    const messagesStr = JSON.stringify(j.messages ?? []);
    const { taskId, agentId } = attribute(systemText);
    const withTok = tools.map((t: any) => ({ name: t?.name ?? '?', tok: estTokens(JSON.stringify(t)) }));
    const perTool = [...withTok].sort((a, b) => b.tok - a.tok).slice(0, 15);
    // Tally by source: mcp__<server>__tool → "<server>"; everything else → "builtin".
    // This is the actionable view — shows which MCP server (or the built-in set)
    // owns the tool tokens.
    const byServer: Record<string, { tok: number; n: number }> = {};
    for (const t of withTok) {
      const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(t.name);
      const key = m ? m[1] : 'builtin';
      (byServer[key] ??= { tok: 0, n: 0 });
      byServer[key].tok += t.tok;
      byServer[key].n += 1;
    }
    const bySrvSorted = Object.fromEntries(
      Object.entries(byServer).sort((a, b) => b[1].tok - a[1].tok),
    );
    return {
      taskId,
      agentId,
      model: j.model,
      system_tok: estTokens(systemText),
      tools_tok: estTokens(toolsStr),
      n_tools: tools.length,
      messages_tok: estTokens(messagesStr),
      total_req_tok: estTokens(body),
      tools_by_server: bySrvSorted,
      top_tools: perTool,
    };
  } catch {
    return null;
  }
}

async function recordRequest(path: string, body: string): Promise<void> {
  if (!path.includes('/v1/messages')) return; // skip token-count, models, etc.
  const rep = breakdown(body);
  if (!rep) return;
  try {
    await appendFile(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...rep }) + '\n');
  } catch {
    /* best-effort */
  }
  logger.system(
    `[context-probe] ${rep.taskId}/${rep.agentId}: TOTAL≈${rep.total_req_tok} tok ` +
    `(system=${rep.system_tok}, tools=${rep.tools_tok}/${rep.n_tools}, messages=${rep.messages_tok})`,
  );
}

/**
 * Start the in-process logging proxy. Idempotent; no-op when disabled. Failures
 * are logged and swallowed — a broken proxy must never take Archie down (agents
 * just keep using the real API since getProbeBaseUrl() returns undefined).
 */
export function startContextProbe(): void {
  if (!CONTEXT_PROBE_ENABLED || listening) return;

  const server = http.createServer((clientReq, clientRes) => {
    const chunks: Buffer[] = [];
    clientReq.on('data', (c) => chunks.push(c));
    clientReq.on('end', () => {
      const body = Buffer.concat(chunks);

      // Best-effort logging — never let it affect forwarding.
      void recordRequest(clientReq.url ?? '', body.toString('utf8')).catch(() => {});

      // Forward verbatim to the real API.
      const headers = { ...clientReq.headers };
      delete headers['host'];
      delete headers['content-length'];
      const transport = UPSTREAM.protocol === 'https:' ? https : http;
      const upstreamReq = transport.request(
        {
          protocol: UPSTREAM.protocol,
          hostname: UPSTREAM.hostname,
          port: UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80),
          method: clientReq.method,
          path: clientReq.url,
          headers: { ...headers, host: UPSTREAM.host },
        },
        (upstreamRes) => {
          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(clientRes); // stream SSE straight back, untouched
        },
      );
      upstreamRes_onError(upstreamReq, clientRes);
      if (body.length > 0) upstreamReq.write(body);
      upstreamReq.end();
    });
    clientReq.on('error', () => clientRes.destroy());
  });

  server.on('error', (err) => {
    listening = false;
    logger.error('context-probe', `proxy failed to start on ${PROBE_HOST}:${PROBE_PORT} — agents will use the API directly`, err);
  });
  server.listen(PROBE_PORT, PROBE_HOST, () => {
    listening = true;
    logger.system(`[context-probe] ENABLED — proxy on http://${PROBE_HOST}:${PROBE_PORT} → ${UPSTREAM_BASE}, logging to ${LOG_PATH}`);
    logger.system('[context-probe] DEBUG AID — set CONTEXT_PROBE_ENABLED=false + redeploy to disable.');
  });
}

/** Wire an upstream-request error to a clean 502 so a forward failure surfaces like an API error rather than hanging. */
function upstreamRes_onError(upstreamReq: http.ClientRequest, clientRes: http.ServerResponse): void {
  upstreamReq.on('error', (err) => {
    logger.error('context-probe', 'upstream forward failed', err);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `context-probe upstream error: ${String(err)}` } }));
    } else {
      clientRes.destroy();
    }
  });
}
