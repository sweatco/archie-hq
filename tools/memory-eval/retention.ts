import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEntity } from '../../src/memory/entities.js';
import type { History } from './schema.js';

export type RetentionSnapshot = { targetObserved: boolean; observationCount: number; canonicalPresent: boolean };

async function optionalFile(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

export async function retentionSnapshot(history: History, workdir: string): Promise<RetentionSnapshot | null> {
  const check = history.retentionCheck;
  if (!check) return null;
  const entity = parseEntity(await optionalFile(join(workdir, 'memory', 'public', 'entities', `${check.entitySlug}.md`)));
  const canonical = await optionalFile(join(workdir, 'memory', 'public', history.scope.channelId, `${check.initialTaskId}.md`));
  return { targetObserved: !!entity?.observations.some((observation) => observation.text.includes(check.observationNeedle)),
    observationCount: entity?.observations.length ?? 0, canonicalPresent: canonical.includes(check.canonicalNeedle) };
}

export function retentionPrecondition(receipts: Array<{ retention?: RetentionSnapshot | null }>): { met: boolean; reason: string } {
  const states = receipts.map((receipt) => receipt.retention).filter((state): state is RetentionSnapshot => !!state);
  const final = states.at(-1);
  if (!final) return { met: false, reason: 'no retention trace' };
  if (!states.slice(0, -1).some((state) => state.targetObserved)) return { met: false, reason: 'target observation was never seen in an earlier checkpoint' };
  if (final.targetObserved) return { met: false, reason: 'target observation was not evicted' };
  if (final.observationCount < 30) return { met: false, reason: 'entity did not reach the 30-observation retention limit' };
  if (!final.canonicalPresent) return { met: false, reason: 'original fact is absent from the canonical task summary' };
  return { met: true, reason: 'observed then evicted from entity; canonical task summary retained the fact' };
}
