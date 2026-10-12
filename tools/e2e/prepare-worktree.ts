/**
 * archie-e2e prepare-worktree — make a git worktree ready to boot the live harness.
 *
 * Usage: npx tsx tools/e2e/prepare-worktree.ts [--print-plan]
 *
 * It prepares the worktree it is RUN IN. It never creates one: its only git call
 * is a read-only `rev-parse` to locate the main checkout, and everything it
 * writes lands in the current directory.
 *
 * A worktree checkout is a fresh tree: `workdir/`, `claude-data/`, real
 * `secrets/` and `.env` are all untracked, so none of them come across. That is
 * a two-second setup gap, NOT a missing harness capability — this command
 * closes it, and `boot.ts` calls it automatically before its preflight.
 *
 * What it does (idempotent; never overwrites existing local state):
 *   - `workdir`     -> symlink to the main checkout's (~20G, built for
 *                      concurrent container access, so sharing is correct).
 *                      This is also what supplies the plugins: main's
 *                      `workdir/plugins` is itself a symlink to a local
 *                      archie-plugins checkout, so linking `workdir` whole
 *                      gets the configured agents and their repos for free.
 *   - `claude-data`  -> symlink to the main checkout's.
 *   - `secrets/`     -> a REAL recursive copy, merged entry by entry.
 *                      `Dockerfile.dev` does `COPY secrets/ /tmp/ca-src/` and
 *                      Docker's build context does not follow a symlink at the
 *                      context root, so a symlinked `secrets` fails the build
 *                      with `"/secrets": not found`. Bind mounts DO follow host
 *                      symlinks, which is why `workdir`/`claude-data` are fine.
 *   - `.env`         -> copied from the main checkout with `PORT` rewritten to a
 *                      free port (main's 3000 is usually held by another
 *                      checkout's container, and the archie-debug MCP resolves
 *                      its URL once at spawn, so an explicit free port is one
 *                      less thing to reconcile).
 *
 * Why linking `workdir` matters beyond convenience: the channel store is what
 * makes announce-once work, so an instance booted on an empty `workdir`
 * re-announces every `Archie…` canvas into the real Slack channel on first
 * contact — a live, user-visible post caused purely by test setup. An empty
 * `workdir` also does not fail the boot (`ARCHIE_PLUGINS` is unset in local dev
 * and `initWorkdir` only checks the directory exists): the instance comes up
 * healthy with ZERO agents, and the first symptom is a repo-change scenario
 * where the PM never requests edit mode — which reads like a product bug.
 *
 * Pure cores (mainCheckoutFrom, planPreparation, rewritePort, renderPlan) take
 * plain inputs and are unit-tested; main does the disk work.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { createServer, type AddressInfo } from 'net';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { makeExec, type ExecFn } from './exec.js';

/** Names that never make a `secrets/` directory "real" — they are placeholders and OS litter. */
const SECRETS_PLACEHOLDERS = new Set(['.gitkeep', '.DS_Store']);

// ---- Tree state ----

export type EntryKind = 'absent' | 'symlink' | 'empty-dir' | 'dir' | 'file';

export interface TreeState {
  workdir: EntryKind;
  claudeData: EntryKind;
  secrets: EntryKind;
  /** Entries present in the main checkout's `secrets/` but missing from this one (placeholders excluded). */
  secretsMissing: string[];
  dotenv: EntryKind;
  /** Main checkout's `.env` content, when readable — the source for the copy. */
  mainDotenv?: string;
  /** False when the worktree has no `node_modules` — a note, not a blocker. */
  nodeModules: boolean;
}

// ---- Pure cores ----

/**
 * Resolve the main checkout from `git rev-parse --path-format=absolute --git-common-dir`.
 * In a worktree the common dir is `<main>/.git`; in the main checkout it is this
 * repo's own `.git`, which yields `repoRoot` — reported as "not a worktree".
 */
export function mainCheckoutFrom(gitCommonDirAbsolute: string, repoRoot: string): { kind: 'worktree'; main: string } | { kind: 'main-checkout' } {
  const trimmed = gitCommonDirAbsolute.trim().replace(/\/+$/, '');
  if (!trimmed) return { kind: 'main-checkout' };
  const main = trimmed.endsWith('/.git') ? dirname(trimmed) : trimmed;
  const normalize = (p: string) => p.replace(/\/+$/, '');
  return normalize(main) === normalize(repoRoot) ? { kind: 'main-checkout' } : { kind: 'worktree', main };
}

/** Replace the `PORT=` line with `port`, or append one when the file has none. */
export function rewritePort(dotenvText: string, port: string): string {
  if (/^\s*PORT\s*=/m.test(dotenvText)) {
    return dotenvText.replace(/^\s*PORT\s*=.*$/m, `PORT=${port}`);
  }
  const sep = dotenvText.endsWith('\n') || dotenvText === '' ? '' : '\n';
  return `${dotenvText}${sep}\n# Set by tools/e2e/prepare-worktree.ts — a free port for this worktree's instance\nPORT=${port}\n`;
}

export type Action =
  | { kind: 'link'; path: 'workdir' | 'claude-data'; from: string }
  | { kind: 'copy-secrets'; from: string; entries: string[]; replacesSymlink: boolean }
  | { kind: 'write-env'; from: string; port: string };

export interface PreparePlan {
  actions: Action[];
  /** Already-correct or deliberately-untouched state, and advisories. */
  notes: string[];
  /** Conditions the operator must resolve by hand; a non-empty list means nothing is applied. */
  errors: string[];
}

/**
 * Decide what to create. Non-destructive by construction: existing symlinks and
 * populated directories are left alone, and an existing `.env` is never rewritten
 * (its PORT is the operator's choice). The one replacement is a symlinked
 * `secrets/`, which cannot work at all — Docker's build context won't follow it.
 */
export function planPreparation(state: TreeState, main: string, freePort: string): PreparePlan {
  const actions: Action[] = [];
  const notes: string[] = [];
  const errors: string[] = [];

  for (const [label, kind] of [
    ['workdir', state.workdir],
    ['claude-data', state.claudeData],
  ] as const) {
    if (kind === 'absent' || kind === 'empty-dir') {
      actions.push({ kind: 'link', path: label, from: join(main, label) });
    } else if (kind === 'symlink') {
      notes.push(`${label}: already a symlink — left as is.`);
    } else if (kind === 'dir') {
      notes.push(
        `${label}: a real non-empty directory in this worktree — left as is. It is NOT shared with the main checkout, so this instance has its own history; ` +
          `remove it and re-run to share main's instead.`,
      );
    } else {
      errors.push(`${label} exists as a file — remove it and re-run.`);
    }
  }

  if (state.secrets === 'file') {
    errors.push('secrets exists as a file — remove it and re-run.');
  } else if (state.secretsMissing.length > 0 || state.secrets === 'symlink') {
    actions.push({
      kind: 'copy-secrets',
      from: join(main, 'secrets'),
      entries: state.secretsMissing,
      replacesSymlink: state.secrets === 'symlink',
    });
  } else {
    notes.push('secrets/: a real directory holding every entry found in the main checkout’s — left as is.');
  }

  if (state.dotenv === 'absent') {
    if (state.mainDotenv === undefined) {
      errors.push(
        `no .env here and none readable at ${join(main, '.env')} — copy .env.example, set ANTHROPIC_API_KEY and a free PORT by hand.`,
      );
    } else {
      actions.push({ kind: 'write-env', from: join(main, '.env'), port: freePort });
    }
  } else if (state.dotenv === 'file') {
    notes.push('.env: already present — left as is (its PORT is yours to choose).');
  } else {
    errors.push('.env exists but is not a regular file — remove it and re-run.');
  }

  if (!state.nodeModules) {
    notes.push('node_modules is absent — run `npm install` before the suite (the boot itself builds inside Docker and does not need it).');
  }

  return { actions, notes, errors };
}

export function renderPlan(plan: PreparePlan): string[] {
  const lines: string[] = [];
  for (const a of plan.actions) {
    if (a.kind === 'link') lines.push(`link   ${a.path} -> ${a.from}`);
    else if (a.kind === 'copy-secrets') {
      const what = a.entries.length > 0 ? a.entries.join(', ') : '(nothing missing)';
      lines.push(`copy   secrets/ from ${a.from}${a.replacesSymlink ? ' (replacing a symlink — Docker cannot build through one)' : ''}: ${what}`);
    } else lines.push(`write  .env from ${a.from} with PORT=${a.port}`);
  }
  return lines;
}

// ---- Disk (impure) ----

export interface PrepareIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

function classify(path: string): EntryKind {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 'absent';
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return readdirSync(path).filter((n) => n !== '.DS_Store').length === 0 ? 'empty-dir' : 'dir';
  return 'file';
}

/** Can this process bind `port` on all interfaces, the way docker's publish does? */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

/** Neighbourhood scanned for a worktree's port — near main's 3000, and far from the OS's ephemeral range. */
export const PORT_SCAN_RANGE = { from: 3001, to: 3099 } as const;

/**
 * Choose the port to write into a new `.env`. Scans 3001-3099 for a free one
 * rather than taking an OS-assigned ephemeral port: the .env is written once and
 * may be booted much later, and a 5-digit ephemeral port is exactly what the OS
 * hands to some other process in the meantime. Falls back to an OS-picked port
 * if the whole range is busy (boot.ts relocates off a taken port anyway).
 */
async function choosePort(): Promise<number> {
  for (let port = PORT_SCAN_RANGE.from; port <= PORT_SCAN_RANGE.to; port++) {
    if (await isPortFree(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function readTreeState(repoRoot: string, main: string): TreeState {
  const secrets = classify(join(repoRoot, 'secrets'));
  let secretsMissing: string[] = [];
  try {
    const mainEntries = readdirSync(join(main, 'secrets')).filter((n) => !SECRETS_PLACEHOLDERS.has(n));
    secretsMissing =
      secrets === 'symlink'
        ? mainEntries
        : mainEntries.filter((n) => !existsSync(join(repoRoot, 'secrets', n)));
  } catch {
    secretsMissing = [];
  }

  let mainDotenv: string | undefined;
  try {
    mainDotenv = readFileSync(join(main, '.env'), 'utf-8');
  } catch {
    mainDotenv = undefined;
  }

  return {
    workdir: classify(join(repoRoot, 'workdir')),
    claudeData: classify(join(repoRoot, 'claude-data')),
    secrets,
    secretsMissing,
    dotenv: classify(join(repoRoot, '.env')),
    mainDotenv,
    nodeModules: classify(join(repoRoot, 'node_modules')) !== 'absent',
  };
}

function applyPlan(plan: PreparePlan, repoRoot: string, state: TreeState, io: PrepareIo): void {
  for (const a of plan.actions) {
    const dest = join(repoRoot, a.kind === 'link' ? a.path : a.kind === 'copy-secrets' ? 'secrets' : '.env');
    if (a.kind === 'link') {
      // A previous boot may have left an empty directory squatting on the name.
      // `classify` already proved it empty (planPreparation only links over
      // 'absent' or 'empty-dir'), and rmdirSync refuses a non-empty directory —
      // so a stale race can never take data with it. `classify` treats a lone
      // `.DS_Store` as empty, so clear that first or rmdirSync sees ENOTEMPTY.
      if (classify(dest) === 'empty-dir') {
        for (const litter of readdirSync(dest)) unlinkSync(join(dest, litter));
        rmdirSync(dest);
      }
      symlinkSync(a.from, dest);
      io.log(`linked   ${a.path} -> ${a.from}`);
    } else if (a.kind === 'copy-secrets') {
      if (a.replacesSymlink) {
        rmSync(dest, { force: true });
        io.log('removed  the secrets symlink (Docker cannot build through one)');
      }
      mkdirSync(dest, { recursive: true });
      for (const entry of a.entries) {
        cpSync(join(a.from, entry), join(dest, entry), { recursive: true, force: false, errorOnExist: false });
      }
      io.log(`copied   secrets/ entries: ${a.entries.length > 0 ? a.entries.join(', ') : '(none missing)'}`);
    } else {
      writeFileSync(dest, rewritePort(state.mainDotenv ?? '', a.port), { mode: 0o600 });
      io.log(`wrote    .env from ${a.from} with PORT=${a.port}`);
    }
  }
}

export interface PrepareResult {
  code: number;
  /** Free port written into a new `.env`, when one was written. */
  port?: string;
}

/**
 * Prepare the current checkout when it is a worktree. Returns 0 both when it
 * prepared something and when there was nothing to do (including in the main
 * checkout) — being already-ready is a success, so callers like boot.ts can
 * invoke this unconditionally.
 */
export async function runPrepare(
  repoRoot: string,
  exec: ExecFn,
  io: PrepareIo,
  opts: { printPlanOnly?: boolean } = {},
): Promise<PrepareResult> {
  const commonDir = await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonDir.code !== 0) {
    io.error(`git rev-parse --git-common-dir failed (exit ${commonDir.code}): ${commonDir.stderr.trim() || '(no stderr)'}`);
    return { code: 1 };
  }

  const where = mainCheckoutFrom(commonDir.stdout, repoRoot);
  if (where.kind === 'main-checkout') {
    io.log('Not a worktree — this is the main checkout; nothing to prepare.');
    return { code: 0 };
  }

  const state = readTreeState(repoRoot, where.main);
  const plan = planPreparation(state, where.main, String(await choosePort()));

  if (plan.errors.length > 0) {
    io.error(`Cannot prepare this worktree (main checkout: ${where.main}):`);
    for (const e of plan.errors) io.error(`  - ${e}`);
    return { code: 1 };
  }

  if (opts.printPlanOnly) {
    io.log(`Worktree of ${where.main}. Planned actions:`);
    const rendered = renderPlan(plan);
    for (const line of rendered.length > 0 ? rendered : ['(nothing — already prepared)']) io.log(`  ${line}`);
    for (const n of plan.notes) io.log(`  note: ${n}`);
    return { code: 0 };
  }

  if (plan.actions.length === 0) {
    io.log(`Worktree of ${where.main} — already prepared for the E2E harness.`);
  } else {
    io.log(`Preparing this worktree for the E2E harness (main checkout: ${where.main}) ...`);
    applyPlan(plan, repoRoot, state, io);
  }
  for (const n of plan.notes) io.log(`note: ${n}`);

  const written = plan.actions.find((a): a is Extract<Action, { kind: 'write-env' }> => a.kind === 'write-env');
  io.log('Harness prerequisites satisfied — `npx tsx tools/e2e/boot.ts` can boot this worktree.');
  return written ? { code: 0, port: written.port } : { code: 0 };
}

// ---- CLI main ----

export function parseArgs(argv: string[]): { printPlanOnly: boolean } {
  let printPlanOnly = false;
  for (const arg of argv) {
    if (arg === '--print-plan') printPlanOnly = true;
    else throw new Error(`unknown argument: ${arg} (usage: npx tsx tools/e2e/prepare-worktree.ts [--print-plan])`);
  }
  return { printPlanOnly };
}

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let printPlanOnly: boolean;
  try {
    printPlanOnly = parseArgs(process.argv.slice(2)).printPlanOnly;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const result = await runPrepare(
    repoRoot,
    makeExec({ cwd: repoRoot }),
    { log: (line) => console.log(line), error: (line) => console.error(line) },
    { printPlanOnly },
  );
  process.exit(result.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
