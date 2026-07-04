/**
 * archie-e2e evidence writer — validate a scenario's evidence payload against the
 * `archie-e2e-evidence/v1` schema and write the canonical JSON plus a rendered
 * markdown companion for human reviewers.
 *
 * Usage: npx tsx tools/e2e/evidence.ts [--in <file>] [--out-dir <dir>]
 *   input: stdin by default (read fully into memory before parsing), or --in <file>
 *   destination: --out-dir, else E2E_EVIDENCE_DIR, else ./e2e-evidence/ at the repo root
 *
 * All-or-nothing semantics: truncated/malformed input or an invalid payload exits
 * non-zero with named errors and writes NOTHING; on success the <scenario>.json and
 * <scenario>.md pair is written atomically (temp-file + rename) and transactionally —
 * both files land or neither does. This matters because evidence gets committed into
 * qa-evidence/ and judged by a reviewer from the file alone.
 *
 * Pure cores (validateEvidence, renderEvidenceMarkdown, parseEvidenceJson,
 * runEvidenceWriter over an injected fs) are unit-tested with fakes; main wires real deps.
 */

import { accessSync, constants, existsSync, promises as fsp, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// ---- Schema (archie-e2e-evidence/v1) ----

export const EVIDENCE_SCHEMA = 'archie-e2e-evidence/v1' as const;

export const TERMINAL_STATES = ['completed', 'stopped', 'approval_requested', 'pending', 'not_found'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export interface EvidenceAssertion {
  id: string;
  description: string;
  expected: string;
  observed: string;
  pass: boolean;
}

export interface EvidenceEnvironment {
  base_url: string;
  git_branch: string;
  git_commit: string;
}

export interface Evidence {
  schema: typeof EVIDENCE_SCHEMA;
  scenario: string;
  ac_ids: string[];
  started_at: string;
  finished_at: string;
  environment: EvidenceEnvironment;
  nonce: string;
  task_id: string;
  terminal_state: TerminalState;
  assertions: EvidenceAssertion[];
  excerpts: {
    knowledge_log: string[];
    events: unknown[];
  };
  result: 'pass' | 'fail';
}

// ---- Validation (pure) ----

export type ValidationResult = { ok: true; evidence: Evidence } | { ok: false; errors: string[] };

/** The scenario names the output files, so it must be a safe kebab-case token. */
const SCENARIO_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Validate an untrusted payload against archie-e2e-evidence/v1, returning named structured errors. */
export function validateEvidence(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(payload)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }

  if (payload['schema'] !== EVIDENCE_SCHEMA) {
    errors.push(`schema must be "${EVIDENCE_SCHEMA}" (got ${JSON.stringify(payload['schema'])})`);
  }

  const requireString = (field: string): void => {
    const v = payload[field];
    if (typeof v !== 'string' || v.trim() === '') errors.push(`${field} must be a non-empty string`);
  };
  requireString('scenario');
  requireString('started_at');
  requireString('finished_at');
  requireString('nonce');
  requireString('task_id');

  if (typeof payload['scenario'] === 'string' && payload['scenario'] !== '' && !SCENARIO_PATTERN.test(payload['scenario'])) {
    errors.push(`scenario must be kebab-case ([a-z0-9-], it names the output files); got "${payload['scenario']}"`);
  }

  if (!isStringArray(payload['ac_ids']) || payload['ac_ids'].length === 0) {
    errors.push('ac_ids must be a non-empty array of AC id strings');
  }

  const env = payload['environment'];
  if (!isRecord(env)) {
    errors.push('environment must be an object with base_url, git_branch, git_commit');
  } else {
    for (const field of ['base_url', 'git_branch', 'git_commit'] as const) {
      if (typeof env[field] !== 'string' || env[field].trim() === '') {
        errors.push(`environment.${field} must be a non-empty string`);
      }
    }
  }

  const terminal = payload['terminal_state'];
  if (typeof terminal !== 'string' || !(TERMINAL_STATES as readonly string[]).includes(terminal)) {
    errors.push(`terminal_state must be one of ${TERMINAL_STATES.join('|')} (got ${JSON.stringify(terminal)})`);
  }

  const assertions = payload['assertions'];
  if (!Array.isArray(assertions) || assertions.length === 0) {
    errors.push('assertions must be a non-empty array');
  } else {
    assertions.forEach((a, i) => {
      if (!isRecord(a)) {
        errors.push(`assertions[${i}] must be an object`);
        return;
      }
      for (const field of ['id', 'description', 'expected', 'observed'] as const) {
        if (typeof a[field] !== 'string' || a[field].trim() === '') {
          errors.push(`assertions[${i}].${field} must be a non-empty string`);
        }
      }
      if (typeof a['pass'] !== 'boolean') {
        errors.push(`assertions[${i}].pass must be a boolean`);
      }
    });
  }

  const excerpts = payload['excerpts'];
  if (!isRecord(excerpts)) {
    errors.push('excerpts must be an object with knowledge_log and events arrays');
  } else {
    if (!isStringArray(excerpts['knowledge_log'])) errors.push('excerpts.knowledge_log must be an array of strings');
    if (!Array.isArray(excerpts['events'])) errors.push('excerpts.events must be an array');
  }

  const result = payload['result'];
  if (result !== 'pass' && result !== 'fail') {
    errors.push(`result must be "pass" or "fail" (got ${JSON.stringify(result)})`);
  } else if (Array.isArray(assertions) && assertions.length > 0 && assertions.every(isRecord)) {
    const allPass = assertions.every((a) => (a as Record<string, unknown>)['pass'] === true);
    const expected = allPass ? 'pass' : 'fail';
    if (result !== expected) {
      errors.push(`result "${result}" is inconsistent with assertion outcomes (expected "${expected}" — result must equal the AND of assertion passes)`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, evidence: payload as unknown as Evidence };
}

// ---- Markdown rendering (pure) ----

/** Escape a value for a one-line markdown table cell (backslashes first, so escapes stay unambiguous). */
function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Render the reviewer-facing markdown companion from validated evidence. */
export function renderEvidenceMarkdown(e: Evidence): string {
  const passCount = e.assertions.filter((a) => a.pass).length;
  const lines: string[] = [];

  lines.push(`# E2E evidence — ${e.scenario}`);
  lines.push('');
  lines.push(`- **Result:** ${e.result.toUpperCase()}`);
  lines.push(`- **ACs covered:** ${e.ac_ids.join(', ')}`);
  lines.push(`- **Terminal state:** \`${e.terminal_state}\``);
  lines.push(`- **Started:** ${e.started_at} · **Finished:** ${e.finished_at}`);
  lines.push(`- **Environment:** ${e.environment.base_url} · branch \`${e.environment.git_branch}\` · commit \`${e.environment.git_commit}\``);
  lines.push(`- **Nonce:** \`${e.nonce}\` · **Task:** \`${e.task_id}\``);
  lines.push('');
  lines.push('## Assertions');
  lines.push('');
  lines.push('| id | description | expected | observed | pass |');
  lines.push('|----|-------------|----------|----------|------|');
  for (const a of e.assertions) {
    lines.push(`| ${cell(a.id)} | ${cell(a.description)} | ${cell(a.expected)} | ${cell(a.observed)} | ${a.pass ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('## Excerpts');
  lines.push('');
  lines.push('### Knowledge log');
  lines.push('');
  lines.push('```');
  lines.push(e.excerpts.knowledge_log.length > 0 ? e.excerpts.knowledge_log.join('\n') : '(none)');
  lines.push('```');
  lines.push('');
  lines.push('### Events');
  lines.push('');
  lines.push('```json');
  lines.push(e.excerpts.events.length > 0 ? e.excerpts.events.map((ev) => JSON.stringify(ev)).join('\n') : '(none)');
  lines.push('```');
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push(`**${e.result.toUpperCase()}** — ${passCount}/${e.assertions.length} assertions passed.`);
  lines.push('');
  return lines.join('\n');
}

// ---- Input parsing (pure) ----

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse raw input into JSON, classifying truncation (EOF mid-document) separately from other malformations. */
export function parseEvidenceJson(input: string, source = 'stdin'): ParseResult {
  if (input.trim() === '') {
    return { ok: false, error: `truncated JSON input from ${source}: empty input` };
  }
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // V8 phrases EOF-mid-document differently depending on where the input cuts off.
    let truncated = /unexpected end of (json )?input|unterminated (string|fractional number) in json|end of data/i.test(msg);
    // Truncation right after a complete value reports as a missing ',' or closer — but only
    // class it as truncation when the complaint is at the very end of the input; the same
    // message mid-input is genuine malformation.
    if (!truncated) {
      const positional = /expected ',' or '[}\]]' after (?:property value|array element) in json at position (\d+)/i.exec(msg);
      if (positional) truncated = Number(positional[1]) >= input.trimEnd().length;
    }
    return {
      ok: false,
      error: truncated ? `truncated JSON input from ${source}: ${msg}` : `invalid JSON from ${source}: ${msg}`,
    };
  }
}

// ---- Transactional pair write (pure core over injected fs) ----

export interface EvidenceFs {
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Best-effort cleanup — failures are swallowed by the caller. */
  unlink(path: string): Promise<void>;
}

async function cleanupQuietly(fs: EvidenceFs, paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await fs.unlink(p);
    } catch {
      // best-effort
    }
  }
}

/**
 * Write <scenario>.json + <scenario>.md atomically (temp + rename) and transactionally:
 * both files land or neither does; temps are cleaned up on failure.
 */
export async function writeEvidencePair(
  fs: EvidenceFs,
  outDir: string,
  evidence: Evidence,
): Promise<{ jsonPath: string; mdPath: string }> {
  const jsonPath = join(outDir, `${evidence.scenario}.json`);
  const mdPath = join(outDir, `${evidence.scenario}.md`);
  const jsonTmp = `${jsonPath}.tmp`;
  const mdTmp = `${mdPath}.tmp`;

  // Render before touching disk — a render failure must write nothing.
  const markdown = renderEvidenceMarkdown(evidence);
  const json = `${JSON.stringify(evidence, null, 2)}\n`;

  await fs.mkdir(outDir);
  try {
    await fs.writeFile(jsonTmp, json);
    await fs.writeFile(mdTmp, markdown);
  } catch (err) {
    await cleanupQuietly(fs, [jsonTmp, mdTmp]);
    throw err;
  }
  try {
    await fs.rename(jsonTmp, jsonPath);
  } catch (err) {
    await cleanupQuietly(fs, [jsonTmp, mdTmp]);
    throw err;
  }
  try {
    await fs.rename(mdTmp, mdPath);
  } catch (err) {
    // The JSON already landed — roll it back so the pair stays transactional.
    await cleanupQuietly(fs, [jsonPath, mdTmp]);
    throw err;
  }
  return { jsonPath, mdPath };
}

// ---- Orchestration (pure core; main wires real deps) ----

export interface WriterIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Parse → validate → write, all-or-nothing. Returns the process exit code. */
export async function runEvidenceWriter(
  input: string,
  source: string,
  outDir: string,
  fs: EvidenceFs,
  io: WriterIo,
): Promise<number> {
  const parsed = parseEvidenceJson(input, source);
  if (!parsed.ok) {
    io.error(parsed.error);
    return 1;
  }

  const validated = validateEvidence(parsed.value);
  if (!validated.ok) {
    io.error('evidence payload failed validation:');
    for (const e of validated.errors) io.error(`  - ${e}`);
    return 1;
  }

  try {
    const { jsonPath, mdPath } = await writeEvidencePair(fs, outDir, validated.evidence);
    io.log(`Evidence written: ${jsonPath}`);
    io.log(`Evidence written: ${mdPath}`);
    return 0;
  } catch (err) {
    io.error(`failed to write evidence pair: ${err instanceof Error ? err.message : String(err)} (no partial files left behind)`);
    return 1;
  }
}

// ---- CLI main ----

const USAGE = 'usage: npx tsx tools/e2e/evidence.ts [--in <file>] [--out-dir <dir>]';

/** Exported for tests. Throws on unknown arguments and on flags missing their value. */
export function parseArgs(argv: string[]): { inFile?: string; outDir?: string } {
  const result: { inFile?: string; outDir?: string } = {};
  const takeValue = (flag: string, i: number): string => {
    const value = argv[i];
    if (value === undefined) throw new Error(`${flag} requires a value (${USAGE})`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--in') result.inFile = takeValue('--in', ++i);
    else if (arg.startsWith('--in=')) result.inFile = arg.slice('--in='.length);
    else if (arg === '--out-dir') result.outDir = takeValue('--out-dir', ++i);
    else if (arg.startsWith('--out-dir=')) result.outDir = arg.slice('--out-dir='.length);
    else throw new Error(`unknown argument: ${arg} (${USAGE})`);
  }
  return result;
}

/**
 * Destination precedence: --out-dir flag → E2E_EVIDENCE_DIR env → default.
 * Set-but-empty values count as unset (consistent with config.ts port resolution).
 */
export function resolveOutDir(flag: string | undefined, env: string | undefined, defaultDir: string): string {
  if (flag) return flag;
  if (env) return env;
  return defaultDir;
}

async function readStdinFully(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  let args: { inFile?: string; outDir?: string };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  // Ingestion: read fully into memory before any parse attempt.
  let input: string;
  let source: string;
  if (args.inFile !== undefined) {
    if (!existsSync(args.inFile)) {
      console.error(`input file not found: ${args.inFile}`);
      process.exit(1);
    }
    try {
      accessSync(args.inFile, constants.R_OK);
    } catch {
      console.error(`input file not readable: ${args.inFile}`);
      process.exit(1);
    }
    input = readFileSync(args.inFile, 'utf-8');
    source = args.inFile;
  } else {
    input = await readStdinFully();
    source = 'stdin';
  }

  const outDir = resolveOutDir(args.outDir, process.env.E2E_EVIDENCE_DIR, join(repoRoot, 'e2e-evidence'));

  const realFs: EvidenceFs = {
    mkdir: async (dir) => void (await fsp.mkdir(dir, { recursive: true })),
    writeFile: (path, content) => fsp.writeFile(path, content, 'utf-8'),
    rename: (from, to) => fsp.rename(from, to),
    unlink: (path) => fsp.unlink(path),
  };

  const code = await runEvidenceWriter(input, source, outDir, realFs, {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
