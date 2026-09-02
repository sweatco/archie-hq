/**
 * capabilities.ts — gathers PM skill/team descriptions, summarises them (`summariseCapabilities`, comprehension.ts) into a voice-safe blurb, once per meeting.
 *
 * Every failure resolves to '', never throws.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import matter from 'gray-matter';
import { PLUGINS_DIR } from '../system/workdir.js';
import { logger } from '../system/logger.js';
import { isPmAgent } from '../types/agent.js';
import { Task } from '../tasks/task.js';
import { summariseCapabilities } from './comprehension.js';
import type { VoiceConfig } from './types.js';

const LOG = 'voice-capabilities';

function pmSkillsDir(): string {
  return join(PLUGINS_DIR, 'pm', 'skills');
}

// gray-matter (also used by plugin-loader.ts): `description` may be a bare line, quoted string, or `>` block scalar.
async function readSkillDescriptions(): Promise<string[]> {
  const dir = pmSkillsDir();
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    logger.warn(LOG, `Could not list PM skills at ${dir} — this meeting starts with no capability block`, err);
    return [];
  }

  const descriptions: string[] = [];
  for (const name of entries) {
    try {
      const raw = await readFile(join(dir, name, 'SKILL.md'), 'utf-8');
      const description = (matter(raw).data as { description?: unknown }).description;
      if (typeof description === 'string' && description.trim().length > 0) {
        descriptions.push(description.trim());
      }
    } catch (err) {
      // Common (no SKILL.md) — not warn-worthy at meeting-join volume.
      logger.debug(LOG, `Skipped skill ${name}: ${String(err)}`);
    }
  }
  return descriptions;
}

// Reads from the task, not the PM registry (getPmDef()): the team can include spawned agents the registry lacks. Same lookup as spawn.ts.
async function readPmSelfDescription(taskId: string): Promise<{ teamExpertise: string; pmIntegrations: string }> {
  try {
    const task = await Task.get(taskId);
    const pmConfig = task.team.find(isPmAgent)?.pmConfig;
    return {
      teamExpertise: pmConfig?.teamExpertise ?? '',
      pmIntegrations: pmConfig?.pmIntegrations ?? '',
    };
  } catch (err) {
    logger.warn(LOG, `Could not read the team description for task ${taskId} — the capability summary will cover skills only`, err);
    return { teamExpertise: '', pmIntegrations: '' };
  }
}

// Caller (startMeeting, recall/index.ts) doesn't await this — a model call mustn't delay the room join. Result reaches Meeting via setCapabilities whenever it lands.
export async function buildCapabilitySummary(cfg: VoiceConfig, taskId: string): Promise<string> {
  try {
    const [skills, self] = await Promise.all([readSkillDescriptions(), readPmSelfDescription(taskId)]);
    return await summariseCapabilities(cfg, {
      skills,
      teamExpertise: self.teamExpertise,
      pmIntegrations: self.pmIntegrations,
    });
  } catch (err) {
    // Backstop: the calls above catch their own errors, but an unhandled rejection here takes down every other task and meeting.
    logger.warn(LOG, `Could not build the capability summary for task ${taskId} — this meeting runs without one`, err);
    return '';
  }
}
