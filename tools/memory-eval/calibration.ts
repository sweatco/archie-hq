import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Case, History } from './schema.js';
import { oracleFor, readerExecution, type ToolTrace, type Verdict } from './judgment.js';

type Result = { caseId?: string; arm?: string; status?: string; answer?: string; injection?: string;
  toolCalls?: number; toolTurns?: number; modelTurns?: number; toolTrace?: ToolTrace[]; semantic?: Verdict };
type HumanResponse = { packetHash?: string; reviewer?: string; requiredMet?: boolean[]; forbiddenAsserted?: boolean[];
  unsupportedClaims?: string[]; contradictedClaims?: string[]; unverifiableClaims?: string[];
  abstained?: boolean; useful?: 'yes' | 'no' | 'unclear'; disagreementResolution?: string };

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rubricVersion = 'reader-execution-and-original-evidence-v1';

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
}

async function writeOnce(path: string, value: unknown): Promise<void> {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== content) throw new Error(`immutable calibration artifact changed: ${path}`);
  }
}

export async function writeCalibrationPacket(reportPath: string, cases: Case[], histories: Map<string, History>,
  rows: Result[], evidenceFor: (c: Case, h: History) => string): Promise<{ packetHash: string; pending: number }> {
  const selected = cases.flatMap((c) => ['candidate', 'no_memory', 'oracle'].filter((arm) =>
    arm !== 'oracle' || c.source === 'longmemeval' || c.ability.includes('scope'))
    .map((arm) => ({ c, arm: arm as 'candidate' | 'no_memory' | 'oracle', row: rows.find((r) => r.caseId === c.id && r.arm === arm) })))
    .filter(({ row }) => row?.status === 'ok');
  const evidence = Object.fromEntries([...new Set(selected.map(({ c }) => c.id))].map((id) => {
    const c = cases.find((item) => item.id === id)!;
    return [id, evidenceFor(c, histories.get(c.historyId)!)];
  }));
  const samples = selected.map(({ c, arm, row }) => {
    const sampleId = `sample-${hash([c.id, arm]).slice(0, 12)}`;
    return { sampleId, caseId: c.id, source: c.source, workload: c.workload, ability: c.ability,
      currentTask: { context: c.currentContext, question: c.question, queryAt: c.queryAt,
        requester: c.requester, declaredAudience: c.audience },
      requiredClaims: c.required, forbiddenClaims: c.forbidden, answer: row!.answer ?? '',
      readerExecution: readerExecution(arm, row!, arm === 'oracle' ? oracleFor(c, histories.get(c.historyId)!) : ''),
      originalEvidencePath: `evidence/${c.id}.jsonl` };
  });
  const packetHash = hash({ rubricVersion, samples, evidence });
  const calibrationDir = join(reportPath, 'calibration');
  const generatedDir = join(calibrationDir, 'generated', packetHash);
  await mkdir(join(generatedDir, 'evidence'), { recursive: true, mode: 0o700 });
  await mkdir(join(generatedDir, 'samples'), { recursive: true, mode: 0o700 });
  for (const [id, content] of Object.entries(evidence)) await writeOnce(join(generatedDir, 'evidence', `${id}.jsonl`), content);
  for (const sample of samples) await writeOnce(join(generatedDir, 'samples', `${sample.sampleId}.json`), sample);
  await writeOnce(join(generatedDir, 'index.md'), [
    '# Independent answer calibration', '', `Packet: ${packetHash}`, `Rubric: ${rubricVersion}`, '',
    'Read each sample JSON and its referenced original evidence before opening calibration-model-verdicts.json.',
    'Original evidence is stored once per case. Reader execution records only what the evaluated reader received and did.',
    'Record human decisions in calibration/human-responses.json using the sample ID and this packet hash.', '',
    ...samples.map((sample) => `- ${sample.sampleId}: samples/${sample.sampleId}.json; evidence/${sample.caseId}.jsonl`), '',
  ].join('\n'));
  const old = await readJson<{ packetHash?: string }>(join(calibrationDir, 'packet-manifest.json'), {});
  await writePrivate(join(calibrationDir, 'packet-manifest.json'), { packetHash, previousPacketHash: old.packetHash !== packetHash ? old.packetHash ?? null : null,
    rubricVersion, sampleCount: samples.length });
  await writePrivate(join(reportPath, 'calibration-model-verdicts.json'), selected.map(({ c, arm, row }, index) =>
    ({ sampleId: samples[index].sampleId, caseId: c.id, arm, modelVerdict: row!.semantic })));
  const humanPath = join(calibrationDir, 'human-responses.json');
  try { await writeFile(humanPath, JSON.stringify({ instructions: 'Fill responses by sample ID. Keep packetHash equal to the packet reviewed. Resolve every model disagreement in disagreementResolution.', responses: {} }, null, 2),
    { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const human = await readJson<{ responses?: Record<string, HumanResponse> }>(humanPath, {});
  const verdicts = selected.map(({ row }) => row!.semantic);
  const pending: Array<{ sampleId: string; reason: string }> = [];
  for (const [index, sample] of samples.entries()) {
    const response = human.responses?.[sample.sampleId];
    if (!response || response.packetHash !== packetHash) { pending.push({ sampleId: sample.sampleId, reason: 'missing or stale human review' }); continue; }
    if (!response.reviewer || response.requiredMet?.length !== sample.requiredClaims.length
      || !response.requiredMet.every((x) => typeof x === 'boolean')
      || response.forbiddenAsserted?.length !== sample.forbiddenClaims.length
      || !response.forbiddenAsserted.every((x) => typeof x === 'boolean')
      || !Array.isArray(response.unsupportedClaims) || !Array.isArray(response.contradictedClaims)
      || !Array.isArray(response.unverifiableClaims) || typeof response.abstained !== 'boolean'
      || !['yes', 'no', 'unclear'].includes(response.useful ?? '')) {
      pending.push({ sampleId: sample.sampleId, reason: 'incomplete human review' }); continue;
    }
    const verdict = verdicts[index];
    const disagreement = verdict?.status === 'advisory' && ['requiredMet', 'forbiddenAsserted', 'unsupportedClaims',
      'contradictedClaims', 'unverifiableClaims', 'abstained'].some((key) =>
      JSON.stringify(response[key as keyof HumanResponse]) !== JSON.stringify(verdict[key as keyof Verdict]));
    if (disagreement && !response.disagreementResolution?.trim()) pending.push({ sampleId: sample.sampleId, reason: 'unresolved model disagreement' });
  }
  await writePrivate(join(calibrationDir, 'readiness.json'), { packetHash, reviewReady: pending.length === 0 && samples.length > 0,
    reviewed: samples.length - pending.length, total: samples.length, pending });
  return { packetHash, pending: pending.length };
}
