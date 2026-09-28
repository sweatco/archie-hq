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
      expect(first.pending).toMatchObject([{ reason: 'missing or stale human review' }]);
      await writeFile(join(path, 'calibration-review.md'), 'human notes in legacy packet');
      await writeFile(join(path, 'calibration-disagreements.md'), 'resolved legacy disagreement');
      const sampleId = JSON.parse(await readFile(join(path, 'calibration-model-verdicts.json'), 'utf8'))[0].sampleId as string;
      const humanPath = join(path, 'calibration', 'human-responses.json');
      await writeFile(humanPath, JSON.stringify({ responses: { [sampleId]: { packetHash: first.packetHash, reviewer: 'Human A' } } }));
      expect((await writeCalibrationPacket(path, [c], histories, rows, evidence)).pending)
        .toMatchObject([{ reason: 'incomplete human review' }]);
      const human = { responses: { [sampleId]: { packetHash: first.packetHash, reviewer: 'Human A',
        requiredMet: [true], forbiddenAsserted: [false], unsupportedClaims: [], contradictedClaims: [],
        unverifiableClaims: [], abstained: false, useful: 'yes' } } };
      await writeFile(humanPath, JSON.stringify(human));
      expect((await writeCalibrationPacket(path, [c], histories, rows, evidence)).reviewReady).toBe(true);
      rows[0].semantic.requiredMet = [false];
      const repaired = await writeCalibrationPacket(path, [c], histories, rows, evidence);
      expect(repaired.packetHash).toBe(first.packetHash);
      expect(await readFile(humanPath, 'utf8')).toBe(JSON.stringify(human));
      expect(await readFile(join(path, 'calibration-review.md'), 'utf8')).toBe('human notes in legacy packet');
      expect(await readFile(join(path, 'calibration-disagreements.md'), 'utf8')).toBe('resolved legacy disagreement');
      expect(repaired.pending).toMatchObject([{ reason: 'unresolved model disagreement' }]);
      const resolved = { responses: { [sampleId]: { ...human.responses[sampleId],
        disagreementResolution: 'Original evidence supports the human decision.' } } };
      await writeFile(humanPath, JSON.stringify(resolved));
      expect((await writeCalibrationPacket(path, [c], histories, rows, evidence)).reviewReady).toBe(true);
      const changed = await writeCalibrationPacket(path, [c], histories, rows, () => 'changed original evidence');
      expect(changed.packetHash).not.toBe(first.packetHash);
      expect(changed.pending).toMatchObject([{ reason: 'missing or stale human review' }]);
      expect(await readFile(humanPath, 'utf8')).toBe(JSON.stringify(resolved));
      expect(JSON.parse(await readFile(join(path, 'calibration', 'packet-manifest.json'), 'utf8')).previousPacketHash).toBe(first.packetHash);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
});
