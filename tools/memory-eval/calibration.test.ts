import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syntheticCorpus } from './corpus.js';
import { writeCalibrationPacket } from './calibration.js';

describe('calibration packet', () => {
  it('preserves human decisions across grade repair and invalidates changed evidence', async () => {
    const path = await mkdtemp(join(tmpdir(), 'memory-calibration-'));
    try {
      const corpus = syntheticCorpus();
      const c = corpus.cases.find((item) => item.id === 'synthetic-scope-3-future')!;
      const h = corpus.histories.find((item) => item.id === c.historyId)!;
      const histories = new Map([[h.id, h]]);
      const rows = [{ caseId: c.id, arm: 'candidate', status: 'ok', answer: 'The answer is unknown.',
        toolCalls: 1, toolTrace: [{ name: 'search_memory', input: { query: 'quote' }, output: 'no result' }],
        semantic: { status: 'advisory', requiredMet: [true], forbiddenAsserted: [false],
          unsupportedClaims: [], contradictedClaims: [], unverifiableClaims: [], abstained: false } }];
      const evidence = () => 'original evidence';
      const first = await writeCalibrationPacket(path, [c], histories, rows, evidence);
      await writeFile(join(path, 'calibration-review.md'), 'human notes in legacy packet');
      await writeFile(join(path, 'calibration-disagreements.md'), 'resolved legacy disagreement');
      const sampleId = JSON.parse(await readFile(join(path, 'calibration-model-verdicts.json'), 'utf8'))[0].sampleId as string;
      const humanPath = join(path, 'calibration', 'human-responses.json');
      const human = { responses: { [sampleId]: { packetHash: first.packetHash, reviewer: 'Human A',
        requiredMet: [true], forbiddenAsserted: [false], unsupportedClaims: [], contradictedClaims: [],
        unverifiableClaims: [], abstained: false, useful: 'yes' } } };
      await writeFile(humanPath, JSON.stringify(human));
      rows[0].semantic.requiredMet = [false];
      const repaired = await writeCalibrationPacket(path, [c], histories, rows, evidence);
      expect(repaired.packetHash).toBe(first.packetHash);
      expect(await readFile(humanPath, 'utf8')).toBe(JSON.stringify(human));
      expect(await readFile(join(path, 'calibration-review.md'), 'utf8')).toBe('human notes in legacy packet');
      expect(await readFile(join(path, 'calibration-disagreements.md'), 'utf8')).toBe('resolved legacy disagreement');
      expect(repaired.pending).toBe(1);
      const changed = await writeCalibrationPacket(path, [c], histories, rows, () => 'changed original evidence');
      expect(changed.packetHash).not.toBe(first.packetHash);
      expect(changed.pending).toBe(1);
      expect(await readFile(humanPath, 'utf8')).toBe(JSON.stringify(human));
      expect(JSON.parse(await readFile(join(path, 'calibration', 'packet-manifest.json'), 'utf8')).previousPacketHash).toBe(first.packetHash);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
});
