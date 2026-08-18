/**
 * Structural guards that keep the single Slack render path single.
 *
 * `renderMessageBody` in `src/connectors/slack/message-body.ts` is the one place a Slack message becomes agent-facing text, and `SlackThreadMessage.ownText` is deliberately only a PART of a message. Both properties are architectural rather than behavioural: a new call site that reads the partial field, or re-decides redaction for itself, breaks nothing today and quietly renders less than the message tomorrow. That is the class of defect this change removed, so it is asserted here rather than left to review.
 *
 * These read the source tree as text — the same shape as `slack-manifest.test.ts`, with `readFileSync` and `__dirname`-relative paths — because the mechanism that would normally express them is unavailable: `npm run lint` is dead in this repo (the script passes a bare glob to `eslint`, there is no `eslint.config.` file, and ESLint 9 refuses to run without one), so a vitest assertion is the only such rule CI actually executes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/connectors/slack/__tests__ → repo root is four levels up.
const repoRoot = join(__dirname, '..', '..', '..', '..');
const srcRoot = join(repoRoot, 'src');

interface SourceFile {
  /** Repo-relative, forward-slashed, so failure messages and allowlists read the same on any platform. */
  path: string;
  /** File contents with comment bodies blanked out — see `stripComments`. */
  code: string;
  /** Whether the file lives under a `__tests__` directory. */
  isTest: boolean;
}

/** Every `.ts`/`.tsx` file under `src/`, walked with `node:fs` (no shell-out, no new dependency). */
function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Blank out `//` line comments and block comments, leaving code and string literals intact.
 *
 * Load-bearing for the redaction assertion below: both `src/agents/tools.ts` and `src/connectors/slack/message-body.ts` legitimately explain the design in prose that quotes the very literal being searched for, so a naive substring scan would flag the two documents that argue FOR the rule. A character scanner rather than a regex, because it has to know it is inside a string or template literal — `'https://…'` is not the start of a comment.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        // Newlines are kept so the remaining code stays on its original lines.
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const sources: SourceFile[] = walkSources(srcRoot).map((full) => {
  const path = relative(repoRoot, full).split(sep).join('/');
  return { path, code: stripComments(readFileSync(full, 'utf-8')), isTest: path.includes('/__tests__/') };
});

/** The whole file text (comments included) — for the assertion that a name is gone from the tree entirely. */
const rawSources: Array<{ path: string; text: string }> = walkSources(srcRoot).map((full) => ({
  path: relative(repoRoot, full).split(sep).join('/'),
  text: readFileSync(full, 'utf-8'),
}));

/** Extract the body of `interface <name> { … }`, brace-matched so nested inline object types don't end it early. */
function interfaceBody(code: string, name: string): string {
  const header = code.indexOf(`interface ${name}`);
  if (header === -1) throw new Error(`interface ${name} not found`);
  const open = code.indexOf('{', header);
  if (open === -1) throw new Error(`interface ${name} has no body`);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error(`interface ${name} body is unterminated`);
}

// ---- the two matchers, factored out so they can be shown to discriminate ----

/** Files outside the allowed set that read `.ownText` as a member. The extractor that produces it, the renderer that consumes it, and the one render call site that gathers parts and hands them straight to `renderMessageBody`. */
const OWN_TEXT_READERS_ALLOWED = [
  'src/connectors/slack/client.ts',
  'src/connectors/slack/message-body.ts',
  'src/connectors/slack/channel-pins.ts',
];
function ownTextReadOffenders(files: SourceFile[]): string[] {
  return files
    .filter((f) => !f.isTest && !OWN_TEXT_READERS_ALLOWED.includes(f.path) && /\.ownText\b/.test(f.code))
    .map((f) => f.path);
}

/** Files outside the allowed set that decide NOT to redact for themselves. `channel-pins.ts` is allowed on a stated reason, recorded in the failure message below. */
const UNREDACTED_RENDER_ALLOWED = [
  'src/connectors/slack/message-body.ts',
  'src/connectors/slack/channel-pins.ts',
];
function unredactedRenderOffenders(files: SourceFile[]): string[] {
  return files
    .filter((f) => !f.isTest && !UNREDACTED_RENDER_ALLOWED.includes(f.path) && /redacted:\s*false/.test(f.code))
    .map((f) => f.path);
}

describe('the Slack render path stays single', () => {
  it('has no trace of the renderer that message-body.ts replaced', () => {
    // Assembled from parts on purpose: spelling the name out here would make this file the very occurrence it is asserting is gone.
    const gone = ['render', 'MessageForContext'].join('');
    const found = rawSources.filter((f) => f.text.includes(gone)).map((f) => f.path);

    expect(found, `${gone} is the renderer message-body.ts replaced; a surviving reference means a second render path grew back`).toEqual([]);
  });

  it('reads the partial ownText field only in the extractor, the renderer and the pin render call site', () => {
    expect(
      ownTextReadOffenders(sources),
      `\`.ownText\` is only the author's own typed text, NOT the message body: it excludes attachment cards, the file list and reactions. Reading it anywhere but ${OWN_TEXT_READERS_ALLOWED.join(', ')} is how a caller silently renders LESS than the message — an attachment-only alert reaches the agent as a blank line — which is precisely the defect this change removed. Render through \`renderMessageBody\` instead.`,
    ).toEqual([]);
  });

  it('declares no `text` field on either message interface — the body is rendered, never stored', () => {
    const threadMessage = interfaceBody(
      stripComments(readFileSync(join(repoRoot, 'src/types/task.ts'), 'utf-8')),
      'SlackThreadMessage',
    );
    const rawMessage = interfaceBody(
      stripComments(readFileSync(join(repoRoot, 'src/connectors/slack/client.ts'), 'utf-8')),
      'RawSlackMessage',
    );

    // Scoped to the two interface bodies deliberately: `SlackAttachment` has its own `text`, and the Slack API payload types have many. Only these two are the ingested-message shapes whose `text` field WAS the whole body.
    for (const [name, body] of [['SlackThreadMessage', threadMessage], ['RawSlackMessage', rawMessage]] as const) {
      expect(body, `${name} must carry the author's own text under \`ownText\`, so no caller can mistake a part of the message for the whole of it`).toMatch(/\bownText\s*:/);
      expect(body, `${name} must not declare a \`text\` field — reintroducing it recreates the shape whose name promised the whole message and delivered only part of it`).not.toMatch(/\btext\s*:/);
    }
  });

  it('does not re-decide redaction at call sites', () => {
    expect(
      unredactedRenderOffenders(sources),
      `An inline \`redacted: false\` is a call site deciding for itself that a message need not be redacted. The question is answered once, by \`shouldRedact\` in message-body.ts, and the one sanctioned unredacted path is the named \`exploreBody\` — named so the decision is greppable and auditable. \`channel-pins.ts\` is allowed because pins are gated upstream by a two-principal trust check that DROPS external content before it can ever be rendered, so redaction there is structurally unnecessary rather than merely convenient.`,
    ).toEqual([]);
  });
});

describe('the routing gate keeps its two questions separate', () => {
  it('exports waking a task and reaching a trigger as independent questions', async () => {
    const routing = await import('../task-routing.js');

    expect(routing.mayWakeTask).toBeTypeOf('function');
    expect(routing.mayReachTriggers).toBeTypeOf('function');
  });

  it('gates message subtypes with a denylist of exactly 17, so an unknown subtype is forwarded', () => {
    const routingSource = stripComments(
      readFileSync(join(repoRoot, 'src/connectors/slack/task-routing.ts'), 'utf-8'),
    );
    const literal = /MESSAGE_NOISE_SUBTYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(routingSource);
    expect(literal, 'MESSAGE_NOISE_SUBTYPES must be a Set literal this test can count').not.toBeNull();
    const entries = Array.from(literal![1].matchAll(/'([^']+)'/g)).map((m) => m[1]);

    expect(entries, 'the subtype gate is a denylist: a count that grew means someone added a subtype to it, and a count that shrank means the list was replaced').toHaveLength(17);

    // Absent, and therefore forwarded. Each of these was invisible under the old allowlist.
    for (const forwarded of ['bot_message', 'me_message', 'huddle_thread', 'channel_topic', 'file_mention']) {
      expect(entries, `${forwarded} carries content and must NOT be on the noise denylist`).not.toContain(forwarded);
    }
    // Present, and therefore dropped: `message_changed` has its own edit handler, `channel_join` is auto-generated text with no human author.
    for (const noise of ['message_changed', 'channel_join']) {
      expect(entries, `${noise} must stay on the noise denylist`).toContain(noise);
    }
  });

  it('stays import-free, so the gate is unit-testable without the Bolt or Task machinery', () => {
    const routingSource = stripComments(
      readFileSync(join(repoRoot, 'src/connectors/slack/task-routing.ts'), 'utf-8'),
    );

    expect(routingSource, 'task-routing.ts is deliberately dependency-free — that is why the gate can be tested without booting Bolt, and why its drop-log lives at the call site in events.ts instead of here').not.toMatch(/^\s*import\b/m);
  });
});

describe('no empty-text fallback survives', () => {
  it('has no nullish-coalescing empty-message fallback anywhere under src/', () => {
    // Assembled from parts for the same reason as the dead renderer above: spelling the sequence out here would make this file the occurrence it is asserting is absent.
    const fallback = ['?? { ', 'text:'].join('');
    const found = rawSources.filter((f) => f.text.includes(fallback)).map((f) => f.path);

    expect(found, `a "${fallback} … }" fallback silently reopens the original bug when a thread-root lookup misses: the caller gets a well-formed but empty message instead of an error, and the agent is shown a blank line where an attachment-only report was`).toEqual([]);
  });
});

/**
 * The two structural matchers above pass on a tree that has no violations — which is also what a matcher that can never fire looks like. These feed each one a synthetic violating file to show the difference, in memory, without touching a production file.
 */
describe('the structural matchers are discriminating', () => {
  it('flags an ownText read in a file that is not allowed to have one', () => {
    const violating: SourceFile[] = [
      { path: 'src/system/triage.ts', code: 'const body = msg.ownText;', isTest: false },
    ];

    expect(ownTextReadOffenders(violating)).toEqual(['src/system/triage.ts']);
    // ...and the same read is fine in the renderer that owns the field, or in a test.
    expect(ownTextReadOffenders([
      { path: 'src/connectors/slack/message-body.ts', code: 'parts.ownText', isTest: false },
      { path: 'src/system/__tests__/triage.test.ts', code: 'msg.ownText', isTest: true },
    ])).toEqual([]);
  });

  it('flags an inline `redacted: false` in code while ignoring one in prose', () => {
    const violating: SourceFile[] = [
      { path: 'src/agents/tools.ts', code: stripComments('const body = renderMessageBody(m, { redacted: false });'), isTest: false },
    ];
    expect(unredactedRenderOffenders(violating)).toEqual(['src/agents/tools.ts']);

    // The real src/agents/tools.ts mentions the literal only in a comment explaining why `exploreBody` exists — comment-stripping is what keeps that document from failing the rule it documents.
    const prose: SourceFile[] = [
      { path: 'src/agents/tools.ts', code: stripComments('// named rather than an inline `redacted: false` literal\nconst body = exploreBody(m);'), isTest: false },
    ];
    expect(unredactedRenderOffenders(prose)).toEqual([]);
  });
});
