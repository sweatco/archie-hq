// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile, appendFile } from 'node:fs/promises';
import { evalite } from 'evalite';
import { reportTrace } from 'evalite/traces';
import { replay } from './adapter.js';
import { checks, type Episode } from './types.js';
import { createKeyedLock } from '../../src/system/keyed-lock.js';

const serial = createKeyedLock();
const arms: { name: string; input: { name?: string; concise?: boolean; runtimeRoot?: string } }[] = process.env.REPLAY_ARMS ? JSON.parse(process.env.REPLAY_ARMS) : [{ name: 'baseline', input: { concise: false } }, { name: 'concise', input: { concise: true } }];

evalite.each(arms)('Archie replay pilot', {
  data: async () => (JSON.parse(await readFile(process.env.REPLAY_CORPUS!, 'utf8')) as Episode[]).map((episode) => ({ input: episode, expected: episode.expected })),
  // Evalite runs variant suites concurrently even with maxConcurrency=1.
  task: (episode, variant) => serial('replay', async () => {
    const startMs = Date.now();
    const result = await replay(episode, { ...variant, model: process.env.REPLAY_MODEL, effort: process.env.REPLAY_EFFORT,
      ...(process.env.REPLAY_SESSION_MODE ? { maxTurns: Number(process.env.REPLAY_MAX_TURNS), timeoutMs: Number(process.env.REPLAY_TIMEOUT_MS) } : {}) });
    const end = performance.now();
    reportTrace({ input: episode.input, output: result, start: end - result.elapsedMs, end });
    await appendFile(process.env.REPLAY_RESULTS!, JSON.stringify({ variant: variant.name ?? (variant.concise ? 'concise' : 'baseline'), episode, result, checks: checks(episode, result), window: { startMs, endMs: Date.now() } }) + '\n');
    return result;
  }),
  scorers: ['execution', 'required-facts', 'access', 'delivery', ...(process.env.REPLAY_SESSION_MODE ? ['recordings'] : [])].map((name) => ({ name,
    scorer: ({ input, output }: { input: Episode; output: Awaited<ReturnType<typeof replay>> }) => checks(input, output)[name] ? 1 : 0,
  })),
  columns: ({ output }) => [
    { label: 'Mode', value: output.mode }, { label: 'Words', value: output.words },
    { label: 'Agent ms', value: output.elapsedMs }, { label: 'SDK USD', value: output.usage.sdkUsd ?? 'unknown' },
  ],
});
