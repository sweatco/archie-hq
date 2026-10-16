import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE, getUiCapability } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

const ARCHIE_URL = (process.env.ARCHIE_URL ?? '').replace(/\/+$/, '');
const STORE = join(homedir(), '.archie', 'claude.json');
const cursors = new Map();
// Bump the version whenever the card changes: Claude Desktop caches cards by URI.
const UI_URI = 'ui://archie/approval-v1.html';

const readStore = () => {
  try {
    const all = JSON.parse(readFileSync(STORE, 'utf8'));
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
};

const readCredential = () => readStore()[ARCHIE_URL];

const saveCredential = (credential) => {
  const all = readStore();
  all[ARCHIE_URL] = credential;
  mkdirSync(dirname(STORE), { recursive: true, mode: 0o700 });
  writeFileSync(STORE, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(STORE, 0o600);
};

async function archie(method, path, body) {
  if (!ARCHIE_URL) throw new Error('Set the Archie URL in the extension settings (ARCHIE_URL).');
  const credential = readCredential();
  let res;
  try {
    res = await fetch(ARCHIE_URL + '/mcp' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Could not reach Archie at ${ARCHIE_URL}: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Archie answered ${res.status}.`);
  return data;
}

const result = (text, structuredContent) => ({ content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) });

const guarded = (handler) => async (args, extra) => {
  try {
    return await handler(args, extra);
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
};

const approvalPath = (s, a) => `/sessions/${encodeURIComponent(s)}/approvals/${encodeURIComponent(String(a))}`;

const describeDecision = (v) =>
  v.state === 'pending'
    ? `Approval ${v.approval_id} is waiting for the person: "${v.text}"`
    : v.state === 'expired'
      ? `Approval ${v.approval_id} ("${v.text}") is no longer pending; Archie can ask again.`
      : `Approval ${v.approval_id} ("${v.text}") was ${v.state}${v.decided_by ? ` by ${v.decided_by}` : ''}${v.decided_at ? ` at ${v.decided_at}` : ''}.`;

const bundle = readFileSync(createRequire(import.meta.url).resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8');
const exportsBlock = bundle.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
const pick = (name) => exportsBlock[1].match(new RegExp(`([\\w$]+) as ${name}\\b`))[1];
const sdkNames = ['App', 'applyDocumentTheme', 'applyHostStyleVariables', 'applyHostFonts'];
const appJs = bundle.slice(0, exportsBlock.index) + `globalThis.McpSdk={${sdkNames.map((n) => `${n}:${pick(n)}`).join(',')}};`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--btn:#f2f2f2;--bd:#c8c8c8}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#262624;--fg:#ececec;--btn:#3a3a38;--bd:#555}}
:root[data-theme=dark]{--bg:#262624;--fg:#ececec;--btn:#3a3a38;--bd:#555}
:root[data-theme=light]{color-scheme:light}
body{font:14px var(--font-sans,system-ui);margin:0;padding:12px;background:var(--color-background-primary,var(--bg));color:var(--color-text-primary,var(--fg))}
button{margin-right:8px;padding:6px 14px;font:inherit;color:inherit;background:var(--color-background-secondary,var(--btn));border:1px solid var(--color-border-primary,var(--bd));border-radius:var(--border-radius-md,6px);cursor:pointer}
</style></head><body>
<p id="msg">Loading…</p>
<div id="btns" hidden><button data-d="approve">Approve</button><button data-d="deny">Deny</button></div>
<p id="out"></p>
<script type="module">${appJs}
const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } = McpSdk;
const app = new App({ name: 'archie-approval', version: '0.1.0' });
const $ = (i) => document.getElementById(i);
const applyCtx = (c) => {
  if (c?.theme) applyDocumentTheme(c.theme);
  if (c?.styles?.variables) applyHostStyleVariables(c.styles.variables);
  if (c?.styles?.css?.fonts) applyHostFonts(c.styles.css.fonts);
};
const label = { approved: 'Approved', denied: 'Denied', expired: 'No longer pending' };
const show = (v, note = '') => {
  $('msg').textContent = v.text;
  if (v.state === 'pending') {
    $('btns').hidden = false;
  } else {
    $('btns').hidden = true;
    $('out').textContent = note + label[v.state] + (v.decided_by ? ' by ' + v.decided_by : '') + (v.decided_at ? ' at ' + new Date(v.decided_at).toLocaleString() : '');
  }
};
const fail = (e) => { $('out').textContent = 'Error: ' + (e?.message ?? e); };
let sessionId;
let approvalId;
let loaded = false;
const take = async (src) => {
  sessionId ??= src?.session_id;
  approvalId ??= src?.approval_id;
  if (sessionId !== undefined && approvalId !== undefined && !loaded) {
    loaded = true;
    try {
      const r = await app.callServerTool({ name: 'archie_approval_state', arguments: { session_id: sessionId, approval_id: approvalId } });
      if (r.isError) throw new Error(r.content?.[0]?.text);
      show(r.structuredContent);
    } catch (e) { fail(e); }
  }
};
app.onhostcontextchanged = applyCtx;
app.ontoolinput = (p) => take(p.arguments);
app.ontoolresult = (r) => take(r.structuredContent);
document.querySelectorAll('button').forEach((b) => b.onclick = async () => {
  try {
    const r = await app.callServerTool({ name: 'archie_decide', arguments: { session_id: sessionId, approval_id: approvalId, decision: b.dataset.d } });
    if (r.isError) throw new Error(r.content?.[0]?.text);
    const d = r.structuredContent;
    show(d, d.already_decided ? 'Already decided: ' : '');
  } catch (e) { fail(e); }
});
await app.connect();
applyCtx(app.getHostContext());
</script></body></html>`;

const mcp = new McpServer({ name: 'archie', version: '0.1.0' });

registerAppResource(mcp, 'Archie approval', UI_URI, { description: 'Archie approval card' }, async () => ({
  contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
}));

const approvalInput = { session_id: z.string(), approval_id: z.number().int() };

mcp.registerTool(
  'connect_archie',
  {
    description: 'Connect Claude to Archie. The person gets a one-time code by saying "connect claude" to Archie in a Slack DM; pass that code here. Needed once per computer.',
    inputSchema: { code: z.string() },
  },
  guarded(async ({ code }) => {
    const { credential } = await archie('POST', '/connect', { code });
    saveCredential(credential);
    return result('Connected to Archie.');
  }),
);

mcp.registerTool(
  'ask_archie',
  {
    description: "Ask Archie, an AI teammate with access to your company's tools, to do or answer something. Returns at once with a session_id while Archie works in the background, like a subagent. Without session_id it starts a new session; with one it continues that session. Read Archie's replies with check_archie.",
    inputSchema: { message: z.string(), session_id: z.string().optional() },
  },
  guarded(async ({ message, session_id }) => {
    const { session_id: id } = await archie('POST', '/sessions', { message, session_id });
    return result(`Archie has it. Session ${id}. Call check_archie with this session_id for replies, and keep calling it until Archie replies, asks for an approval, or has finished; pass the session_id to ask_archie to continue the session.`, { session_id: id });
  }),
);

const CHECK_WAIT_MS = 60_000;
const CHECK_POLL_MS = 2_000;

const statusLine = {
  working: 'Archie is still working. Call check_archie again to keep waiting.',
  done: 'Archie has finished. Use ask_archie with this session_id to follow up.',
  paused: 'Archie is paused, waiting for an approval or for you.',
};

mcp.registerTool(
  'check_archie',
  {
    description: "See what is new in an Archie session since the last check: Archie's replies, whether it is still working or done, and approvals waiting for the person. While Archie is working it waits up to a minute for something new. Keep calling it until Archie replies, asks for an approval, or has finished; never wait with shell commands.",
    inputSchema: { session_id: z.string() },
  },
  guarded(async ({ session_id }) => {
    const deadline = Date.now() + CHECK_WAIT_MS;
    const replies = [];
    let r;
    for (;;) {
      r = await archie('GET', `/sessions/${encodeURIComponent(session_id)}?after=${cursors.get(session_id) ?? 0}`);
      cursors.set(session_id, r.cursor);
      replies.push(...r.replies);
      if (replies.length > 0 || r.approvals.length > 0 || r.status !== 'working' || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, CHECK_POLL_MS));
    }
    let text = `Session ${session_id}: ${statusLine[r.status]}`;
    for (const reply of replies) {
      text += `\n\nArchie: ${reply.text}`;
      for (const f of reply.files) {
        text += 'text' in f ? `\n\n--- ${f.name} ---\n${f.text}` : `\n\n(${f.note})`;
      }
    }
    if (replies.length === 0) text += '\n\nNo new replies.';
    for (const a of r.approvals) {
      text += `\n\nWaiting for approval ${a.approval_id}: ${a.text}\nCall approve_archie with this session_id and approval_id ${a.approval_id} to show it to the person. Only the person can decide.`;
    }
    return result(text);
  }),
);

registerAppTool(
  mcp,
  'approve_archie',
  {
    description: 'Put an Archie approval in front of the person so they can approve or deny it. Only the person decides; you cannot.',
    inputSchema: approvalInput,
    _meta: { ui: { resourceUri: UI_URI } },
  },
  guarded(async ({ session_id, approval_id }) => {
    const caps = mcp.server.getClientCapabilities();
    const v = await archie('GET', approvalPath(session_id, approval_id));
    if (getUiCapability(caps)) {
      return result(
        v.state === 'pending'
          ? `Approval ${v.approval_id} is pending: "${v.text}". The card is in front of the person, who decides with its buttons; you cannot. Use check_archie afterwards.`
          : describeDecision(v),
        { session_id, approval_id },
      );
    } else if (v.state !== 'pending') {
      return result(describeDecision(v));
    } else if (caps?.elicitation) {
      const answer = await mcp.server.elicitInput({
        mode: 'form',
        message: `Archie asks for approval: ${v.text}`,
        requestedSchema: {
          type: 'object',
          properties: { decision: { type: 'string', title: 'Decision', enum: ['approve', 'deny'] } },
          required: ['decision'],
        },
      });
      if (answer.action !== 'accept') {
        return result(`The person did not decide. Approval ${approval_id} is still waiting.`);
      } else {
        const d = await archie('POST', approvalPath(session_id, approval_id), { approve: answer.content.decision === 'approve' });
        return result(describeDecision(d));
      }
    } else {
      return result('This client cannot show approvals: it supports neither MCP Apps cards nor elicitation forms. Use Claude Desktop or Claude Code.');
    }
  }),
);

registerAppTool(
  mcp,
  'archie_approval_state',
  {
    description: "Read an Archie approval's state. App-only.",
    inputSchema: approvalInput,
    _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } },
  },
  guarded(async ({ session_id, approval_id }) => {
    const v = await archie('GET', approvalPath(session_id, approval_id));
    return result(JSON.stringify(v), v);
  }),
);

registerAppTool(
  mcp,
  'archie_decide',
  {
    description: "Record the person's decision from the approval card. App-only.",
    inputSchema: { ...approvalInput, decision: z.enum(['approve', 'deny']) },
    _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } },
  },
  guarded(async ({ session_id, approval_id, decision }) => {
    // Only a host that renders the card hides this tool from the model.
    if (!getUiCapability(mcp.server.getClientCapabilities())) throw new Error('Only the approval card can record a decision.');
    const d = await archie('POST', approvalPath(session_id, approval_id), { approve: decision === 'approve' });
    return result(JSON.stringify(d), d);
  }),
);

await mcp.connect(new StdioServerTransport());
