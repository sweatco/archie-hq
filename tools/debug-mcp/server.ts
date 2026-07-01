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
import { ArchieClient } from './archie-client.js';
import { waitForTask } from './wait-for-task.js';

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
  'List recent Archie tasks with their status and agents.',
  {},
  async () => {
    const tasks = await client.listTasks();
    if (tasks.length === 0) {
      return { content: [{ type: 'text', text: 'No tasks found.' }] };
    }
    const lines = tasks.map((t) => {
      const agents = t.agents.map((a) => `${a.id}(${a.active ? 'active' : 'idle'})`).join(', ');
      return `${t.task_id}  ${t.status.padEnd(12)}  owner=${t.task_owner || 'none'}  agents=[${agents}]`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'task_status',
  'Get detailed status of a task: metadata, active agents, and the tail of the knowledge log.',
  { task_id: z.string().describe('The task ID (e.g. task-20260410-1523-a3f9k2)') },
  async ({ task_id }) => {
    const detail = await client.getTaskDetail(task_id);
    const m = detail.metadata;

    const sections: string[] = [];

    sections.push(`Task: ${m.task_id}`);
    sections.push(`Status: ${m.status}`);
    sections.push(`Owner: ${m.task_owner || 'none'}`);
    sections.push(`Participants: ${m.participants.join(', ') || 'none'}`);
    if (m.edit_allowed !== undefined) sections.push(`Edit mode: ${m.edit_allowed ? 'allowed' : 'not allowed'}`);
    sections.push(`Created: ${m.created_at}`);
    sections.push(`Updated: ${m.updated_at}`);

    // Agent sessions
    const agentLines = detail.agents.map(
      (a) => `  ${a.id}: ${a.active ? 'active' : 'idle'}`,
    );
    if (agentLines.length > 0) {
      sections.push(`\nAgents:\n${agentLines.join('\n')}`);
    }

    // Knowledge log tail
    if (detail.knowledgeLog) {
      const lines = detail.knowledgeLog.trimEnd().split('\n');
      const tail = lines.slice(-30).join('\n');
      sections.push(`\nKnowledge log (last ${Math.min(30, lines.length)} lines):\n${tail}`);
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
  'Get the knowledge log for a task. Optionally return only the last N lines.',
  {
    task_id: z.string().describe('The task ID'),
    tail: z.number().optional().describe('Number of lines from the end to return (default: all)'),
  },
  async ({ task_id, tail }) => {
    const detail = await client.getTaskDetail(task_id);
    if (!detail.knowledgeLog) {
      return { content: [{ type: 'text', text: '(empty log)' }] };
    }
    let text = detail.knowledgeLog;
    if (tail) {
      const lines = text.trimEnd().split('\n');
      text = lines.slice(-tail).join('\n');
    }
    return { content: [{ type: 'text', text }] };
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
  'Approve or deny a pending request (edit mode or research budget) for a task.',
  {
    task_id: z.string().describe('The task ID'),
    type: z.enum(['edit_mode', 'research_budget']).describe('The request type to approve/deny'),
    approve: z.boolean().describe('true to approve, false to deny'),
  },
  async ({ task_id, type, approve }) => {
    await client.approve(task_id, type, approve);
    const action = approve ? 'Approved' : 'Denied';
    return { content: [{ type: 'text', text: `${action} ${type} for ${task_id}` }] };
  },
);

server.tool(
  'wait_for_task',
  'Block server-side until a task settles, in one call instead of polling get_events. Locate it by task_id or by a nonce in its knowledge log, then wait until completed / stopped / approval_requested or a ~45s cap. Returns STATE with the attribution line and any pm-agent replies. On the cap: STATE=pending plus a CURSOR — call again with that cursor and task_id to resume. On approval_requested: approve via the "approve" tool, then resume.',
  {
    task_id: z.string().optional().describe('Task to wait on. Provide this or "nonce".'),
    nonce: z
      .string()
      .optional()
      .describe("Substring matched in the task's knowledge log — use when you tagged a message with a nonce but don't yet know the task id."),
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
    lines.push(`ATTRIBUTION=${r.attribution ?? '(none)'}`);
    for (const m of r.pm_replies) lines.push(`PM_REPLY: ${m.slice(0, 300)}`);
    if (r.cursor !== undefined) lines.push(`CURSOR=${r.cursor}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ---- Start ----

const transport = new StdioServerTransport();
await server.connect(transport);
