import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** The prompt's recorded parent also preserves end-turn tool results and attachments. */
export async function findRefusalCheckpoint(
  configDir: string,
  sessionId: string,
  promptUuid?: string,
): Promise<string | undefined> {
  if (!promptUuid) return;
  const projects = join(configDir, 'projects');
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
