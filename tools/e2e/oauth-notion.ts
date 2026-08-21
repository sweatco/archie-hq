#!/usr/bin/env node

import 'dotenv/config';
import { randomBytes } from 'crypto';
import { promises as fsp, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ArchieClient } from '../debug-mcp/archie-client.js';
import { waitForTask } from '../debug-mcp/wait-for-task.js';
import { validateMasterKey } from '../../src/system/secrets-vault.js';
import { beginConnect, readMcpServerUrl, resolveRedirectUri } from '../../src/system/oauth/connect.js';
import { ensureFreshUserToken } from '../../src/system/oauth/refresh.js';
import {
  deletePendingIfIncomplete,
  findPendingUserAttempt,
  readOAuthClientRecord,
  readOAuthRecord,
  readPendingRecord,
  readUserOAuthRecord,
} from '../../src/system/oauth/storage.js';
import { resolveBaseUrl, resolveTimeoutSeconds } from './config.js';
import { makeExec } from './exec.js';
import {
  EVIDENCE_SCHEMA,
  resolveOutDir,
  writeEvidencePair,
  type Evidence,
  type EvidenceAssertion,
  type EvidenceFs,
} from './evidence.js';

const NOTION_MCP_URL = 'https://mcp.notion.com/mcp';
const DEFAULT_TIMEOUT_SECONDS = 10 * 60;
const POLL_INTERVAL_MS = 2_000;
const USAGE =
  'usage: npm run e2e:oauth:notion -- --shared-page <url> --shared-marker <text> ' +
  '--personal-page <url> --personal-marker <text> [--timeout-seconds N] [--out-dir DIR] [--reuse-shared]';

export interface NotionOAuthArgs {
  sharedPage: string;
  sharedMarker: string;
  personalPage: string;
  personalMarker: string;
  timeoutFlag?: string;
  outDir?: string;
  reuseShared: boolean;
}

export function parseArgs(argv: string[]): NotionOAuthArgs {
  const values: Partial<Omit<NotionOAuthArgs, 'reuseShared'>> & { reuseShared: boolean } = {
    reuseShared: false,
  };
  const take = (flag: string, index: number): string => {
    const value = argv[index];
    if (!value) throw new Error(`${flag} requires a value (${USAGE})`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--shared-page') values.sharedPage = take(arg, ++i);
    else if (arg === '--shared-marker') values.sharedMarker = take(arg, ++i);
    else if (arg === '--personal-page') values.personalPage = take(arg, ++i);
    else if (arg === '--personal-marker') values.personalMarker = take(arg, ++i);
    else if (arg === '--timeout-seconds') values.timeoutFlag = take(arg, ++i);
    else if (arg === '--out-dir') values.outDir = take(arg, ++i);
    else if (arg === '--reuse-shared') values.reuseShared = true;
    else throw new Error(`unknown argument: ${arg} (${USAGE})`);
  }
  for (const field of ['sharedPage', 'sharedMarker', 'personalPage', 'personalMarker'] as const) {
    if (!values[field]) throw new Error(`--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required (${USAGE})`);
  }
  return values as NotionOAuthArgs;
}

export function validateMarker(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
}

export function validatePreflight(input: {
  serverUrl: string;
  publicUrl: string | undefined;
  sharedPage: string;
  personalPage: string;
  sharedMarker: string;
  personalMarker: string;
}): string[] {
  const errors: string[] = [];
  if (input.serverUrl !== NOTION_MCP_URL) {
    errors.push(`MCP server "notion" must be ${NOTION_MCP_URL} (got ${input.serverUrl})`);
  }
  try {
    const publicUrl = new URL(input.publicUrl ?? '');
    if (publicUrl.protocol !== 'https:') errors.push('ARCHIE_PUBLIC_URL must use public HTTPS');
  } catch {
    errors.push('ARCHIE_PUBLIC_URL must be a valid public HTTPS URL');
  }
  for (const [name, value] of [
    ['shared page', input.sharedPage],
    ['personal page', input.personalPage],
  ] as const) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !/(^|\.)notion\.so$/.test(url.hostname)) {
        errors.push(`${name} must be an https://*.notion.so URL`);
      }
    } catch {
      errors.push(`${name} must be a valid Notion URL`);
    }
  }
  if (!validateMarker(input.sharedMarker)) {
    errors.push('shared marker must be 8-128 characters using only letters, numbers, _ or -');
  }
  if (!validateMarker(input.personalMarker)) {
    errors.push('personal marker must be 8-128 characters using only letters, numbers, _ or -');
  }
  if (input.sharedMarker === input.personalMarker) errors.push('shared and personal markers must differ');
  return errors;
}

export function redactEvidenceText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, '<redacted-url>')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted-secret>')
    .replace(/\b(access_token|refresh_token|client_secret)\b\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted-secret>');
}

export function dmIdentity(metadata: unknown): { channelId: string; userId: string } | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as Record<string, unknown>;
  if (typeof m['default_channel'] !== 'string' || !m['channels'] || typeof m['channels'] !== 'object') return null;
  const channel = (m['channels'] as Record<string, unknown>)[m['default_channel']];
  if (!channel || typeof channel !== 'object') return null;
  const c = channel as Record<string, unknown>;
  if (
    c['type'] !== 'slack'
    || typeof c['channel_id'] !== 'string'
    || !c['channel_id'].startsWith('D')
    || typeof c['dm_user_id'] !== 'string'
  ) return null;
  return { channelId: c['channel_id'], userId: c['dm_user_id'] };
}

async function waitUntil<T>(label: string, timeoutSeconds: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function requireHealthy(baseUrl: string): Promise<void> {
  await waitUntil('Archie health', 60, async () => {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      return response.ok ? true : null;
    } catch {
      return null;
    }
  });
}

async function waitForSharedGrant(state: string, timeoutSeconds: number): Promise<void> {
  await waitUntil('shared Notion authorization', timeoutSeconds, async () => {
    const pending = await readPendingRecord(state);
    if (pending?.error) throw new Error('Shared Notion authorization failed; inspect the pending record for details');
    return (await readOAuthRecord('notion')) ? true : null;
  });
}

async function eventCursor(client: ArchieClient, taskId: string): Promise<number> {
  return (await client.getEvents(taskId)).total;
}

async function waitForPmMarker(
  client: ArchieClient,
  taskId: string,
  marker: string,
  after: number,
  timeoutSeconds: number,
): Promise<void> {
  let cursor = after;
  await waitUntil(`PM response containing ${marker}`, timeoutSeconds, async () => {
    const result = await client.getEvents(taskId, cursor);
    cursor = result.total;
    return result.events.some((event) =>
      event.type === 'message'
      && event.data['from'] === 'pm-agent'
      && String(event.data['message'] ?? '').includes(marker)) ? true : null;
  });
}

function selectedPersonal(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const value = (metadata as Record<string, unknown>)['mcp_personal_oauth'];
  return Array.isArray(value) && value.includes('notion');
}

async function scenario(args: NotionOAuthArgs): Promise<void> {
  validateMasterKey();
  const serverUrl = readMcpServerUrl('notion');
  const preflightErrors = validatePreflight({
    serverUrl,
    publicUrl: process.env.ARCHIE_PUBLIC_URL,
    sharedPage: args.sharedPage,
    personalPage: args.personalPage,
    sharedMarker: args.sharedMarker,
    personalMarker: args.personalMarker,
  });
  if (preflightErrors.length > 0) throw new Error(`Preflight failed:\n- ${preflightErrors.join('\n- ')}`);

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let dotenvText: string | undefined;
  try {
    dotenvText = readFileSync(join(repoRoot, '.env'), 'utf8');
  } catch {
    dotenvText = undefined;
  }
  const baseUrl = resolveBaseUrl(process.env, dotenvText).replace(/\/+$/, '');
  const timeoutSeconds = resolveTimeoutSeconds(args.timeoutFlag, process.env.E2E_OAUTH_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS);
  const client = new ArchieClient(baseUrl);
  const exec = makeExec({ cwd: repoRoot });
  const assertions: EvidenceAssertion[] = [];
  const pass = (id: string, description: string, expected: string, observed: string): void => {
    assertions.push({ id, description, expected, observed, pass: true });
  };
  const startedAt = new Date().toISOString();
  const nonce = `oauth-e2e-${randomBytes(6).toString('hex')}`;

  await requireHealthy(baseUrl);
  pass('preflight', 'Official Notion endpoint and live Archie instance', NOTION_MCP_URL, `${serverUrl}; ${baseUrl}`);

  const existingShared = await readOAuthRecord('notion');
  if (existingShared && !args.reuseShared) {
    throw new Error('A shared Notion record already exists. Use an isolated secrets directory or pass --reuse-shared deliberately.');
  }
  if (!existingShared) {
    const connect = await beginConnect({ serverName: 'notion', redirectUri: resolveRedirectUri() });
    console.log('\nAuthorize operator identity A in the browser:\n');
    console.log(connect.authorizeUrl);
    console.log('\nWaiting for the callback...\n');
    await waitForSharedGrant(connect.state, timeoutSeconds);
  }
  pass('shared-grant', 'Shared operator grant exists', 'encrypted shared Notion record', 'present');

  console.log('\nFrom Slack identity B, send this exact DM to Archie:\n');
  console.log(
    `[${nonce}] Use Notion MCP to open ${args.sharedPage} and reply with the exact E2E marker stored on the page. ` +
    'Do not request personal authorization.',
  );
  console.log('\nWaiting for the DM task...\n');

  const initial = await waitForTask(client, { nonce, timeoutSeconds }, { capSeconds: timeoutSeconds });
  if (!initial.task_id) throw new Error('No Slack DM task containing the nonce was found');
  if (!initial.pm_replies.some((message) => message.includes(args.sharedMarker))) {
    throw new Error(`The shared-first response did not contain marker ${args.sharedMarker}`);
  }
  const taskId = initial.task_id;
  let detail = await client.getTaskDetail(taskId);
  const identity = dmIdentity(detail.metadata);
  if (!identity) throw new Error(`Task ${taskId} is not a resolved 1:1 Slack DM`);
  if (selectedPersonal(detail.metadata)) throw new Error('Notion was already selected personal before the escalation step');
  if (await readUserOAuthRecord(identity.userId, 'notion')) {
    throw new Error(`User ${identity.userId} already has a Notion grant; revoke it and rerun to exercise the callback`);
  }
  pass('shared-first', 'DM uses shared credentials before escalation', args.sharedMarker, 'marker returned; personal policy absent');
  pass('dm-identity', 'Task binds OAuth to the 1:1 DM participant', 'resolved Slack DM user', 'resolved');

  const personalCursor = await eventCursor(client, taskId);
  await client.sendMessage(
    taskId,
    `[${nonce}] Open the private Notion page ${args.personalPage} and reply with its exact E2E marker. ` +
    'If shared access cannot open it, initiate the DM personal OAuth flow and continue after authorization.',
  );
  const pending = await waitUntil('personal authorization link', timeoutSeconds, () =>
    findPendingUserAttempt(taskId, identity.userId, 'notion'));
  detail = await client.getTaskDetail(taskId);
  if (!selectedPersonal(detail.metadata)) throw new Error('Notion was not persisted as personal before authorization');
  pass('personal-escalation', 'Shared denial creates one personal authorization attempt', 'one pending DM authorization', 'created');

  console.log('\nOpen the Notion authorization link that Archie posted in the Slack DM as identity B.');
  console.log('Waiting for callback, wake delivery, and the private marker...\n');
  await waitUntil('personal Notion grant', timeoutSeconds, () => readUserOAuthRecord(identity.userId, 'notion'));
  await waitForPmMarker(client, taskId, args.personalMarker, personalCursor, timeoutSeconds);
  pass('callback-wake', 'Browser callback stores the user grant and wakes the same task', args.personalMarker, 'marker returned by resumed PM');

  console.log('Restarting the Docker Archie service...');
  const restart = await exec('docker', ['compose', 'restart', 'archie']);
  if (restart.code !== 0) throw new Error(`docker compose restart failed: ${restart.stderr.trim()}`);
  await requireHealthy(baseUrl);
  const restartCursor = await eventCursor(client, taskId);
  await client.sendMessage(
    taskId,
    `[${nonce}] After the daemon restart, reopen ${args.personalPage} and reply with its exact E2E marker.`,
  );
  await waitForPmMarker(client, taskId, args.personalMarker, restartCursor, timeoutSeconds);
  pass('restart', 'Personal binding survives daemon restart', args.personalMarker, 'marker returned after restart');

  const beforeRefresh = await readUserOAuthRecord(identity.userId, 'notion');
  if (!beforeRefresh) throw new Error('Personal record disappeared before forced refresh');
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec <= beforeRefresh.updated_at) {
    await new Promise((resolve) => setTimeout(resolve, (beforeRefresh.updated_at - nowSec + 1) * 1_000));
  }
  await ensureFreshUserToken(identity.userId, 'notion', NOTION_MCP_URL, { force: true });
  const afterRefresh = await readUserOAuthRecord(identity.userId, 'notion');
  if (!afterRefresh || afterRefresh.updated_at <= beforeRefresh.updated_at) {
    throw new Error('Forced personal refresh did not advance updated_at');
  }
  const refreshCursor = await eventCursor(client, taskId);
  await client.sendMessage(
    taskId,
    `[${nonce}] After token refresh, reopen ${args.personalPage} and reply with its exact E2E marker.`,
  );
  await waitForPmMarker(client, taskId, args.personalMarker, refreshCursor, timeoutSeconds);
  pass('refresh', 'Forced personal refresh preserves MCP access', 'updated_at advances and marker returns', `${beforeRefresh.updated_at} -> ${afterRefresh.updated_at}`);

  const sharedBeforeRevoke = await readOAuthRecord('notion');
  const clientBeforeRevoke = await readOAuthClientRecord('notion');
  const revoke = await exec('npm', ['run', 'oauth:revoke', '--', 'notion', '--user', identity.userId]);
  if (revoke.code !== 0) throw new Error(`targeted revoke failed: ${revoke.stderr.trim()}`);
  if (await readUserOAuthRecord(identity.userId, 'notion')) throw new Error('Targeted revoke left the personal record behind');
  if (
    JSON.stringify(await readOAuthRecord('notion')) !== JSON.stringify(sharedBeforeRevoke)
    || JSON.stringify(await readOAuthClientRecord('notion')) !== JSON.stringify(clientBeforeRevoke)
  ) throw new Error('Targeted revoke changed the shared grant or DCR client');
  pass('targeted-revoke', 'Targeted revoke removes only identity B', 'personal removed; shared and client unchanged', 'verified');

  await client.sendMessage(
    taskId,
    `[${nonce}] Reopen ${args.personalPage}. Do not fall back to shared credentials; request personal authorization again.`,
  );
  const reprompt = await waitUntil('post-revoke personal authorization link', timeoutSeconds, () =>
    findPendingUserAttempt(taskId, identity.userId, 'notion'));
  if (!await deletePendingIfIncomplete(reprompt.state)) {
    throw new Error('Post-revoke authorization attempt completed unexpectedly before cleanup');
  }
  pass('post-revoke', 'Next personal need prompts again without shared fallback', 'new pending personal authorization', 'created');

  const finalDetail = await client.getTaskDetail(taskId);
  const eventResult = await client.getEvents(taskId);
  const relevantLines = finalDetail.knowledgeLog
    .split('\n')
    .filter((line) => line.includes(nonce) || line.includes(args.sharedMarker) || line.includes(args.personalMarker) || /MCP authorization/i.test(line))
    .slice(-60)
    .map(redactEvidenceText);
  const safeEvents = eventResult.events.map((event) => ({
    timestamp: event.timestamp,
    type: event.type,
    agentName: event.agentName,
    data: event.type === 'message'
      ? { from: event.data['from'], to: event.data['to'], message: redactEvidenceText(String(event.data['message'] ?? '')) }
      : {},
  }));
  const branch = await exec('git', ['branch', '--show-current']);
  const commit = await exec('git', ['rev-parse', 'HEAD']);
  const status = String(finalDetail.metadata.status);
  const terminalState = status === 'completed' || status === 'stopped' ? status : 'pending';
  const evidence: Evidence = {
    schema: EVIDENCE_SCHEMA,
    scenario: 'notion-per-user-oauth',
    ac_ids: ['per-user-mcp-oauth-4.4'],
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    environment: {
      base_url: baseUrl,
      git_branch: branch.stdout.trim() || '(unknown)',
      git_commit: commit.stdout.trim() || '(unknown)',
    },
    nonce,
    task_id: taskId,
    terminal_state: terminalState,
    assertions,
    excerpts: { knowledge_log: relevantLines, events: safeEvents },
    result: 'pass',
  };
  const outDir = resolveOutDir(args.outDir, process.env.E2E_EVIDENCE_DIR, join(repoRoot, 'e2e-evidence'));
  const fs: EvidenceFs = {
    mkdir: async (path) => void (await fsp.mkdir(path, { recursive: true })),
    writeFile: (path, content) => fsp.writeFile(path, content, 'utf8'),
    rename: (from, to) => fsp.rename(from, to),
    unlink: (path) => fsp.unlink(path),
  };
  const paths = await writeEvidencePair(fs, outDir, evidence);
  console.log(`\nPASS: ${paths.jsonPath}`);
  console.log(`PASS: ${paths.mdPath}`);
}

async function main(): Promise<void> {
  try {
    await scenario(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
