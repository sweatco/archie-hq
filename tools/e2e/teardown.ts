/**
 * archie-e2e teardown — stop the instance and verify no project containers remain.
 *
 * Usage: npx tsx tools/e2e/teardown.ts [--profile eval]
 *
 * Runs `docker compose down`, then `docker compose ps --all --format json` and fails
 * non-zero naming any surviving container (`--all` so stopped-but-not-removed leftovers
 * count as survivors too). On success it prints a confirmation line suitable for
 * pasting into evidence.
 *
 * `--profile eval` targets the eval instance's compose project
 * (tools/e2e/eval-profile.ts) and, only after a clean teardown, deletes
 * `eval-instance/` with its sessions. Copy out anything you need first. The
 * directory never holds the model key, so keeping it after a failure is safe,
 * and a rerun needs nothing from it.
 *
 * Pure core: parseComposePs, unit-tested against both output shapes of
 * `docker compose ps --format json` (a JSON array, or NDJSON — one object per line).
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { EVAL_DIR, evalComposeArgs, removeEvalInstance } from './eval-profile.js';
import { makeExec, type ExecFn } from './exec.js';

// ---- ps parsing (pure) ----

export interface ComposeContainer {
  name: string;
  service: string;
  state: string;
}

export type ParsePsResult =
  { ok: true; containers: ComposeContainer[] } | { ok: false; error: string };

function toContainer(entry: unknown): ComposeContainer | string {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return `malformed compose ps entry (expected an object): ${JSON.stringify(entry)}`;
  }
  const o = entry as Record<string, unknown>;
  return {
    name: typeof o['Name'] === 'string' ? o['Name'] : '(unknown)',
    service: typeof o['Service'] === 'string' ? o['Service'] : '(unknown)',
    state: typeof o['State'] === 'string' ? o['State'] : '(unknown)',
  };
}

/**
 * Parse `docker compose ps --format json` output into the list of project containers.
 * Tolerates empty output (clean) and both the array and NDJSON shapes; a malformed
 * line is a hard parse error — teardown must not silently miss a survivor.
 */
export function parseComposePs(output: string): ParsePsResult {
  const trimmed = output.trim();
  if (!trimmed) return { ok: true, containers: [] };

  const entries: unknown[] = [];
  if (trimmed.startsWith('[')) {
    try {
      const arr: unknown = JSON.parse(trimmed);
      if (!Array.isArray(arr)) {
        return { ok: false, error: 'malformed compose ps JSON: expected an array' };
      }
      entries.push(...(arr as unknown[]));
    } catch (err) {
      return {
        ok: false,
        error: `malformed compose ps JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    for (const line of trimmed.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        return { ok: false, error: `malformed compose ps JSON line: ${line.slice(0, 200)}` };
      }
    }
  }

  const containers: ComposeContainer[] = [];
  for (const entry of entries) {
    const parsed = toContainer(entry);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    containers.push(parsed);
  }
  return { ok: true, containers };
}

// ---- Orchestration (pure core over injected deps) ----

export interface TeardownIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * compose down, then verify emptiness via compose ps --all. Returns the process exit code.
 * `composeArgs` are global compose arguments selecting the project (the eval profile's); none by default.
 */
export async function runTeardown(
  exec: ExecFn,
  io: TeardownIo,
  composeArgs: string[] = [],
): Promise<number> {
  io.log('Tearing down via `docker compose down` ...');
  const down = await exec('docker', ['compose', ...composeArgs, 'down']);
  if (down.code !== 0) {
    io.error(`docker compose down failed with exit code ${down.code}`);
    if (down.stderr.trim()) io.error(down.stderr.trim());
    return 1;
  }

  const ps = await exec('docker', ['compose', ...composeArgs, 'ps', '--all', '--format', 'json']);
  if (ps.code !== 0) {
    io.error(`docker compose ps failed with exit code ${ps.code}`);
    if (ps.stderr.trim()) io.error(ps.stderr.trim());
    return 1;
  }

  const parsed = parseComposePs(ps.stdout);
  if (!parsed.ok) {
    io.error(`could not verify teardown: ${parsed.error}`);
    return 1;
  }
  if (parsed.containers.length > 0) {
    io.error(`teardown incomplete — ${parsed.containers.length} project container(s) remain:`);
    for (const c of parsed.containers) {
      io.error(`  - ${c.name} (service=${c.service}, state=${c.state})`);
    }
    return 1;
  }

  io.log('Teardown clean: `docker compose ps --all` reports no containers for this project.');
  return 0;
}

// ---- CLI main ----

/** Exported for tests. Throws on anything but an optional `--profile eval`. */
export function parseArgs(argv: string[]): { profile?: 'eval' } {
  const joined = argv.join(' ');
  if (joined === '') return {};
  if (joined === '--profile eval' || joined === '--profile=eval') return { profile: 'eval' };
  throw new Error(
    `unknown arguments: ${joined} (usage: npx tsx tools/e2e/teardown.ts [--profile eval])`,
  );
}

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let profile: 'eval' | undefined;
  try {
    profile = parseArgs(process.argv.slice(2)).profile;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const io = {
    log: (line: string) => console.log(line),
    error: (line: string) => console.error(line),
  };
  const exec = makeExec({ cwd: repoRoot, echo: true });

  if (profile !== 'eval') process.exit(await runTeardown(exec, io));

  const code = await runTeardown(exec, io, evalComposeArgs(repoRoot));
  if (code !== 0) {
    io.error(
      `${EVAL_DIR}/ kept: a container may still be using it. It holds no model key; rerun this teardown once Docker is reachable.`,
    );
    process.exit(code);
  }
  try {
    const removed = removeEvalInstance(repoRoot);
    io.log(removed === 'removed' ? `Removed ${EVAL_DIR}/.` : `No ${EVAL_DIR}/ to remove.`);
  } catch (err) {
    // On native Linux, directories the container created belong to its user (uid 1001), so the
    // host user cannot empty them.
    io.error(
      `Could not remove ${join(repoRoot, EVAL_DIR)}: ${err instanceof Error ? err.message : String(err)}. ` +
        'Files the container wrote may belong to uid 1001; delete the directory as root. Boot never writes the model key there.',
    );
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
