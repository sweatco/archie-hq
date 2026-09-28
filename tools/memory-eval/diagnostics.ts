import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Case, History } from './schema.js';
import { permittedEvidence } from './schema.js';

const STOP = new Set('the a an and or of to in for from on at is are was were it this that with by i we you they our your their did what who when where how can does do no not as'.split(' '));

export function lexicalOverlap(source: string, observed: string): number {
  const tokens = [...new Set(source.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [])].filter((token) => token.length > 2 && !STOP.has(token));
  if (!tokens.length) return 0;
  const lower = observed.toLowerCase();
  return tokens.filter((token) => lower.includes(token)).length / tokens.length;
}

export function evidenceDiagnosis(c: Case, h: History, output: string) {
  const expected = permittedEvidence(c, h);
  const rows = expected.map((event) => ({ taskId: event.taskId ?? null, sourceRef: event.source.ref,
    referenceSurfaced: !!event.taskId && output.includes(event.taskId),
    lexicalOverlap: lexicalOverlap(event.text, output) }));
  const leakMarkers = c.ability.startsWith('scope') ? c.forbidden.filter((claim) => claim.length >= 4 && output.toLowerCase().includes(claim.toLowerCase())) : [];
  return { expectedEvidence: rows.length, referenceSurfaced: rows.filter((row) => row.referenceSurfaced).length,
    factualOverlapAtHalf: rows.filter((row) => row.lexicalOverlap >= 0.5).length, rows, leakMarkers };
}

export async function retainedEvidence(c: Case, h: History, workdir: string) {
  const events = permittedEvidence(c, h);
  const rows: Array<{ taskId: string | null; sourceRef: string; canonicalPresent: boolean; lexicalOverlap: number }> = [];
  for (const event of events) {
    const audience = event.audience ?? h.scope;
    if (!event.taskId) { rows.push({ taskId: null, sourceRef: event.source.ref, canonicalPresent: false, lexicalOverlap: 0 }); continue; }
    const visibility = audience.kind === 'public' ? 'public' : 'private';
    const path = join(workdir, 'memory', visibility, audience.channelId, `${event.taskId}.md`);
    let content = '';
    try { content = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    rows.push({ taskId: event.taskId, sourceRef: event.source.ref, canonicalPresent: !!content,
      lexicalOverlap: lexicalOverlap(event.text, content) });
  }
  return { expectedEvidence: rows.length, canonicalPresent: rows.filter((row) => row.canonicalPresent).length,
    factualOverlapAtHalf: rows.filter((row) => row.lexicalOverlap >= 0.5).length, rows };
}
