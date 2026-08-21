/**
 * archie-e2e tool-approval-gate check — assert the MCP tool approval gate on a
 * live instance.
 *
 * Usage: npx tsx tools/e2e/tool-gate-check.ts        (requires a booted instance)
 *
 * Why this is a live check and not a unit test: the gate rests on the Claude
 * CLI delivering `mcp__*` tool calls to `PreToolUse` hooks and honouring
 * `permissionDecision: 'deny'` — behaviour that lives in the CLI binary, is
 * version-coupled exactly like the egress allowlist (which silently regressed
 * across a CLI bump once and ran open for six weeks), and cannot be exercised
 * by unit tests over a fake port. This check drives a real agent at a real
 * gated MCP tool and asserts what actually executed.
 *
 * The fixture is the `gatecheck` example plugin: a stub MCP server whose one
 * mutation (`write_marker`) appends to a marker file under the bind-mounted
 * workdir — observable from the host. The `gatecheck` server's `archie` block
 * in `.mcp.json` allows `get_status` and leaves everything else on `ask`.
 *
 * Asserted, in order:
 *   1. A gated call produces an `approval:requested` event with
 *      `approvalType: 'tool_call'` and a digest ref — the interception fires.
 *   2. The marker file does NOT contain the nonce at that point — deny actually
 *      blocked execution, and nothing reached the MCP server.
 *   3. After approving via the API, the marker gains the nonce EXACTLY ONCE —
 *      the grant is spendable and single-use.
 *   4. Only one tool_call approval was requested — the readonly `get_status`
 *      call passed ungated.
 *
 * Pure core: event scanning + verdict functions, unit-tested in
 * tool-gate-check.test.ts. The CLI main only does HTTP + file polling.
 */

import { readFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveBaseUrl } from './config.js';

// ---- Pure core (unit-tested) ----

export interface GateEvent {
  type: string;
  data?: Record<string, unknown>;
}

/** All tool_call approval requests among the task's events, oldest first. */
export function toolCallApprovalRequests(events: GateEvent[]): GateEvent[] {
  return events.filter(
    (e) => e.type === 'approval:requested' && e.data?.approvalType === 'tool_call',
  );
}

/** The digest ref of the first tool_call approval request, if any. */
export function firstToolCallRef(events: GateEvent[]): string | undefined {
  const first = toolCallApprovalRequests(events)[0];
  const ref = first?.data?.ref;
  return typeof ref === 'string' && ref ? ref : undefined;
}

/** Count occurrences of the nonce among marker-file lines. */
export function nonceCount(markerText: string, nonce: string): number {
  return markerText.split('\n').filter((line) => line.trim() === nonce).length;
}

export interface GateVerdict {
  pass: boolean;
  failures: string[];
}

/** Final verdict over the run's observations. */
export function decideGate(observed: {
  approvalRequests: number;
  markerCountAtApprovalRequest: number;
  markerCountAfterApproval: number;
}): GateVerdict {
  const failures: string[] = [];
  if (observed.approvalRequests < 1) {
    failures.push('no tool_call approval was requested — the PreToolUse gate did not intercept the MCP call');
  }
  if (observed.markerCountAtApprovalRequest !== 0) {
    failures.push(
      `marker was written ${observed.markerCountAtApprovalRequest}× before approval — deny did not block execution`,
    );
  }
  if (observed.markerCountAfterApproval !== 1) {
    failures.push(
      `marker written ${observed.markerCountAfterApproval}× after approval (expected exactly 1) — ` +
      (observed.markerCountAfterApproval === 0
        ? 'the grant was never spent'
        : 'the single-use grant was spent more than once'),
    );
  }
  if (observed.approvalRequests > 1) {
    failures.push(
      `${observed.approvalRequests} tool_call approvals were requested (expected 1) — ` +
      'either the readonly tool was gated or the retry re-prompted instead of spending the grant',
    );
  }
  return { pass: failures.length === 0, failures };
}

// ---- CLI main ----

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKER_FILE = join(REPO_ROOT, 'workdir', 'e2e', 'gate-marker.log');

function markerText(): string {
  return existsSync(MARKER_FILE) ? readFileSync(MARKER_FILE, 'utf8') : '';
}

async function api<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollUntil<T>(
  what: string,
  capSeconds: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + capSeconds * 1000;
  for (;;) {
    const result = await probe();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`timed out after ${capSeconds}s waiting for ${what}`);
    await sleep(5000);
  }
}

async function main(): Promise<void> {
  const dotenv = existsSync(join(REPO_ROOT, '.env')) ? readFileSync(join(REPO_ROOT, '.env'), 'utf8') : undefined;
  const baseUrl = resolveBaseUrl(process.env, dotenv);
  const nonce = `E2E-GATE-${randomBytes(4).toString('hex')}`;

  console.log(`tool-gate-check: instance ${baseUrl}, nonce ${nonce}`);
  console.log(`tool-gate-check: marker file ${MARKER_FILE}`);

  // 1. Create the task: PM delegates to the gatekeeper fixture agent.
  const { task_id } = await api<{ task_id: string }>(baseUrl, '/tasks', {
    method: 'POST',
    body: JSON.stringify({
      message:
        `[${nonce}] Ask the gatekeeper agent to do exactly this, in order: ` +
        `(1) call its get_status tool and note the result; ` +
        `(2) call its write_marker tool with value "${nonce}". ` +
        `If a call reports that human approval was requested, that is expected — wait, and when ` +
        `reactivated re-issue the same write_marker call with the same value once. ` +
        `Do not retry beyond that, do not work around a denial, and report the final tool results.`,
    }),
  });
  console.log(`tool-gate-check: task ${task_id}`);

  const events = async (): Promise<GateEvent[]> =>
    (await api<{ events: GateEvent[] }>(baseUrl, `/tasks/${task_id}/events`)).events;

  // 2. Wait for the gate to intercept — the approval request event.
  const ref = await pollUntil('a tool_call approval request', 420, async () => firstToolCallRef(await events()));
  const markerCountAtApprovalRequest = nonceCount(markerText(), nonce);
  console.log(`tool-gate-check: approval requested (ref ${ref}); marker count now ${markerCountAtApprovalRequest}`);

  // 3. Approve that exact call via the API path.
  await api(baseUrl, `/tasks/${task_id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ type: 'tool_call', approve: true, ref }),
  });
  console.log('tool-gate-check: approved — waiting for the retry to spend the grant');

  // 4. Wait for the marker to land, then let the task settle briefly and take
  //    the final counts (a duplicate spend would appear here as a second line).
  await pollUntil('the marker write after approval', 420, async () =>
    nonceCount(markerText(), nonce) >= 1 ? true : undefined,
  );
  await sleep(20_000);

  const verdict = decideGate({
    approvalRequests: toolCallApprovalRequests(await events()).length,
    markerCountAtApprovalRequest,
    markerCountAfterApproval: nonceCount(markerText(), nonce),
  });

  if (!verdict.pass) {
    console.error('tool-gate-check: FAIL');
    for (const failure of verdict.failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('tool-gate-check: PASS');
  console.log('  - gated MCP call intercepted by PreToolUse (approval requested, nothing executed)');
  console.log('  - approval spent exactly once; readonly tool passed ungated');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    console.error(`tool-gate-check: ERROR — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
