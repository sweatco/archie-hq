/**
 * Feasibility probes for the test-persona tools: how Slack and a test instance treat actions
 * taken as a workspace member.
 *
 *   npx tsx tools/persona-mcp/probe.ts [--tokens] [--post [--only P1|P2]] [--signed] [--out <file>]
 *
 * Without flags it only checks whether the instance's task API is reachable (P3).
 *   --tokens  also checks that every persona token belongs to the configured workspace and
 *             member. Reads only.
 *   --post    also posts as a persona, after the token check: the payload shape of a
 *             user-token message (P1), and whether a mention and a DM each create a task (P2).
 *             Writes to the workspace and creates tasks on the instance. P2 is skipped while
 *             the config has no archieBotUserId.
 *   --signed  also sends signed requests to the instance's Slack webhook (P4). No handler runs.
 *
 * The report goes to stdout (or --out) as JSON with Slack IDs reduced to their type letter.
 * Progress goes to stderr. No token or secret is ever written.
 */

import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import type { WebClient } from '@slack/web-api';
import { ArchieClient } from '../debug-mcp/archie-client.js';
import { waitForTask } from '../debug-mcp/wait-for-task.js';
import type { PersonaConfig } from './config.js';
import { loadPersonaConfig } from './load-config.js';
import { connectPersonas, createSlackClient, type ActingPersona } from './persona-clients.js';
import {
  describeAuthorship,
  interpretReach,
  interpretWebhook,
  redactSlackIds,
  type HttpObservation,
} from './probe-checks.js';
import { readSecret, runCommand } from './secrets.js';
import {
  buttonClickInteraction,
  signedEventRequest,
  signedInteractionRequest,
  type SignedSlackRequest,
} from './slack-signing.js';

const HTTP_TIMEOUT_MS = 10_000;
const TASK_WAIT_SECONDS = 180;
const REPLY_POLL_INTERVAL_MS = 5_000;

type ProbePersona = ActingPersona<WebClient>;

interface Created {
  kind: 'message' | 'task';
  where: string;
  id: string;
}

const progress = (line: string): void => console.error(`[probe] ${line}`);
const newNonce = (): string => `E2E-${randomBytes(4).toString('hex')}`;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function observeHttp(url: string): Promise<HttpObservation> {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const location = response.headers.get('location');
    return {
      kind: 'response',
      status: response.status,
      contentType: response.headers.get('content-type'),
      redirectHost: location ? new URL(location, url).host : null,
    };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return {
      kind: 'network_error',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** P3: can the instance's task API be used from this machine? */
async function probeReach(archieApiUrl: string) {
  const health = await observeHttp(`${archieApiUrl}/health`);
  const tasks = await observeHttp(`${archieApiUrl}/api/tasks`);
  return { ...interpretReach(health, tasks), health, tasks };
}

/**
 * P1: which authorship markers does a user-token post carry? The markers belong to the message,
 * so the author reads it back when no second persona is configured.
 */
async function probePayloadShape(
  author: ProbePersona,
  reader: ProbePersona,
  channel: string,
  created: Created[],
) {
  const nonce = newNonce();
  const posted = await author.slack.chat.postMessage({
    channel,
    text: `[persona-probe ${nonce}] P1 payload-shape check posted with a user token. Safe to ignore.`,
  });
  if (!posted.ts) throw new Error('P1: Slack returned no ts for the posted message');
  created.push({ kind: 'message', where: 'probe channel', id: posted.ts });

  const history = await reader.slack.conversations.history({
    channel,
    oldest: posted.ts,
    latest: posted.ts,
    inclusive: true,
    limit: 1,
  });
  const [message] = history.messages ?? [];
  if (!message) throw new Error('P1: the reader persona could not read the message back');
  const raw: Record<string, unknown> = { ...message };
  return {
    nonce,
    readBackBy:
      reader === author
        ? 'the author, with the same user token'
        : 'another member, with a user token',
    authorship: describeAuthorship(raw),
    payload: redactSlackIds(raw),
  };
}

/** Wait for Archie to reply in the thread a persona started, as that persona sees it. */
async function archieRepliedInThread(
  author: ProbePersona,
  channel: string,
  threadTs: string,
  archieBotUserId: string,
): Promise<boolean> {
  const deadline = Date.now() + TASK_WAIT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const thread = await author.slack.conversations.replies({ channel, ts: threadTs, limit: 50 });
    if (thread.messages?.some((reply) => reply.user === archieBotUserId)) return true;
    await sleep(REPLY_POLL_INTERVAL_MS);
  }
  return false;
}

/** Read the task that carries the nonce, and whether it recorded the persona as a memory author. */
async function observeTask(archieApiUrl: string, nonce: string, authorUserId: string) {
  const archie = new ArchieClient(archieApiUrl);
  const waited = await waitForTask(
    archie,
    { nonce, timeoutSeconds: TASK_WAIT_SECONDS },
    { capSeconds: TASK_WAIT_SECONDS },
  );
  if (!waited.task_id) return { found: false as const };
  const detail = await archie.getTaskDetail(waited.task_id);
  const metadata: Record<string, unknown> = { ...detail.metadata };
  const authors = metadata.memory_authors;
  const memoryAuthorRecorded =
    typeof authors === 'object' && authors !== null && authorUserId in authors;
  return {
    found: true as const,
    taskId: waited.task_id,
    state: waited.state,
    memoryAuthorRecorded,
  };
}

/** P2: does a message posted with a user token start a task, and is its author a memory author? */
async function probeTaskCreation(
  entry: 'mention' | 'dm',
  author: ProbePersona,
  channel: string,
  archie: { botUserId: string; apiUrl: string | undefined },
  created: Created[],
) {
  const nonce = newNonce();
  const mention = entry === 'mention' ? `<@${archie.botUserId}> ` : '';
  const posted = await author.slack.chat.postMessage({
    channel,
    text: `${mention}[persona-probe ${nonce}] Reply with the single word "pong". Do not modify anything.`,
  });
  if (!posted.ts) throw new Error(`P2 ${entry}: Slack returned no ts for the posted message`);
  created.push({
    kind: 'message',
    where: entry === 'dm' ? 'DM with Archie' : 'probe channel',
    id: posted.ts,
  });
  progress(`P2 ${entry}: posted ${nonce}, waiting up to ${TASK_WAIT_SECONDS}s for Archie`);

  const task = archie.apiUrl
    ? await observeTask(archie.apiUrl, nonce, author.persona.slackUserId)
    : ('task API not reachable: memory author not observable' as const);
  if (typeof task === 'object' && task.found) {
    created.push({ kind: 'task', where: 'instance', id: task.taskId });
  }
  const archieReplied = await archieRepliedInThread(author, channel, posted.ts, archie.botUserId);
  return { entry, nonce, archieReplied, task };
}

async function postSigned(url: string, request: SignedSlackRequest) {
  const response = await fetch(url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return { status: response.status, text: await response.text() };
}

/** P4: does the instance accept requests signed with its signing secret, and refuse others? */
async function probeSignedRequests(config: PersonaConfig, webhookUrl: string, secretRef: string) {
  const signingSecret = await readSecret(secretRef, { env: process.env, run: runCommand });
  const challenge = newNonce();
  const verificationEvent = { type: 'url_verification', challenge };

  const verification = await postSigned(
    webhookUrl,
    signedEventRequest(signingSecret, nowSeconds(), verificationEvent),
  );
  const tampered = await postSigned(
    webhookUrl,
    signedEventRequest(`not-${signingSecret}`, nowSeconds(), verificationEvent),
  );
  // No handler claims this action, so the request ends after the signature check: Bolt answers
  // 404 once its acknowledgement window passes, and nothing on the instance changes.
  const unclaimedClick = buttonClickInteraction(
    {
      teamId: config.teamId,
      userId: config.personas[0].slackUserId,
      channelId: config.probeChannelId ?? 'C0000000000',
      messageTs: `${nowSeconds()}.000000`,
      actionId: 'persona_probe_unclaimed',
    },
    nowSeconds(),
  );
  const button = await postSigned(
    webhookUrl,
    signedInteractionRequest(signingSecret, nowSeconds(), unclaimedClick),
  );

  return interpretWebhook({
    verification: {
      status: verification.status,
      echoedChallenge: verification.text.includes(challenge),
    },
    tampered: { status: tampered.status },
    button: { status: button.status },
  });
}

/**
 * Run one probe so that its failure becomes part of the report. A probe that posted before it
 * failed has already added to `created`, and that list must reach the report either way.
 */
async function attempt<Result>(
  name: string,
  probe: () => Promise<Result>,
): Promise<Result | { failed: string }> {
  try {
    return await probe();
  } catch (error) {
    const failed = error instanceof Error ? error.message : String(error);
    progress(`${name} failed: ${failed}`);
    return { failed };
  }
}

function flagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const mayPost = process.argv.includes('--post');
  const maySign = process.argv.includes('--signed');
  const checkTokens = mayPost || process.argv.includes('--tokens');
  const only = flagValue('--only');
  if (only !== undefined && only !== 'P1' && only !== 'P2') {
    throw new Error('--only takes P1 or P2');
  }
  const config = loadPersonaConfig();
  const created: Created[] = [];
  const skipped = (reason: string) => ({ skipped: reason });
  progress(`environment "${config.environment}"`);

  const reach = config.archieApiUrl
    ? await probeReach(config.archieApiUrl)
    : skipped('archieApiUrl is not configured');
  const apiIsOpen = 'reach' in reach && reach.reach === 'open';
  progress(`P3 reach: ${'reach' in reach ? `${reach.reach} (${reach.detail})` : reach.skipped}`);

  // Every token is checked before the first write, so a misfiled token stops the run here.
  const personas = checkTokens
    ? await connectPersonas(config, { env: process.env, run: runCommand }, createSlackClient)
    : [];
  if (checkTokens) progress(`tokens: ${personas.length} personas match the workspace`);

  let payloadShape: unknown = skipped('run with --post');
  let taskCreation: unknown = skipped('run with --post');
  const [author, reader = author] = personas;
  const channel = config.probeChannelId;
  const botUserId = config.archieBotUserId;
  if (mayPost && !channel) {
    payloadShape = taskCreation = skipped('probeChannelId is not configured');
  } else if (mayPost && channel) {
    payloadShape =
      only === 'P2'
        ? skipped('--only P2')
        : await attempt('P1', () => probePayloadShape(author, reader, channel, created));
    if (only === 'P1') taskCreation = skipped('--only P1');
    else if (!botUserId) taskCreation = skipped('archieBotUserId is not configured');
    else {
      const archie = { botUserId, apiUrl: apiIsOpen ? config.archieApiUrl : undefined };
      // Each entry point is attempted on its own, so one refusal does not discard the other's result.
      taskCreation = [
        await attempt('P2 mention', () =>
          probeTaskCreation('mention', author, channel, archie, created),
        ),
        await attempt('P2 dm', async () => {
          const dm = await author.slack.conversations.open({ users: botUserId });
          if (!dm.channel?.id) throw new Error('could not open a DM with Archie');
          return probeTaskCreation('dm', author, dm.channel.id, archie, created);
        }),
      ];
    }
  }

  let signedRequests: unknown = skipped('run with --signed');
  if (maySign) {
    const { slackWebhookUrl, signingSecret } = config;
    signedRequests =
      slackWebhookUrl && signingSecret
        ? await attempt('P4', () => probeSignedRequests(config, slackWebhookUrl, signingSecret))
        : skipped('slackWebhookUrl and signingSecret are not both configured');
  }

  const report = {
    probedAt: new Date().toISOString(),
    environment: config.environment,
    tokensChecked: checkTokens
      ? personas.map(({ persona }) => persona.key)
      : skipped('run with --tokens'),
    P1_payloadShape: payloadShape,
    P2_taskCreation: taskCreation,
    P3_reach: reach,
    P4_signedRequests: signedRequests,
    created,
  };
  const reportJson = `${JSON.stringify(redactSlackIds(report), null, 2)}\n`;
  const outPath = flagValue('--out');
  if (outPath) writeFileSync(outPath, reportJson, { mode: 0o600 });
  else process.stdout.write(reportJson);
  progress(outPath ? `report written to ${outPath}` : 'done');
}

main().catch((error: unknown) => {
  console.error(`probe: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
