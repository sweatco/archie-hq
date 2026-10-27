// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Run at the source: identity maps, raw recordings and historical answers stay here.
const [from, to, seed = 'archie-sessions-v1', maximum = '100', mode = 'capture'] = process.argv.slice(2);
if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from >= to || !/^[1-9]\d*$/.test(maximum) || +maximum > 1000 || !['capture', 'inventory'].includes(mode)) throw new Error('Expected FROM_ISO TO_ISO [SEED] [MAX_SESSIONS<=1000] [capture|inventory]');
const root = process.env.ARCHIE_WORKDIR || '/workdir';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const counts: Record<string, number> = {};
const count = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const core = new Set(['comms-tools', 'orchestration-tools', 'repo-tools', 'scheduling-tools', 'research-tools', 'file-bridge', 'memory-tools', 'observation-tools']);
const local = new Set(['mcp__comms-tools__post_to_user', 'mcp__orchestration-tools__report_completion']);
const sessions: any[] = [];
class Unsupported extends Error {}
let totalBytes = 0;
const wrappers = [
  ['New task. This is what arrived:\n\n', '\n\nHandle it.'],
  ['New activity in a thread you are in — not necessarily a request for you:\n\n', '\n\nDecide whether it is yours to answer before you decide what to say.'],
];
function supportedInput(entry: any, message: string, sender: string, text: string): boolean {
  if (Array.isArray(entry.message?.content) && entry.message.content.some((block: any) => block.type !== 'text')) return false;
  if (text === message) return true;
  for (const [prefix, suffix] of wrappers) {
    if (!text.startsWith(prefix) || !text.endsWith(suffix)) continue;
    const inner = text.slice(prefix.length, -suffix.length);
    const line = /^\[([\dT:.Z+-]+)\] \[(?:cli|<@[UW][A-Z0-9]+:([^>\n]+)> in slack:#<[A-Z0-9]+:[^>\n]+>:\d+\.\d+(?: \| msg:\d+\.\d+)?)\] ([\s\S]*)$/.exec(inner);
    return !!line && Number.isFinite(Date.parse(line[1])) && (!line[2] || line[2] === sender) && line[3] === message;
  }
  return false;
}
const urlToken = (url: string) => {
  const tail = /[.,!?;:)\]}]+$/.exec(url)?.[0] ?? '';
  return `LINK_${hash(seed + url.slice(0, url.length - tail.length)).slice(0, 8)}${tail}`;
};
for (const id of readdirSync(join(root, 'sessions')).sort()) {
  if (!/^task-\d{8}-\d{4}-[a-z0-9]+$/.test(id)) continue;
  try {
    const path = join(root, 'sessions', id), metaPath = join(path, 'shared/metadata.json');
    const rawMeta = readFileSync(metaPath, 'utf8'), metadata = JSON.parse(rawMeta);
    if (metadata.created_at < from || metadata.created_at >= to) continue;
    count('in-window');
    if (metadata.status !== 'completed') { count('unsettled'); continue; }
    const eventPath = join(path, 'shared/events.jsonl'), rawEvents = readFileSync(eventPath, 'utf8');
    const events = rawEvents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const inputs = events.filter((e) => e.type === 'message' && e.data?.to === 'pm-agent' && e.data?.from !== 'pm-agent');
    if (!inputs.length || metadata.triggered_by) { count('no-human-origin-or-triggered'); continue; }
    const claude = join(path, 'claude');
    const files = existsSync(claude) ? readdirSync(claude).flatMap((agent) => {
      const projects = join(claude, agent, 'session/projects');
      return existsSync(projects) ? (readdirSync(projects, { recursive: true }) as string[]).filter((name) => name.endsWith('.jsonl'))
        .map((name) => `${agent}/session/projects/${name}`) : [];
    }).sort() : [];
    const session = metadata.agent_sessions?.['pm-agent'];
    const current = files.filter((name) => /^pm\/session\/projects\/[^/]+\/[^/]+\.jsonl$/.test(name) && name.endsWith(`/${session?.session_id}.jsonl`));
    if (session?.active !== false || typeof session.session_id !== 'string' || current.length !== 1) { count('missing-current-session'); continue; }
    const rawTranscripts = files.map((file) => readFileSync(join(claude, file), 'utf8'));
    const recordings = rawTranscripts.map((raw) => raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    const main = recordings[files.indexOf(current[0])];
    const text = (entry: any): string => typeof entry.message?.content === 'string' ? entry.message.content
      : (entry.message?.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
    const positions: number[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const message = inputs[i].data.message;
      const at = typeof message === 'string' && message.trim() ? main.findIndex((entry, j) => j > (positions.at(-1) ?? -1)
        && entry.type === 'user' && entry.sessionId === session.session_id && text(entry).includes(message)) : -1;
      if (at >= 0 && !supportedInput(main[at], message, inputs[i].data.from, text(main[at]))) throw new Unsupported('unsupported-input-envelope');
      const end = i + 1 < inputs.length ? events.indexOf(inputs[i + 1]) : events.length;
      if (at < 0 || !events.slice(events.indexOf(inputs[i]) + 1, end).some((event) => event.type === 'task:completed')) break;
      positions.push(at);
    }
    if (positions.length !== inputs.length || !main.slice(positions.at(-1)! + 1).some((entry) => entry.type === 'assistant'
      && entry.sessionId === session.session_id && entry.message?.stop_reason === 'end_turn')) { count('incomplete-or-overlapping-turn-history'); continue; }
    if (main.some((entry, index) => entry.type === 'user' && text(entry).trim() && !positions.includes(index))) { count('unaccounted-sdk-user-context'); continue; }
    const blocks = recordings.flat().flatMap((entry) => Array.isArray(entry.message?.content) ? entry.message.content : []);
    const uses = blocks.filter((block) => block.type === 'tool_use'), results = blocks.filter((block) => block.type === 'tool_result');
    if (new Set(uses.map((use) => use.id)).size !== uses.length || uses.some((use) => typeof use.id !== 'string' || results.filter((result) => result.tool_use_id === use.id).length !== 1)
      || results.some((result) => uses.filter((use) => use.id === result.tool_use_id).length !== 1)) { count('missing-or-duplicate-tool-result'); continue; }
    if (uses.some((use) => use.name !== 'ToolSearch' && !local.has(use.name)
      && (!use.name?.startsWith('mcp__') || core.has(use.name.split('__')[1])))) { count('native-subagent-or-core-state-tools'); continue; }
    const external = uses.filter((use) => use.name.startsWith('mcp__') && !local.has(use.name));
    const catalog = [...new Set<string>(external.map((use) => use.name))].sort().map((name) => ({ name,
      keys: [...new Set<string>(external.filter((use) => use.name === name).flatMap((use) => Object.keys(use.input ?? {})))].sort() }));
    const turns = inputs.map((input, i) => {
      const entries = main.slice(positions[i], positions[i + 1] ?? main.length);
      const turnBlocks = entries.flatMap((entry) => Array.isArray(entry.message?.content) ? entry.message.content : []);
      const endTurn = entries.map((entry) => entry.type === 'assistant' && entry.sessionId === session.session_id && entry.message?.stop_reason === 'end_turn').lastIndexOf(true);
      if (endTurn < 0) throw new Unsupported('missing-turn-completion');
      const completion = events.slice(events.indexOf(input) + 1, i + 1 < inputs.length ? events.indexOf(inputs[i + 1]) : events.length).find((event) => event.type === 'task:completed');
      const times = [input.timestamp, entries[0].timestamp, entries[endTurn].timestamp, completion?.timestamp,
        ...(i + 1 < inputs.length ? [inputs[i + 1].timestamp] : [])].map(Date.parse);
      if (times.some((time, i) => !Number.isFinite(time) || i > 0 && time < times[i - 1])) throw new Unsupported('turn-settlement-order');
      return { at: input.timestamp, sender: input.data.from, message: text(entries[0]),
        tools: turnBlocks.filter((block) => block.type === 'tool_use' && external.includes(block)).map((use) => {
          if (!use.input || Array.isArray(use.input) || typeof use.input !== 'object') throw new Error('unsupported arguments');
          const result = turnBlocks.find((block) => block.type === 'tool_result' && block.tool_use_id === use.id);
          const useEntry = entries.find((entry) => Array.isArray(entry.message?.content) && entry.message.content.includes(use));
          const resultEntry = entries.find((entry) => Array.isArray(entry.message?.content) && entry.message.content.includes(result));
          if (!result || turnBlocks.indexOf(result) < turnBlocks.indexOf(use) || useEntry?.sessionId !== session.session_id || resultEntry?.sessionId !== session.session_id
            || entries.indexOf(resultEntry) > endTurn || !Number.isFinite(Date.parse(useEntry.timestamp)) || !Number.isFinite(Date.parse(resultEntry.timestamp))
            || Date.parse(useEntry.timestamp) < times[1] || Date.parse(resultEntry.timestamp) < Date.parse(useEntry.timestamp)
            || Date.parse(resultEntry.timestamp) > Date.parse(entries[endTurn].timestamp)) throw new Unsupported('tool-result-boundary-mismatch');
          const content = typeof result.content === 'string' ? [{ type: 'text', text: result.content }] : result.content;
          if (!Array.isArray(content) || content.some((block: any) => block.type !== 'text' || typeof block.text !== 'string')) throw new Error('unsupported result');
          return { name: use.name, input: use.input, output: { content, isError: result.is_error === true } };
        }) };
    });
    if (turns.reduce((n, turn) => n + turn.tools.length, 0) !== external.length) { count('tool-history-outside-user-turns'); continue; }
    let visible = JSON.stringify({ catalog, turns });
    if (/sk-ant-|xox[baprs]-|BEGIN .*PRIVATE KEY|(?:password|secret|api[_-]?key|access_token|refresh_token|authorization|cookie)["\\]*\s*:/i.test(visible)) { count('secret-pattern'); continue; }
    const identities = new Set<string>([...Object.values(metadata.memory_authors ?? {}) as string[], ...inputs.map((input) => input.data.from)]);
    for (const name of [...identities].filter((value) => value.length > 2 && !['user', 'system', 'pm-agent'].includes(value)).sort((a, b) => b.length - a.length)) {
      visible = visible.replaceAll(name, `PERSON_${hash(seed + name).slice(0, 8)}`);
    }
    visible = visible.replace(/<@([UW][A-Z0-9]{7,})(?:[:|][^>]*)?>/g, (_value, id) => `ID_${hash(seed + id).slice(0, 8)}`)
      .replace(/<(https?:\/\/[^>|"\\]+)(?:\|[^>"\\]*)?>/g, (_value, url) => urlToken(url))
      .replace(/https?:\/\/[^\s<>|"`\\]+/g, urlToken)
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, (value) => `EMAIL_${hash(seed + value).slice(0, 8)}`)
      .replace(/\b[UCDTW][A-Z0-9]{7,}\b/g, (value) => `ID_${hash(seed + value).slice(0, 8)}`)
      .replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, (value) => `ID_${hash(seed + value).slice(0, 8)}`);
    const bytes = Buffer.byteLength(visible);
    if (bytes > 262144) { count('session-over256KiB'); continue; }
    if (mode === 'capture' && (totalBytes + bytes > 16 * 1024 * 1024 || sessions.length >= +maximum)) throw new Error('Corpus exceeds bound; choose a smaller window');
    if (readFileSync(metaPath, 'utf8') !== rawMeta || readFileSync(eventPath, 'utf8') !== rawEvents) { count('changed-during-capture'); continue; }
    const originalWords = events.filter((event) => event.type === 'message' && event.data?.from === 'pm-agent' && event.data?.to === 'user')
      .reduce((n, event) => n + (String(event.data.message).match(/\S+/g)?.length ?? 0), 0);
    sessions.push({ id: `session-${hash(seed + id).slice(0, 12)}`, createdAt: metadata.created_at,
      sourceHash: hash(rawMeta + rawEvents + rawTranscripts.join('')), originalWords, ...JSON.parse(visible) });
    totalBytes += bytes; count('eligible'); count(external.length ? 'external-mcp' : 'local-reply-only'); count(inputs.length > 1 ? 'multi-turn' : 'single-turn');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Corpus exceeds')) throw error;
    count(error instanceof Unsupported ? error.message : 'unsupported-or-malformed');
  }
}
const capture = { schema: 'archie-session-capture/v1', sanitizer: 'identifiers-v1', from, to, seed, capturedAt: new Date().toISOString(),
  inventory: counts, sessions, gaps: ['Only complete local-reply or direct external-MCP sessions; native/subagent/core-state/file work excluded.',
    'Original tool schemas unavailable: neutral tool names and argument keys reconstructed from recordings.',
    'No historical memory, repository, attachment or deployment-plugin snapshot. No assistant answers or local reply arguments exported.',
    'Identifier-pattern sanitization cannot classify every private reference; corpus remains private.'] };
const payload = JSON.stringify(capture);
const sample = [...sessions].sort((a, b) => hash(seed + a.id).localeCompare(hash(seed + b.id))).slice(0, 5);
const workload = (rows: any[]) => ({ sessions: rows.length, turns: rows.reduce((n, session) => n + session.turns.length, 0),
  calls: rows.reduce((n, session) => n + session.turns.reduce((n: number, turn: any) => n + turn.tools.length, 0), 0),
  maxCallsPerTurn: Math.max(0, ...rows.flatMap((session) => session.turns.map((turn: any) => turn.tools.length))),
  maxCallsPerSession: Math.max(0, ...rows.map((session) => session.turns.reduce((n: number, turn: any) => n + turn.tools.length, 0))),
  maxTurnsPerSession: Math.max(0, ...rows.map((session) => session.turns.length)) });
process.stdout.write(mode === 'inventory' ? JSON.stringify({ from, to, inventory: counts, eligible: sessions.length,
  earliest: sessions.map((session) => session.createdAt).sort().at(0), latest: sessions.map((session) => session.createdAt).sort().at(-1),
  ...workload(sessions), sample: workload(sample),
  sanitizedBytes: Buffer.byteLength(payload), gzipBase64Bytes: gzipSync(payload).toString('base64').length, bodyHash: hash(JSON.stringify(sessions)) }) : payload);
