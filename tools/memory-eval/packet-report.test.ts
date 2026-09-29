import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { syntheticCorpus } from './corpus.js';
import { digest, type Corpus } from './schema.js';
import { reviewInvariantHash } from './report-readiness.js';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));

describe('offline packet report refresh', () => {
  it('updates report readiness from human and label decisions without model calls or ledger writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-packet-report-'));
    try {
      const source = syntheticCorpus();
      const c = structuredClone(source.cases.find((item) => item.id === 'synthetic-decision-correction-1-future')!);
      const h = structuredClone(source.histories.find((item) => item.id === c.historyId)!);
      const corpus: Corpus = { version: 1, cases: [c], histories: [h], provenance: {} };
      const corpusPath = join(root, 'corpus.json');
      const saveCorpus = async () => {
        const content = JSON.stringify(corpus);
        await writeFile(corpusPath, content);
        return digest(content);
      };
      const originalCorpusHash = await saveCorpus();
      const runDir = join(root, 'runs', 'fixture');
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ runId: 'fixture', cases: [c.id],
        corpusHash: originalCorpusHash, reviewInvariantHash: reviewInvariantHash([c], new Map([[h.id, h]])),
        configHash: 'fixture-config', reader: 'offline-reader', extractor: 'offline-extractor' }));
      const verdict = { status: 'advisory', requiredMet: [true], forbiddenAsserted: [false],
        unsupportedClaims: [], contradictedClaims: [], unverifiableClaims: [], abstained: false };
      const results = (['candidate', 'no_memory', 'oracle'] as const).map((arm) =>
        ({ caseId: c.id, arm, status: 'ok', answer: 'October 19', semantic: { ...verdict } }));
      const resultsPath = join(runDir, 'results.json');
      await writeFile(resultsPath, JSON.stringify(results));
      await writeFile(join(runDir, 'fixed-retrieval.json'), JSON.stringify([{ caseId: c.id, status: 'ok' }]));
      const ledgerPath = join(runDir, 'budget.json');
      await writeFile(ledgerPath, '{"committedUsd":0.1234}');
      const ledgerBefore = await readFile(ledgerPath, 'utf8');
      const packet = () => {
        const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'packet', 'fixture'], {
          cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8',
          env: { ...process.env, ARCHIE_EVAL_HOME: root, ARCHIE_EVAL_ENV_FILE: join(root, 'missing.env'), ANTHROPIC_API_KEY: '' },
        });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout;
      };
      const report = async () => JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8'));

      packet();
      expect(await report()).toMatchObject({ status: 'provisional', sourceLabelStatus: 'pending',
        humanCalibrationStatus: 'pending', reviewStatus: 'source_labels_and_calibration_pending', qualityOutcome: 'not_gated' });
      expect((await report()).calibration.pending.every((item: { reason: string }) => item.reason === 'missing or stale human review')).toBe(true);
      expect(await readFile(join(runDir, 'report.md'), 'utf8')).toContain('missing or stale human review');
      const readiness = JSON.parse(await readFile(join(runDir, 'calibration', 'readiness.json'), 'utf8'));
      const verdicts = JSON.parse(await readFile(join(runDir, 'calibration-model-verdicts.json'), 'utf8')) as Array<{ sampleId: string }>;
      const human = { responses: Object.fromEntries(verdicts.map(({ sampleId }) => [sampleId,
        { packetHash: readiness.packetHash, reviewer: 'Fixture reviewer', requiredMet: [true], forbiddenAsserted: [false],
          unsupportedClaims: [], contradictedClaims: [], unverifiableClaims: [], abstained: false, useful: 'yes' }])) };
      const humanPath = join(runDir, 'calibration', 'human-responses.json');
      await writeFile(humanPath, JSON.stringify(human));
      packet();
      expect(await report()).toMatchObject({ status: 'provisional', sourceLabelStatus: 'pending',
        humanCalibrationStatus: 'ready', reviewStatus: 'source_labels_pending', calibration: { reviewReady: true } });

      c.review = 'approved';
      await saveCorpus();
      packet();
      expect(await report()).toMatchObject({ status: 'review_ready', sourceLabelStatus: 'approved',
        humanCalibrationStatus: 'ready', reviewStatus: 'ready', qualityOutcome: 'not_gated' });
      expect(await readFile(join(runDir, 'report.md'), 'utf8')).toContain('- Review: ready; quality outcome not_gated');
      expect(await readFile(humanPath, 'utf8')).toBe(JSON.stringify(human));
      expect((await readdir(join(runDir, 'calibration', 'generated')))).toEqual([readiness.packetHash]);

      results[0].semantic.requiredMet = [false];
      await writeFile(resultsPath, JSON.stringify(results));
      packet();
      expect(await report()).toMatchObject({ status: 'provisional', reviewStatus: 'calibration_pending',
        calibration: { pending: [{ reason: 'unresolved model disagreement' }] } });
      expect(await readFile(join(runDir, 'report.md'), 'utf8')).toContain('unresolved model disagreement');
      results[0].semantic.requiredMet = [true];
      await writeFile(resultsPath, JSON.stringify(results));
      packet();
      expect(await report()).toMatchObject({ status: 'review_ready', reviewStatus: 'ready' });

      results[2].status = 'error';
      await writeFile(resultsPath, JSON.stringify(results));
      packet();
      expect(await report()).toMatchObject({ status: 'incomplete', executionStatus: 'incomplete',
        humanCalibrationStatus: 'blocked_by_incomplete_run', reviewStatus: 'incomplete_run', calibration: { reviewReady: true } });
      results[2].status = 'ok';
      results[2].semantic.status = 'error';
      await writeFile(resultsPath, JSON.stringify(results));
      packet();
      expect(await report()).toMatchObject({ status: 'incomplete', gradingStatus: 'incomplete',
        humanCalibrationStatus: 'blocked_by_incomplete_run', reviewStatus: 'incomplete_run', calibration: { reviewReady: true } });
      c.required = ['different approved outcome'];
      await saveCorpus();
      expect(packet).toThrow();
      expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore);
      expect(await readFile(humanPath, 'utf8')).toBe(JSON.stringify(human));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
