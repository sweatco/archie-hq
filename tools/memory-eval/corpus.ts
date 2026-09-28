import { createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Case, Corpus, Event, History, Span } from './schema.js';
import { digest, splitForFamily } from './schema.js';

const LOG_HEADER = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)\] \[([^\]]+)\](?: \[([^\]]+)\])? /gm;
type RawRecord = { at: string; source: string; kind?: string; text: string; start: number; end: number };

export function parseKnowledgeLog(log: string): RawRecord[] {
  const matches = [...log.matchAll(LOG_HEADER)];
  return matches.map((match, i) => {
    const start = match.index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : log.length;
    return { at: match[1], source: match[2], kind: match[3], text: log.slice(start + match[0].length, end).trimEnd(), start, end };
  });
}

async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }

export async function inventory(root: string) {
  const sessionRoot = join(root, 'sessions');
  const names = (await readdir(sessionRoot)).filter((n) => n.startsWith('task-'));
  const counts = { tasks: names.length, completed: 0, stopped: 0, logs: 0, completions: 0, noDestination: 0 };
  for (const name of names) {
    const dir = join(sessionRoot, name, 'shared');
    try {
      const meta = await json<{ status?: string; memory_destination?: unknown }>(join(dir, 'metadata.json'));
      if (meta.status === 'completed') counts.completed++;
      if (meta.status === 'stopped') counts.stopped++;
      if (!meta.memory_destination) counts.noDestination++;
      const log = await readFile(join(dir, 'knowledge.log'), 'utf8');
      counts.logs++;
      const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n');
      counts.completions += events.filter((line) => { try { return JSON.parse(line).type === 'task:completed'; } catch { return false; } }).length;
      if (log && parseKnowledgeLog(log).length === 0) throw new Error(`unparseable log ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return counts;
}

class Pseudonyms {
  private map = new Map<string, string>();
  constructor(private key: Buffer) {}
  get(raw: string, prefix: string, suffix = ''): string {
    const existing = this.map.get(raw);
    if (existing) return existing;
    const alias = `${prefix}${createHmac('sha256', this.key).update(raw).digest('hex').slice(0, 10).toUpperCase()}${suffix}`;
    this.map.set(raw, alias);
    return alias;
  }
  replace(s: string): string {
    for (const [raw, alias] of [...this.map].sort((a, b) => b[0].length - a[0].length)) s = s.split(raw).join(alias);
    return s;
  }
  mapping(): Record<string, string> { return Object.fromEntries(this.map); }
}

const REAL_FAMILIES: Array<{ name: string; workload: string; tasks: string[] }> = [
  { name: 'ops-publish', workload: 'operations', tasks: ['task-20260921-1500-wkw2r6', 'task-20260922-1500-r6i4kx', 'task-20260923-1500-i47b2m', 'task-20260924-1500-fayq29', 'task-20260925-1500-vfvfke'] },
  { name: 'ops-scheduling', workload: 'operations', tasks: ['task-20260924-1200-5m5k0u', 'task-20260925-1200-xw3vkv'] },
  { name: 'ops-offer', workload: 'operations', tasks: ['task-20260925-0840-tvy9vw', 'task-20260925-1229-u4fipc'] },
  { name: 'ops-approval', workload: 'operations', tasks: ['task-20260921-1200-l8hnbv', 'task-20260922-1200-ytxhz7', 'task-20260923-1200-z0eapq'] },
  { name: 'marketing-campaign', workload: 'marketing', tasks: ['task-20260921-1204-mw5zc6', 'task-20260921-1615-y8uw6o', 'task-20260923-1552-w102wj'] },
  { name: 'marketing-analytics', workload: 'marketing', tasks: ['task-20260923-0900-fj4ml1', 'task-20260924-0957-gxr4vo', 'task-20260925-1141-f734x6'] },
  { name: 'engineering-release', workload: 'engineering', tasks: ['task-20260925-0928-ee59pb', 'task-20260925-1153-bu0uz8'] },
  { name: 'product-copy', workload: 'product', tasks: ['task-20260922-1132-gxx0ix', 'task-20260924-0952-kwk6f8', 'task-20260924-1429-y14i4l'] },
];

export async function draftArchie(root: string, out: string): Promise<{ histories: History[]; cases: Case[] }> {
  await mkdir(out, { recursive: true, mode: 0o700 });
  const keyPath = join(out, 'pseudonym-key');
  let key: Buffer;
  try { key = await readFile(keyPath); } catch { key = randomBytes(32); await writeFile(keyPath, key, { mode: 0o600, flag: 'wx' }); }
  const pseudo = new Pseudonyms(key);
  const histories: History[] = [];
  const cases: Case[] = [];
  for (const group of REAL_FAMILIES) {
    const rawEvents: Event[] = [];
    const completions: History['completions'] = [];
    let channelId = '';
    const kind: History['scope']['kind'] = 'none';
    for (const taskId of group.tasks) {
      const dir = join(root, 'sessions', taskId, 'shared');
      const meta = await json<{ memory_destination?: { channel_id: string }; memory_authors?: Record<string, string>; memory_message_authors?: Record<string, string>; channels?: Record<string, { type?: string }> }>(join(dir, 'metadata.json'));
      const currentChannel = meta.memory_destination?.channel_id;
      if (!currentChannel) throw new Error(`${taskId} lacks recorded memory destination`);
      if (!channelId) channelId = currentChannel;
      const audience: Event['audience'] = { kind: 'none', channelId: currentChannel, authorization: 'unknown' };
      for (const [id, name] of Object.entries(meta.memory_authors ?? {})) {
        pseudo.get(id, 'U'); pseudo.get(name, 'Person-');
      }
      pseudo.get(currentChannel, currentChannel[0]);
      const log = await readFile(join(dir, 'knowledge.log'), 'utf8');
      for (const id of log.match(/\b[UWBCDG][A-Z0-9]{8,}\b/g) ?? []) pseudo.get(id, id[0]);
      for (const email of log.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) {
        pseudo.get(email, 'email-', '@example.invalid');
      }
      for (const match of log.matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+){1,2})\s*\/\s*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) pseudo.get(match[1], 'Person-');
      const records = parseKnowledgeLog(log);
      for (const record of records) {
        const role = record.source.includes('<@') || record.source === 'cli' ? 'user' : record.source.includes('agent') ? 'assistant' : 'system';
        const messageTs = record.source.match(/\bmsg:(\d+\.\d+)\b/)?.[1];
        const declaredId = record.source.match(/<@([UW][A-Z0-9]+):/)?.[1];
        const authorId = messageTs && declaredId && meta.memory_message_authors?.[messageTs] === declaredId ? declaredId : undefined;
        const authorName = authorId ? meta.memory_authors?.[authorId] : undefined;
        const ref = `${taskId}/knowledge.log`;
        const span: Span = { ref, start: record.start, end: record.end, quote: record.text.slice(0, 240) };
        rawEvents.push({ at: record.at, role, text: record.text, source: span, taskId, authorId, authorName, messageTs, audience });
      }
      const eventLines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n');
      for (const line of eventLines) {
        if (!line.trim()) continue;
        try { const event = JSON.parse(line) as { type: string; timestamp: string }; if (event.type === 'task:completed') completions.push({ at: event.timestamp, taskId, audience }); } catch { /* invalid line is excluded */ }
      }
    }
    rawEvents.sort((a, b) => a.at.localeCompare(b.at) || a.source.ref.localeCompare(b.source.ref) || a.source.start - b.source.start);
    completions.sort((a, b) => a.at.localeCompare(b.at));
    const historyId = `archie-${group.name}`;
    const history: History = { id: historyId, family: historyId, source: 'archie', workload: group.workload,
      scope: { kind, channelId, authorization: 'unknown', authorIds: [] }, events: rawEvents, completions };
    const users = rawEvents.filter((e) => e.role === 'user');
    if (users.length === 0 || completions.length === 0) throw new Error(`${group.name} has no user evidence/completion`);
    const selected = [...new Map(users.map((e) => [e.source.ref, e])).values()].slice(0, 4);
    while (selected.length < 4) selected.push(users[Math.min(selected.length, users.length - 1)]);
    for (let i = 0; i < 4; i++) {
      const evidence = selected[i];
      const queryAt = completions.find((item) => item.at > evidence.at)?.at ?? new Date(Date.parse(rawEvents.at(-1)!.at) + 1000).toISOString();
      cases.push({ id: `${historyId}-${i + 1}`, family: historyId, source: 'archie', workload: group.workload,
        ability: i === 0 ? 'instruction' : i === 1 ? 'update' : i === 2 ? 'uncertainty' : 'multi-session',
        split: splitForFamily(historyId), historyId, queryAt, requester: evidence.authorId ?? 'unknown',
        audience: { kind, channelId: evidence.audience?.channelId ?? channelId, authorization: 'unknown' }, currentContext: 'Answer from prior task history only. State uncertainty.',
        question: `What did the requester specify in the ${group.name} work before ${queryAt}?`,
        required: [], forbidden: [], evidence: [evidence.source], review: 'quarantined',
        reason: 'Historical Slack authorization is not in the archive; verify channel properties and requester access before replay.' });
    }
    const nextTask = {
      operations: 'Prepare the next operational handoff with a concrete plan that follows earlier requester instructions.',
      marketing: 'Prepare the next campaign brief with a concrete plan that follows earlier requester instructions.',
      engineering: 'Prepare the next release checklist with a concrete plan that follows earlier requester instructions.',
      product: 'Prepare the next product copy revision with a concrete plan that follows earlier requester instructions.',
    }[group.workload]!;
    cases.push({ id: `${historyId}-future`, family: historyId, source: 'archie', workload: group.workload,
      ability: 'future-task-plan', taskKind: 'future_task', split: splitForFamily(historyId), historyId,
      queryAt: new Date(Date.parse(completions.at(-1)!.at) + 60_000).toISOString(), requester: selected[0].authorId ?? 'unknown',
      audience: { kind: 'none', channelId: selected[0].audience?.channelId ?? channelId, authorization: 'unknown' },
      currentContext: nextTask,
      question: 'What would you do for this new task, using relevant prior instructions without assuming unconfirmed decisions are approved?',
      required: [], forbidden: [], evidence: [selected[0].source], review: 'quarantined',
      reason: 'Future-task plan draft. Original user evidence is cited; historical authorization and task-specific claims require human review.' });
    histories.push(history);
  }
  // Replace identifiers and recorded author names only after all mappings are known.
  for (const history of histories) {
    history.scope.channelId = pseudo.replace(history.scope.channelId);
    history.scope.authorIds = history.scope.authorIds.map((x) => pseudo.replace(x));
    history.completions.forEach((completion) => { if (completion.audience) completion.audience.channelId = pseudo.replace(completion.audience.channelId); });
    for (const event of history.events) {
      event.text = pseudo.replace(event.text);
      event.source.quote = event.text.slice(0, 240);
      if (event.authorId) event.authorId = pseudo.replace(event.authorId);
      if (event.authorName) event.authorName = pseudo.replace(event.authorName);
      if (event.audience) event.audience.channelId = pseudo.replace(event.audience.channelId);
    }
  }
  for (const c of cases) {
    c.requester = pseudo.replace(c.requester); c.audience.channelId = pseudo.replace(c.audience.channelId);
    c.evidence = c.evidence.map((s) => histories.find((h) => h.id === c.historyId)!.events.find((e) => e.source.ref === s.ref && e.source.start === s.start)!.source);
  }
  await writeFile(join(out, 'pseudonym-map.json'), JSON.stringify(pseudo.mapping(), null, 2), { mode: 0o600 });
  return { histories, cases };
}

export function syntheticCorpus(): { histories: History[]; cases: Case[] } {
  const families = [
    { name: 'updates', fact: 'The approved launch date is October 12.', newer: 'The approved launch date is October 19.', question: 'What is the current approved launch date?', answer: 'October 19', forbidden: 'October 12' },
    { name: 'decision-correction', fact: 'The approved launch date is October 12.', newer: 'The approved launch date is October 19.', question: 'What is the current approved launch date?', answer: 'October 19', forbidden: 'October 12' },
    { name: 'attribution', fact: 'I prefer a short weekly summary.', newer: 'A colleague proposed daily reports and quoted Mira as preferring daily; Mira did not approve that.', question: 'What cadence did Mira request?', answer: 'weekly', forbidden: 'daily' },
    { name: 'scope', fact: 'In private channel GTESTCHAN01, the renewal ceiling is 40 units.', newer: 'Public notes mention renewal timing but no ceiling.', question: 'What ceiling can this audience access?', answer: '40 units', forbidden: 'a private ceiling from another channel' },
    { name: 'uncertainty', fact: 'The team proposed a 24-hour lead time.', newer: 'The proposal still awaits approval.', question: 'Was the 24-hour lead time approved?', answer: 'No; it remains a proposal', forbidden: 'approved' },
    { name: 'irrelevance', fact: 'The package owner is Team Atlas.', newer: 'The colour palette is teal; unrelated launch details follow.', question: 'Who owns the package?', answer: 'Team Atlas', forbidden: 'teal' },
    { name: 'retention', fact: 'The original alias for Project Cedar was Grove.', newer: 'Project Cedar has a canonical handoff record for the original alias.', question: 'What was Project Cedar called originally?', answer: 'Grove', forbidden: 'unknown because old observations expired' },
  ];
  const histories: History[] = [], cases: Case[] = [];
  for (const family of families) {
    for (let v = 0; v < (family.name === 'scope' ? 9 : 4); v++) {
      const id = `synthetic-${family.name}`;
      const historyId = `${id}-v${v + 1}`;
      const base = Date.parse('2026-01-01T00:00:00Z');
      const mk = (n: number, role: Event['role'], text: string): Event => ({ at: new Date(base + n * 86_400_000).toISOString(), role, text,
        source: { ref: `${historyId}/timeline`, start: n, end: n + 1, quote: text }, taskId: `${historyId}-task-${n}`,
        ...(role === 'user' ? { authorId: 'UTESTUSER01', authorName: 'Test user', messageTs: String(Math.floor((base + n * 86_400_000) / 1000)) + '.000000' } : {}) });
      let newer = family.newer;
      let required = family.answer;
      let forbidden = family.forbidden;
      if (v === 1 && family.name === 'updates') { newer = 'The approved launch date is October 26.'; required = 'October 26'; forbidden = 'October 19'; }
      if (v === 1 && family.name === 'uncertainty') { newer = 'The 24-hour lead time was approved.'; required = 'approved'; forbidden = 'still awaits approval'; }
      const scopeDm = family.name === 'scope' && (v === 4 || v === 5);
      const privateId = scopeDm ? 'DTESTUSER01' : 'GTESTCHAN01';
      const fact = scopeDm ? 'In direct message DTESTUSER01, the renewal ceiling is 40 units.' : family.fact;
      const events = [mk(0, 'user', fact), mk(1, 'user', newer), mk(2, 'assistant', 'I will remember the update.')];
      if (family.name === 'attribution') {
        events[0].authorId = 'UMIRAUSER01'; events[0].authorName = 'Mira';
        events[1].authorId = 'UTESTUSER02'; events[1].authorName = 'Colleague';
      }
      if (family.name === 'scope') {
        events[0].audience = scopeDm ? { kind: 'user', channelId: privateId, userId: 'UTESTUSER01' }
          : { kind: 'private_channel', channelId: privateId };
        events[1].audience = { kind: 'public', channelId: 'CTESTCHAN01' };
      }
      const distractors = family.name === 'irrelevance' ? [0, 10, 40, 80][v]
        : family.name === 'retention' ? [5, 15, 5, 60][v]
          : v === 3 ? 20 : 0;
      for (let i = 0; i < distractors; i++) {
        const text = family.name === 'retention'
          ? `Project Cedar checklist item ${i} is marker ${digest(`${historyId}:${i}`).slice(0, 8)}.`
          : `Unrelated item ${i}: marker ${digest(String(i)).slice(0, 8)}.`;
        const event = mk(3 + i, 'user', text);
        if (family.name === 'irrelevance') event.taskId = `${historyId}-distractors`;
        events.push(event);
      }
      const completionByTask = new Map(events.filter((e) => e.role === 'user').map((e) => [e.taskId!, e.at]));
      const h: History = { id: historyId, family: id, source: 'synthetic', workload: 'synthetic',
        scope: { kind: family.name === 'scope' ? scopeDm ? 'user' : 'private_channel' : 'public', channelId: family.name === 'scope' ? privateId : 'CTESTCHAN01',
          ...(scopeDm ? { userId: 'UTESTUSER01' } : {}), authorIds: family.name === 'attribution' ? ['UMIRAUSER01', 'UTESTUSER02'] : ['UTESTUSER01'] }, events,
        completions: [...completionByTask].map(([taskId, at]) => ({ at, taskId })) };
      histories.push(h);
      const isScopeDenied = family.name === 'scope' && (v === 1 || v === 2 || v === 5 || v >= 6);
      const audience: Case['audience'] = family.name !== 'scope' ? { kind: h.scope.kind, channelId: h.scope.channelId }
        : v === 1 ? { kind: 'public', channelId: 'CTESTCHAN01' }
          : v === 2 ? { kind: 'private_channel', channelId: 'GOTHERCHAN01' }
            : v === 6 ? { kind: 'private_channel', channelId: privateId, authorization: 'revoked' }
              : v === 7 ? { kind: 'private_channel', channelId: privateId, authorization: 'external' }
                : v === 8 ? { kind: 'private_channel', channelId: privateId, authorization: 'unknown' }
                  : { kind: h.scope.kind, channelId: h.scope.channelId, ...(scopeDm ? { userId: 'UTESTUSER01' } : {}) };
      cases.push({ id: `${id}-${v + 1}`, family: id, source: 'synthetic', workload: 'synthetic', ability: family.name,
        split: splitForFamily(id), historyId, queryAt: new Date(Date.parse(events.at(-1)!.at) + 1000).toISOString(),
        requester: family.name === 'attribution' ? 'UMIRAUSER01' : family.name === 'scope' ? v === 3 || v === 5 ? 'UTESTUSER02' : 'UTESTUSER01'
          : v === 2 && family.name !== 'retention' ? 'UTESTUSER02' : 'UTESTUSER01', audience, currentContext: '',
        question: family.name === 'retention' && v === 2 ? '¿Cuál era el alias original de Project Cedar?' : family.question,
        required: isScopeDenied ? ['Insufficient authorized information'] : [required],
        forbidden: isScopeDenied ? ['40 units'] : family.name === 'scope' ? ['No ceiling is available'] : [forbidden],
        evidence: isScopeDenied ? [events[1].source] : [events[0].source, events[1].source], review: 'draft',
        reason: 'Deterministic timeline fixture; semantic label pending calibration.' });
      const futureVariant = v === 0 || family.name === 'scope' && [1, 2, 5].includes(v)
        || family.name === 'updates' && v === 1 || family.name === 'uncertainty' && v === 1
        || family.name === 'irrelevance' && v === 3 || family.name === 'retention' && v === 3;
      if (futureVariant) {
        const anchor = cases.at(-1)!;
        const scenario = {
          updates: ['Draft one sentence for the next release note.', 'What approved date should the sentence use?'],
          'decision-correction': ['Draft one sentence for the next release note.', 'What approved date should the sentence use?'],
          attribution: ["Prepare Mira's next status reporting plan.", 'What cadence should the plan use?'],
          scope: ['Prepare a renewal quote for the declared audience.', 'What ceiling may you include in the quote, if any?'],
          uncertainty: ['Prepare a status note about the proposed lead time.', 'How will you describe its approval status?'],
          irrelevance: ['Assign the next package handoff.', 'Who should own it?'],
          retention: ['Prepare a handoff that refers to Project Cedar by its original alias.', 'What alias will you use?'],
        }[family.name]!;
        cases.push({ ...anchor, id: `${anchor.id}-future`, ability: `${family.name}-future`, taskKind: 'future_task',
          currentContext: scenario[0], question: scenario[1], reason: 'Controlled future-task fixture; evaluate a plan or answer, not historical question reconstruction.' });
      }
    }
  }
  return { histories, cases };
}

export async function importLongMemEval(path: string, oraclePath: string): Promise<{ histories: History[]; cases: Case[] }> {
  const data = await json<Array<Record<string, unknown>>>(path);
  const oracle = new Map((await json<Array<Record<string, unknown>>>(oraclePath)).map((row) => [String(row.question_id), row]));
  const types = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'temporal-reasoning', 'knowledge-update', 'multi-session'];
  const chosen = types.flatMap((type) => {
    const rows = data.filter((r) => r.question_type === type);
    const abstention = rows.find((r) => String(r.question_id).endsWith('_abs'));
    const factual = rows.filter((r) => !String(r.question_id).endsWith('_abs'));
    return abstention ? [...factual.slice(0, 3), abstention] : factual.slice(0, 4);
  });
  if (chosen.length !== 24) throw new Error('cleaned LongMemEval source lacks required categories');
  const histories: History[] = [], cases: Case[] = [];
  for (const row of chosen) {
    const questionId = String(row.question_id);
    const family = `longmemeval-${questionId}`;
    const sessions = row.haystack_sessions as Array<Array<{ role: 'user' | 'assistant'; content: string; has_answer?: boolean }>>;
    const dates = row.haystack_dates as string[];
    const sessionIds = row.haystack_session_ids as string[];
    const events: Event[] = [];
    for (let i = 0; i < sessions.length; i++) for (let j = 0; j < sessions[i].length; j++) {
      const turn = sessions[i][j];
      const at = new Date(dates[i]).toISOString();
      events.push({ at, role: turn.role, text: turn.content, source: { ref: `${family}/${sessionIds[i]}`, start: j, end: j + 1, quote: turn.content.slice(0, 240) }, taskId: `lme-${questionId.replace(/[^A-Za-z0-9_-]/g, '-')}-${i}`,
        ...(turn.role === 'user' ? { authorId: 'UPUBLICUSER', authorName: 'Public benchmark user', messageTs: `${Math.floor(Date.parse(at) / 1000)}.${String(j).padStart(6, '0')}` } : {}) });
    }
    const queryAt = new Date(String(row.question_date)).toISOString();
    const h: History = { id: family, family, source: 'longmemeval', workload: 'public',
      scope: { kind: 'public', channelId: 'CLONGMEMEVAL', authorIds: ['UPUBLICUSER'] }, events,
      completions: [...new Set(events.map((e) => e.taskId!))].map((taskId) => ({ at: events.filter((e) => e.taskId === taskId).at(-1)!.at, taskId })) };
    const oracleRow = oracle.get(questionId);
    if (!oracleRow) throw new Error(`missing oracle evidence row for ${questionId}`);
    const answerIds = new Set(oracleRow.haystack_session_ids as string[] ?? []);
    if ([...answerIds].some((id) => !sessionIds.includes(id))) throw new Error(`oracle evidence outside full history for ${questionId}`);
    const evidence = questionId.endsWith('_abs') ? [] : events.filter((e) => answerIds.has(e.source.ref.split('/').at(-1)!)
      && !!sessions[sessionIds.indexOf(e.source.ref.split('/').at(-1)!)].at(e.source.start)?.has_answer).map((e) => e.source);
    if (!questionId.endsWith('_abs') && evidence.length === 0) throw new Error(`missing answer-marked evidence for ${questionId}`);
    cases.push({ id: family, family, source: 'longmemeval', workload: 'public', ability: String(row.question_type),
      split: splitForFamily(family), historyId: family, queryAt, requester: 'UPUBLICUSER',
      audience: { kind: 'public', channelId: 'CLONGMEMEVAL' }, currentContext: '', question: String(row.question),
      required: [String(row.answer)], forbidden: [], evidence, review: 'draft',
      reason: 'Adapted subset; official answer is provisional until calibration. Abstentions have no evidence location.' });
    histories.push(h);
  }
  return { histories, cases };
}

export function combine(parts: Array<{ histories: History[]; cases: Case[] }>, provenance: Record<string, unknown>): Corpus {
  return { version: 1, histories: parts.flatMap((p) => p.histories), cases: parts.flatMap((p) => p.cases), provenance };
}
