/**
 * Archie Debug MCP Server — lets Claude Code interact with a running Archie instance
 *
 * Standalone stdio MCP server. No imports from src/.
 * Ejectable: copy tools/debug-mcp/ anywhere, install deps, run.
 *
 * Target Archie URL resolution:
 *   1. ARCHIE_URL      — explicit override (e.g. a remote host)
 *   2. PORT env var    — http://localhost:$PORT
 *   3. PORT from .env  — the same file the server reads its PORT from
 *   4. http://localhost:3000
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ArchieClient, renderEventLine } from './archie-client.js';
import { waitForTask, APPROVAL_TYPES } from './wait-for-task.js';

/** Read PORT from a .env file without pulling in a dotenv dependency. */
function portFromEnvFile(): string | undefined {
  const candidates = [
    join(process.cwd(), '.env'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), // repo root from tools/debug-mcp/
  ];
  for (const path of candidates) {
    try {
      // Capture the value only — stop at whitespace, a quote, or an inline `#`
      const m = readFileSync(path, 'utf-8').match(/^\s*PORT\s*=\s*["']?([^\s"'#]+)/m);
      if (m) return m[1];
    } catch {
      // file absent — try the next candidate
    }
  }
  return undefined;
}

/** Resolve the Archie base URL (see precedence in the file header). */
function resolveArchieUrl(): string {
  if (process.env.ARCHIE_URL) return process.env.ARCHIE_URL;
  const port = process.env.PORT || portFromEnvFile() || '3000';
  return `http://localhost:${port}`;
}

const archieUrl = resolveArchieUrl();
// stderr only — stdout carries the MCP protocol and must not be polluted.
console.error(`[archie-debug] targeting ${archieUrl}`);
const client = new ArchieClient(archieUrl);
const server = new McpServer({
  name: 'archie-debug',
  version: '1.0.0',
});

// ---- Tools ----

server.tool(
  'create_task',
  'Create a new Archie task. Returns the task ID.',
  { message: z.string().describe('The task description / user message') },
  async ({ message }) => {
    const taskId = await client.createTask(message);
    return { content: [{ type: 'text', text: taskId }] };
  },
);

server.tool(
  'list_tasks',
  'List recent Archie tasks with their status, title and channel.',
  {},
  async () => {
    const tasks = await client.listTasks();
    if (tasks.length === 0) {
      return { content: [{ type: 'text', text: 'No tasks found.' }] };
    }
    const lines = tasks.map(
      (t) =>
        `${t.task_id}  ${t.status.padEnd(12)}  ${(t.channel_name ?? '-').padEnd(16)}  ${t.title ?? '(untitled)'}`,
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'task_status',
  'Get detailed status of a task: metadata, the PM session state, and the tail of the transcript.',
  { task_id: z.string().describe('The task ID (e.g. task-20260410-1523-a3f9k2)') },
  async ({ task_id }) => {
    const detail = await client.getTaskDetail(task_id);
    const m = detail.metadata;

    const sections: string[] = [];

    sections.push(`Task: ${m.task_id}`);
    sections.push(`Status: ${m.status}`);
    if (m.title) sections.push(`Title: ${m.title}`);
    if (m.edit_allowed !== undefined) sections.push(`Edit mode: ${m.edit_allowed ? 'allowed' : 'not allowed'}`);
    sections.push(`Created: ${m.created_at}`);
    sections.push(`Updated: ${m.updated_at}`);

    // One PM per task, so `agent_sessions` holds one entry — printed as the PM
    // state rather than as a roster. A legacy on-disk entry can be a bare
    // session-id string.
    const pmLines = Object.entries(m.agent_sessions ?? {}).map(([key, state]) => {
      if (typeof state === 'string') return `  ${key}: session ${state}`;
      const active = state.active ? 'active' : 'idle';
      return `  ${key}: ${active}${state.session_id ? ` (session ${state.session_id})` : ''}`;
    });
    sections.push(`\nPM:\n${pmLines.length > 0 ? pmLines.join('\n') : '  not spawned yet'}`);

    // Transcript tail, from the event log — the knowledge log is not served.
    const { events } = await client.getEvents(task_id);
    const lines = events.map(renderEventLine).filter((l): l is string => l !== null);
    if (lines.length > 0) {
      const tail = lines.slice(-30);
      sections.push(`\nTranscript (last ${tail.length} of ${lines.length} lines):\n${tail.join('\n')}`);
    }

    return { content: [{ type: 'text', text: sections.join('\n') }] };
  },
);

server.tool(
  'send_message',
  'Send a follow-up message to an existing task. The message goes to the PM agent.',
  {
    task_id: z.string().describe('The task ID'),
    message: z.string().describe('The message to send'),
  },
  async ({ task_id, message }) => {
    await client.sendMessage(task_id, message);
    return { content: [{ type: 'text', text: `Message sent to ${task_id}` }] };
  },
);

server.tool(
  'get_log',
  "Get a task's transcript: inbound messages, the PM's replies and system findings, one line each. Optionally return only the last N lines.",
  {
    task_id: z.string().describe('The task ID'),
    tail: z.number().optional().describe('Number of lines from the end to return (default: all)'),
  },
  async ({ task_id, tail }) => {
    // Built from the event log. knowledge.log still exists on disk as an
    // offline record, but it is not served over the API and nothing on the
    // live path reads it — every line worth showing here is also an event.
    const { events } = await client.getEvents(task_id);
    const lines = events.map(renderEventLine).filter((l): l is string => l !== null);
    if (lines.length === 0) {
      return { content: [{ type: 'text', text: '(empty log)' }] };
    }
    const shown = tail ? lines.slice(-tail) : lines;
    return { content: [{ type: 'text', text: shown.join('\n') }] };
  },
);

server.tool(
  'get_events',
  'Get the event log for a task. Use the "after" cursor to poll for new events since your last check.',
  {
    task_id: z.string().describe('The task ID'),
    after: z.number().optional().describe('Return events after this cursor (from a previous call\'s total field)'),
  },
  async ({ task_id, after }) => {
    const result = await client.getEvents(task_id, after);
    if (result.events.length === 0) {
      return { content: [{ type: 'text', text: `No new events. Cursor: ${result.total}` }] };
    }
    const lines = result.events.map((e) => {
      const agent = e.agentName ? ` [${e.agentName}]` : '';
      const data = typeof e.data === 'object' ? JSON.stringify(e.data) : String(e.data);
      return `${e.timestamp}${agent} ${e.type}: ${data}`;
    });
    lines.push(`\nCursor: ${result.total} (pass as "after" to get newer events)`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'approve',
  'Approve or deny a pending request (edit mode, research budget, merge, trigger, tool call, max mode) for a task. For type "merge", pass github and pr_number identifying the pending PR — the API rejects merge resolutions without them. For type "tool_call", pass ref (the call digest); for "trigger", ref selects one of several outstanding proposals. Both are reported as APPROVAL_REF by wait_for_task.',
  {
    task_id: z.string().describe('The task ID'),
    type: z.enum(APPROVAL_TYPES).describe('The request type to approve/deny'),
    approve: z.boolean().describe('true to approve, false to deny'),
    github: z.string().optional().describe('Repo of the pending PR, e.g. "org/repo" (required for type "merge")'),
    pr_number: z.number().optional().describe('Number of the pending PR (required for type "merge")'),
    ref: z
      .string()
      .optional()
      .describe('Id of the pending item, echoed from the approval event (required for type "tool_call")'),
  },
  async ({ task_id, type, approve, github, pr_number, ref }) => {
    const { stale } = await client.approve(task_id, type, approve, { github, pr_number, ref });
    if (stale) {
      return {
        content: [{
          type: 'text',
          text: `STALE: ${type} resolution for ${task_id} did not match the pending request — nothing was approved or denied`,
        }],
      };
    }
    const action = approve ? 'Approved' : 'Denied';
    return { content: [{ type: 'text', text: `${action} ${type} for ${task_id}` }] };
  },
);

server.tool(
  'wait_for_task',
  'Block server-side until a task settles, in one call instead of polling get_events. Locate it by task_id or by a nonce in its transcript, then wait until completed / stopped / approval_requested or a ~45s cap. Returns STATE with the attribution line and any pm-agent replies. On the cap: STATE=pending plus a CURSOR — call again with that cursor and task_id to resume. On approval_requested: approve via the "approve" tool, then resume.',
  {
    task_id: z.string().optional().describe('Task to wait on. Provide this or "nonce".'),
    nonce: z
      .string()
      .optional()
      .describe("Substring matched in the task's event log — use when you tagged a message with a nonce but don't yet know the task id."),
    timeout_seconds: z
      .number()
      .optional()
      .describe('Overall wait budget for this call (capped server-side, default ~45s).'),
    cursor: z
      .number()
      .optional()
      .describe('Resume cursor from a prior STATE=pending result (pass together with task_id).'),
  },
  async ({ task_id, nonce, timeout_seconds, cursor }) => {
    const r = await waitForTask(client, {
      taskId: task_id,
      nonce,
      timeoutSeconds: timeout_seconds,
      cursor,
    });
    const lines: string[] = [];
    lines.push(`TASK=${r.task_id ?? '(none)'}`);
    lines.push(`STATE=${r.state}`);
    if (r.approval_type) lines.push(`APPROVAL_TYPE=${r.approval_type}`);
    if (r.approval_ref) lines.push(`APPROVAL_REF=${r.approval_ref}`);
    lines.push(`ATTRIBUTION=${r.attribution ?? '(none)'}`);
    for (const m of r.pm_replies) lines.push(`PM_REPLY: ${m.slice(0, 300)}`);
    if (r.cursor !== undefined) lines.push(`CURSOR=${r.cursor}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ---- Start ----

const transport = new StdioServerTransport();
await server.connect(transport);
