// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

// Execute at the source. Raw transcripts and identity maps never leave this process.
const [from, to, limit = '2', seed = 'archie-replay-v1'] = process.argv.slice(2);
if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from >= to || !/^[1-9]\d*$/.test(limit) || +limit > 10) {
  throw new Error('Usage: capture.mts FROM_ISO TO_ISO [SAMPLE<=10] [SEED]');
}
const root = process.env.ARCHIE_WORKDIR || '/workdir';
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const counts: Record<string, number> = {};
const reject = (reason: string) => { counts[reason] = (counts[reason] ?? 0) + 1; };
const candidates: { id: string; prompt: string; createdAt: string; sourceHash: string; originalWords: number; toolNames: string[] }[] = [];
const allowed = new Set(['mcp__comms-tools__post_to_user', 'mcp__orchestration-tools__report_completion']);
for (const id of readdirSync(join(root, 'sessions')).sort()) {
  if (!/^task-\d{8}-\d{4}-[a-z0-9]+$/.test(id)) continue;
  const path = join(root, 'sessions', id);
  try {
    const rawMeta = readFileSync(join(path, 'shared/metadata.json'), 'utf8');
    const metadata = JSON.parse(rawMeta);
    if (metadata.created_at < from || metadata.created_at >= to) continue;
    reject('in-window');
    if (metadata.status !== 'completed') { reject('unsettled'); continue; }
    const rawEvents = readFileSync(join(path, 'shared/events.jsonl'), 'utf8');
    const events = rawEvents.trim().split('\n').map((line) => JSON.parse(line));
    const inputs = events.filter((e) => e.type === 'message' && e.data?.to === 'pm-agent' && e.data?.from !== 'pm-agent');
    if (inputs.length !== 1 || metadata.triggered_by) { reject('not-single-request'); continue; }
    let prompt: string = inputs[0].data.message;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 6000) {
      reject('invalid-request-text'); continue;
    }
    const claude = join(path, 'claude');
    const transcripts = existsSync(claude) ? (readdirSync(claude, { recursive: true }) as string[])
      .filter((name) => /^[^/]+\/session\/projects\/[^/]+\/.+\.jsonl$/.test(name)) : [];
    if (!transcripts.length) { reject('missing-transcripts'); continue; }
    const session = metadata.agent_sessions?.['pm-agent'];
    const current = transcripts.filter((name) => /^pm\/session\/projects\/[^/]+\/[^/]+\.jsonl$/.test(name) && name.endsWith(`/${session?.session_id}.jsonl`));
    if (session?.active !== false || typeof session.session_id !== 'string' || current.length !== 1) { reject('missing-current-session'); continue; }
    const rawTranscripts = transcripts.map((name) => readFileSync(join(claude, name), 'utf8'));
    const records = rawTranscripts.map((text) => text.trim().split('\n').map((line) => JSON.parse(line)));
    const main = records[transcripts.indexOf(current[0])];
    const requestIndex = main.findIndex((entry) => entry.type === 'user' && entry.sessionId === session.session_id
      && (typeof entry.message?.content === 'string' ? entry.message.content : (entry.message?.content ?? [])
        .filter((block: { type?: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('\n')).includes(prompt));
    if (requestIndex < 0 || !main.slice(requestIndex + 1).some((entry) => entry.type === 'assistant' && entry.sessionId === session.session_id && entry.message?.stop_reason === 'end_turn')
      || !events.slice(events.indexOf(inputs[0]) + 1).some((event) => event.type === 'task:completed')) {
      reject('incomplete-current-session'); continue;
    }
    const blocks = records.flat().flatMap((entry) => Array.isArray(entry.message?.content) ? entry.message.content : []);
    const tools = new Set<string>(blocks.filter((block) => block.type === 'tool_use').map((block) => block.name));
    if (![...tools].some((name) => allowed.has(name)) || [...tools].some((name) => !allowed.has(name) && name !== 'ToolSearch')) {
      reject('needs-external-state-or-tools'); continue;
    }
    // Discovery is neutral only when every recorded result exposes exclusively local reply tools.
    const discoveryComplete = blocks.filter((block) => block.type === 'tool_use' && block.name === 'ToolSearch').every((search) => {
      const matches = blocks.filter((block) => block.type === 'tool_result' && block.tool_use_id === search.id);
      return typeof search.id === 'string' && matches.length === 1 && !matches[0].is_error
        && Array.isArray(matches[0].content) && matches[0].content.length > 0
        && matches[0].content.every((block: { type?: string; tool_name?: string }) => block.type === 'tool_reference' && allowed.has(block.tool_name ?? ''));
    });
    if (!discoveryComplete) { reject('unproven-local-discovery'); continue; }
    if (/sk-ant-|xox[baprs]-|BEGIN .*PRIVATE KEY|(?:password|secret|api[_ -]?key)\s*[:=]/i.test(prompt)) { reject('secret-pattern'); continue; }
    const identities = new Set<string>([...Object.values(metadata.memory_authors ?? {}) as string[], inputs[0].data.from]);
    for (const value of [...identities].filter((v) => v.length > 2).sort((a, b) => b.length - a.length)) {
      prompt = prompt.replaceAll(value, `PERSON_${hash(seed + value).slice(0, 8)}`);
    }
    prompt = prompt.replace(/<@([UW][A-Z0-9]{7,})(?:[:|][^>]*)?>/g, (_value, id) => `ID_${hash(seed + id).slice(0, 8)}`)
      .replace(/https?:\/\/[^\s<>"`]+/g, (value) => `LINK_${hash(seed + value).slice(0, 8)}`)
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, (value) => `EMAIL_${hash(seed + value).slice(0, 8)}`)
      .replace(/\b[UCDTW][A-Z0-9]{7,}\b/g, (value) => `ID_${hash(seed + value).slice(0, 8)}`);
    const originalWords = events.filter((e) => e.type === 'message' && e.data?.from === 'pm-agent' && e.data?.to === 'user')
      .reduce((n, e) => n + (String(e.data.message).match(/\S+/g)?.length ?? 0), 0);
    if (readFileSync(join(path, 'shared/metadata.json'), 'utf8') !== rawMeta) { reject('changed-during-capture'); continue; }
    candidates.push({ id: `production-${hash(seed + id).slice(0, 12)}`, prompt, createdAt: metadata.created_at,
      sourceHash: hash(rawMeta + rawEvents + rawTranscripts.join('')), originalWords, toolNames: [...tools].sort() });
  } catch { reject('unreadable-or-malformed'); }
}
let initiative: { present: boolean; sha256?: string; tables?: Record<string, number> } = { present: false };
const dbPath = join(root, 'initiative/state.sqlite');
if (existsSync(dbPath)) {
  const scratch = await mkdtemp(join(tmpdir(), 'archie-capture-'));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const target = join(scratch, 'state.sqlite');
    await backup(db, target);
    const snapshot = new DatabaseSync(target, { readOnly: true });
    try {
      const tables: Record<string, number> = {};
      for (const { name } of snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
        if (/^[a-z_]+$/.test(name)) tables[name] = Number(snapshot.prepare(`SELECT count(*) AS n FROM "${name}"`).get()!.n);
      }
      initiative = { present: true, sha256: hash(readFileSync(target)), tables };
    } finally { snapshot.close(); }
  } finally { db.close(); await rm(scratch, { recursive: true, force: true }); }
}
candidates.sort((a, b) => hash(seed + a.id).localeCompare(hash(seed + b.id)));
process.stdout.write(JSON.stringify({ schema: 'archie-capture/v1', sanitizer: 'identifiers-v1', capturedAt: new Date().toISOString(),
  from, to, seed, sourceRevision: process.env.GIT_SHA ?? null, inventory: { counts, eligible: candidates.length, selected: Math.min(+limit, candidates.length) },
  tasks: candidates.slice(0, +limit), initiative,
  gaps: ['Single-request local-reply histories only; capture does not establish standalone replay eligibility or production accuracy.', 'No historical memory snapshot or production plugin context.', 'Identity-pattern sanitization does not classify every possible personal reference.'],
}));
