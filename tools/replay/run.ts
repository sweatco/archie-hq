// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fixtures, productionEpisodes, sessionEpisodes, hash } from './corpus.js';
import { EpisodeSchema } from './types.js';
import { logger } from '../../src/system/logger.js';
import { z } from 'zod';

const [command = 'components', ...args] = process.argv.slice(2);
const capturePath = command === 'compare-components' ? undefined : args[0];
const baseRoot = args[command === 'compare-components' ? 0 : 1], candidateRoot = args[command === 'compare-components' ? 1 : 2];
if (!['components', 'smoke', 'pilot', 'dataset', 'sessions', 'compare', 'compare-components'].includes(command)) throw new Error('Expected components | smoke | pilot CAPTURE | dataset EPISODES | sessions SNAPSHOT [ROOT] | compare SNAPSHOT BASE_ROOT CANDIDATE_ROOT | compare-components BASE_ROOT CANDIDATE_ROOT');
const sessionMode = command === 'sessions' || command === 'compare';
const comparison = command === 'compare' || command === 'compare-components';
if (comparison && (!baseRoot || !candidateRoot)) throw new Error('Compare requires both runtime checkouts');
const configOverride = z.object({ model: z.string(), effort: z.enum(['low', 'medium', 'high']), maxTurns: z.number().int().min(1).max(100), timeoutMs: z.number().int().min(1000).max(1800000), sample: z.number().int().min(1).max(100) }).partial().parse(JSON.parse(process.env.REPLAY_CONFIG ?? '{}'));
if (command === 'pilot' && !capturePath) throw new Error('pilot requires a sanitized capture; synthetic results cannot substitute for production');
const capture = capturePath ? JSON.parse(await readFile(capturePath, 'utf8')) : null;
const episodes = sessionMode ? sessionEpisodes(capture, configOverride.sample) : command === 'dataset' ? EpisodeSchema.array().min(1).max(20).parse(capture)
  : command === 'components' || command === 'compare-components' ? fixtures().filter((e) => e.input.kind !== 'task') : command === 'smoke' ? fixtures() : [...productionEpisodes(capture), ...fixtures()];
if (command === 'pilot' && !episodes.some((episode) => episode.cohort === 'production')) throw new Error('No qualifying production cases; inspect capture exclusions');
if (!episodes.length) throw new Error('No complete replayable episodes');
if (episodes.some((episode) => ['task', 'session'].includes(episode.input.kind)) && !process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY for fresh SDK cases');
const sessions = episodes.flatMap((episode) => episode.input.kind === 'session' ? [episode.input] : []);
const maxTurns = sessionMode ? configOverride.maxTurns ?? Math.min(64, Math.max(12, ...sessions.flatMap((session) => session.turns.map((turn) => 2 * turn.tools.length + 8)))) : 4;
const timeoutMs = sessionMode ? configOverride.timeoutMs ?? Math.min(1800000, 120000 + 30000 * Math.max(...sessions.map((session) => session.turns.reduce((n, turn) => n + turn.tools.length, 0)))) : 120000;
const arms: { name: string; input: { name?: string; runtimeRoot?: string; concise?: boolean } }[] = sessionMode || comparison ? [{ name: 'baseline', input: { name: 'baseline', runtimeRoot: resolve(baseRoot ?? '.') } },
  ...(comparison ? [{ name: 'candidate', input: { name: 'candidate', runtimeRoot: resolve(candidateRoot!) } }] : [])]
  : [{ name: 'baseline', input: { concise: false } }, { name: 'concise', input: { concise: true } }];
if (sessionMode || comparison) process.env.REPLAY_ARMS = JSON.stringify(arms);
if (sessionMode) {
  process.env.REPLAY_SESSION_MODE = 'true';
  process.env.REPLAY_MAX_TURNS = String(maxTurns); process.env.REPLAY_TIMEOUT_MS = String(timeoutMs);
}
process.env.REPLAY_MODEL = configOverride.model ?? process.env.REPLAY_MODEL ?? 'haiku';
process.env.REPLAY_EFFORT = configOverride.effort ?? 'low';
const out = resolve('.replay', new Date().toISOString().replaceAll(':', '-'));
await mkdir(out, { recursive: true, mode: 0o700 });
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const files = [...new Set([...tracked, ...(await readdir('tools/replay')).map((name) => `tools/replay/${name}`), 'evalite.config.ts', 'tsconfig.replay.json'])].sort();
const source = Object.fromEntries(await Promise.all(files.map(async (file) => [file, hash(await readFile(file))])));
const runtimeSources = await Promise.all(sessionMode || comparison ? arms.map(async (arm) => {
  const root = arm.input.runtimeRoot!;
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const source = Object.fromEntries(await Promise.all(files.map(async (file) => [file, hash(await readFile(join(root, file)))])));
  return { name: arm.name, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceHash: hash(JSON.stringify(source)), source };
}) : []);
await writeFile(join(out, 'manifest.json'), JSON.stringify({ revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source,
  sourceHash: hash(JSON.stringify(source)), datasetHash: hash(JSON.stringify(episodes)), evaluator: 'required-invariants-v1',
  runtimeSources, config: { model: process.env.REPLAY_MODEL, effort: process.env.REPLAY_EFFORT, serial: true, trials: 1, maxTurns, timeoutMs, sample: configOverride.sample ?? episodes.length, persistence: 'Evalite in-memory; JSON/static artifacts' },
  capture, captureSelection: command === 'pilot' ? { captured: capture.tasks.length, replayEligible: productionEpisodes(capture).length, excluded: capture.tasks.length - productionEpisodes(capture).length } : null,
  limitations: [sessionMode ? 'Recorded direct-MCP session replay: frozen recognized inbound frames, approximate name/key-only tool catalog, exact per-turn recording matches; no live endpoints or historical memory/plugins/files. Slack ingress and current authorization bindings are not reproduced. Generated replies may differ from the context later human inputs assume.'
    : 'CLI text response replay does not reproduce Slack ingress, historical memory, plugins or tool execution.',
    'Component decisions are recorded; their elapsed time is not model latency.', 'Production cases check execution/delivery/recording completeness, not calibrated factuality or usefulness.'],
}, null, 2));
process.env.REPLAY_CORPUS = join(out, 'corpus.json'); process.env.REPLAY_RESULTS = join(out, 'results.jsonl');
await writeFile(process.env.REPLAY_CORPUS, JSON.stringify(episodes));
await writeFile(process.env.REPLAY_RESULTS, '');
process.env.REPLAY_OUT = out;
const runner = spawnSync(process.execPath, ['--import', 'tsx', 'tools/replay/evalite-runner.ts'], { env: process.env, stdio: 'inherit' });
let invalidResults = 0;
const results = (await readFile(process.env.REPLAY_RESULTS, 'utf8')).trim().split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { invalidResults++; return []; }
});
const failed = results.filter((row) => Object.values(row.checks).some((pass) => pass !== true));
const count = episodes.length * arms.length;
const expected = episodes.flatMap((episode) => arms.map((variant) => `${episode.id}:${variant.name}`));
const actual = results.map((row) => `${row.episode.id}:${row.variant}`);
const complete = invalidResults === 0 && new Set(expected).size === count && expected.every((key) => actual.filter((value) => value === key).length === 1) && actual.length === count;
const paired = episodes.map((episode) => ({ id: episode.id, cohort: episode.cohort, arms: Object.fromEntries(results.filter((row) => row.episode.id === episode.id)
  .map((row) => [row.variant, { requiredPass: Object.values(row.checks).every(Boolean), words: row.result.words, elapsedMs: row.result.elapsedMs, firstPostMs: row.result.firstPostMs, sdkUsd: row.result.usage.sdkUsd }])) }));
let reportError: string | null = null;
try {
  reportError = JSON.parse(await readFile(join(out, 'report-status.json'), 'utf8')).error;
  if (reportError !== null && typeof reportError !== 'string') reportError = 'Invalid report status';
} catch { reportError = 'Report status unavailable: runner stopped before export'; }
await writeFile(join(out, 'summary.json'), JSON.stringify({ expectedResults: count, savedResults: results.length, invalidResults, failed: failed.map((row) => ({ id: row.episode.id, variant: row.variant, checks: row.checks })),
  runnerExit: runner.status, runnerSignal: runner.signal, runnerError: runner.error?.message ?? null, reportError, complete, passed: runner.status === 0 && reportError === null && failed.length === 0 && complete, paired, graderUsd: 0, costCoverage: 'SDK reported cost only; unknown remains null. Recorded components made no model calls.' }, null, 2));
logger.system(`Replay saved ${results.length}/${count} results, ${failed.length} failed required gates: ${out}`);
process.exitCode = runner.status !== 0 || reportError !== null || failed.length || !complete ? 1 : 0;
