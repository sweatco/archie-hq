#!/usr/bin/env tsx
/**
 * run.ts — drive ONE case ONCE against a live Archie, then measure it.
 *
 * One case, one sample, one process, on purpose. At temperature 0 repetitions
 * inside a single process are correlated samples: a loop of N reps is much
 * closer to one draw counted N times than to N independent draws. `campaign.sh`
 * therefore invokes this script once per sample and interleaves the arms, so
 * drift over a measurement window hits both arms equally instead of being
 * mistaken for a difference between them. Keep both properties in anything
 * written against this harness.
 *
 * Usage:
 *   tsx tools/speed/run.ts --case self-roster [--arm before] [--out results]
 *                          [--url URL] [--sessions DIR] [--settle-ms 3000]
 *   tsx tools/speed/run.ts --list          human-readable
 *   tsx tools/speed/run.ts --ids           `CASE<tab><id>` lines, for scripts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ArchieClient } from '../debug-mcp/archie-client.js';
import { resolveBaseUrl } from '../e2e/config.js';
import { CORE_CASES, gradeCase, stimulusHash, withOverlay, validateCases, type CaseVerdict, type SpeedCase } from './cases.js';
import { extractSample, type SpeedEvent, type SpeedSample } from './metrics.js';
import { loadTask } from './sources.js';
import { parseArgs } from './measure.js';

/** One live run: what was asked, what came back, and how it graded. */
export interface RunResult {
  schema: 'archie-speed-run/v1';
  arm: string;
  caseId: string;
  /** Fingerprint of the prompt this run was actually given — see stimulusHash. */
  stimulus: string;
  nonce: string;
  taskId: string;
  startedAt: string;
  /** True when the task never reached a terminal state inside its timeout. */
  timedOut: boolean;
  verdict: CaseVerdict;
  sample: SpeedSample;
  /** Which tier of detail the sample was built from. */
  coverage: { events: boolean; usage: boolean; transcripts: string[] };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A task is done when Archie has both spoken and closed the turn — or when it
 * asked for an approval, which is terminal for measurement purposes: the clock
 * a person feels stopped when the buttons appeared.
 */
export function isTerminal(events: SpeedEvent[]): boolean {
  return events.some((e) => e.type === 'task:completed' || e.type === 'task:stopped' || e.type === 'approval:requested');
}

/** Load the optional deployment-specific overlay beside this file. */
async function loadCases(dir: string): Promise<SpeedCase[]> {
  const path = join(dir, 'cases.local.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return CORE_CASES;
  }
  const parsed = validateCases(JSON.parse(text));
  if (!parsed.ok) {
    throw new Error(`${path} is invalid:\n  ${parsed.errors.join('\n  ')}`);
  }
  return withOverlay(CORE_CASES, parsed.cases);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
  const cases = await loadCases(here);

  if (args.list || args.ids) {
    // `--ids` prefixes every line with a fixed marker so a shell caller can
    // filter on it. Tooling in the environment (a package-audit wrapper, a
    // proxy notice) can print a banner to stdout ahead of us, and a campaign
    // that took the first column of every line would run a case called
    // "Fetching".
    for (const c of cases) {
      if (args.ids) console.log(`CASE\t${c.id}`);
      else console.log(`${c.id.padEnd(24)} ${c.klass.padEnd(16)} maxDelegations=${c.maxDelegations ?? '-'}`);
    }
    process.exit(0);
  }

  const caseId = String(args.case ?? '');
  const c = cases.find((x) => x.id === caseId);
  if (!c) {
    console.error(`Unknown case "${caseId}". Known: ${cases.map((x) => x.id).join(', ')}`);
    process.exit(1);
  }

  const arm = String(args.arm ?? 'now');
  const outDir = resolve(String(args.out ?? join(here, 'results')));
  // A bare `--settle-ms` (no value) parses as `true`; Number(true) is 1, which
  // would silently disable the flush wait. Only a real numeric value counts.
  const settleRaw = args['settle-ms'];
  const settleMs = typeof settleRaw === 'string' && Number.isFinite(Number(settleRaw)) ? Number(settleRaw) : 3000;

  let dotenv: string | undefined;
  try {
    dotenv = await readFile(resolve(here, '..', '..', '.env'), 'utf8');
  } catch {
    dotenv = undefined;
  }
  const baseUrl = typeof args.url === 'string' ? args.url : resolveBaseUrl(process.env, dotenv);
  // Anchored to the repo root, NOT to cwd: campaign.sh runs from tools/speed,
  // where a relative `workdir/sessions` resolves to a directory that does not
  // exist — and a missing folder degrades silently to event-only metrics, so
  // the whole campaign would have quietly produced no round-trip data at all.
  const repoRoot = resolve(here, '..', '..');
  const sessionsDir = resolve(
    typeof args.sessions === 'string' ? args.sessions
      : process.env.ARCHIE_SESSIONS_DIR ?? join(process.env.ARCHIE_WORKDIR ?? join(repoRoot, 'workdir'), 'sessions'),
  );

  const nonce = `SPEED-${randomUUID().slice(0, 8)}`;
  const prompt = c.prompt.replaceAll('{{NONCE}}', nonce);
  const client = new ArchieClient(baseUrl);

  console.error(`[${arm}] ${c.id}  nonce=${nonce}  ${baseUrl}`);
  const startedAt = new Date().toISOString();
  const taskId = await client.createTask(prompt);

  // Poll rather than stream: the SSE endpoint carries every task on the
  // instance, and the events endpoint already gives us exactly this task's log
  // with an offset cursor. One fewer moving part in the thing doing the timing.
  const deadline = Date.now() + c.timeoutMs;
  let events: SpeedEvent[] = [];
  let timedOut = true;
  while (Date.now() < deadline) {
    await sleep(1000);
    events = (await client.getEvents(taskId)).events as SpeedEvent[];
    if (isTerminal(events)) { timedOut = false; break; }
  }

  // A follow-up turn, measured as its own exchange. Sent only if the first turn
  // actually settled — messaging a task that is still mid-turn would measure the
  // queue, not the turn.
  if (c.followUp && !timedOut) {
    await client.sendMessage(taskId, c.followUp);
    const followDeadline = Date.now() + c.timeoutMs;
    const seen = events.length;
    timedOut = true;
    while (Date.now() < followDeadline) {
      await sleep(1000);
      events = (await client.getEvents(taskId)).events as SpeedEvent[];
      // Terminal again, judged only on events that arrived AFTER the follow-up:
      // the first turn's own task:completed is still in the log.
      if (isTerminal(events.slice(seen))) { timedOut = false; break; }
    }
  }

  // Session transcripts and usage are written asynchronously; reading the folder
  // the instant a task completes catches a half-flushed file and undercounts the
  // final turn. Wait, then read.
  await sleep(settleMs);

  const loaded = await loadTask(join(sessionsDir, taskId), taskId);
  // Prefer the on-disk event log (complete) but fall back to what we polled, so
  // a run against a remote instance still produces the felt-latency numbers.
  const sources = loaded.found.events ? loaded.sources : { ...loaded.sources, events };
  const sample = extractSample(sources);
  const verdict = gradeCase(c, sample, sources.events);

  const result: RunResult = {
    schema: 'archie-speed-run/v1',
    arm, caseId: c.id, stimulus: stimulusHash(c), nonce, taskId, startedAt, timedOut, verdict, sample,
    coverage: loaded.found,
  };

  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `run-${arm}-${c.id}-${nonce}.json`);
  await writeFile(file, JSON.stringify(result, null, 2));

  const ttfw = verdict.timeToFirstWordMs === null ? 'never' : `${(verdict.timeToFirstWordMs / 1000).toFixed(1)}s`;
  const status = timedOut ? 'TIMEOUT' : verdict.pass ? 'PASS' : 'FAIL';
  console.log(
    `${status.padEnd(8)}${c.id.padEnd(22)}first word ${ttfw.padEnd(10)}` +
    `hops ${String(verdict.delegations).padEnd(4)}silent setup ${String(verdict.silentSetupRoundTrips ?? '-').padEnd(4)}${taskId}`,
  );
  for (const f of verdict.failures) console.log(`         - ${f}`);
  if (!loaded.found.events) {
    console.log(`         - WARNING: no task folder at ${join(sessionsDir, taskId)} — event-only metrics, no round trips`);
  }
  console.error(`  -> ${file}`);

  // Timeouts and graded failures are run failures. A campaign that shrugs them
  // off would report a suite of broken runs as a fast arm.
  process.exit(timedOut || !verdict.pass ? 1 : 0);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
