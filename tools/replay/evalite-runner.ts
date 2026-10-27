// SPDX-License-Identifier: AGPL-3.0-or-later
import { runEvalite } from 'evalite/runner';
import { createInMemoryStorage } from 'evalite/in-memory-storage';
import { exportStaticUI } from 'evalite/export-static';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Evalite can exit on runner errors; the parent persists completeness and required gates independently.
const storage = createInMemoryStorage();
try {
  await runEvalite({ path: 'tools/replay/episodes.eval.ts', mode: 'run-once-and-exit', disableServer: true,
    storage, outputPath: join(process.env.REPLAY_OUT!, 'evalite.json') });
} finally {
  let error: string | null = null;
  try { await exportStaticUI({ storage, outputPath: join(process.env.REPLAY_OUT!, 'report') }); }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  try { await writeFile(join(process.env.REPLAY_OUT!, 'report-status.json'), JSON.stringify({ error })); }
  finally { await storage.close(); }
}
