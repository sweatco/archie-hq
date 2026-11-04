import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { SESSIONS_DIR } from '../system/workdir.js';

/** The prompt's recorded parent also preserves end-turn tool results and attachments. */
export async function findRefusalCheckpoint(
  configDir: string,
  sessionId: string,
  promptUuid?: string,
): Promise<string | undefined> {
  if (!promptUuid || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return;
  // Older tasks use the shared SDK config instead of a per-task directory.
  const root = configDir === join(process.env.HOME!, '.claude')
    ? resolve(process.env.HOME!, '.claude') : resolve(SESSIONS_DIR);
  const projects = resolve(configDir, 'projects');
  if (!projects.startsWith(`${root}${sep}`)) return;
  const dirs = await readdir(projects, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let transcript: string;
    try {
      transcript = await readFile(join(projects, dir.name, `${sessionId}.jsonl`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const line of transcript.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.uuid === promptUuid) {
        return typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined;
      }
    }
  }
}
