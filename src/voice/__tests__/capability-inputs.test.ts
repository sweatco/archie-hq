// Real SKILL.md files: 3 description shapes (bare, quoted, `>` block) — only the real parser catches a missed one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// vi.hoisted required: imports hoist above plain statements; ARCHIE_WORKDIR would else be set after workdir.js reads env.
const WORK = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'voice-capabilities-'));
  process.env.ARCHIE_WORKDIR = dir;
  return dir as string;
});

vi.mock('../../utils/prompt-loader.js', () => ({ loadPrompt: async () => 'CAPABILITIES PROMPT' }));

const { taskGet } = vi.hoisted(() => ({ taskGet: vi.fn() }));
vi.mock('../../tasks/task.js', () => ({ Task: { get: taskGet } }));

import { logger } from '../../system/logger.js';
import { buildCapabilitySummary } from '../capabilities.js';
import type { VoiceConfig } from '../types.js';

const cfg: VoiceConfig = {
  recallApiKey: 'recall-key',
  recallRegion: 'eu-central-1',
  deepgramApiKey: 'd',
  sonioxApiKey: 'soniox-key',
  cerebrasApiKey: 'cerebras-key',
  publicUrl: 'https://archie.example',
};
const SKILLS_DIR = join(WORK, 'plugins', 'pm', 'skills');

const sentUserMessages: string[] = [];

function stubModel(reply = '- Look up numbers in the analytics warehouse'): void {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    // messages[0] is the system prompt; the user half is second.
    sentUserMessages.push(body.messages[1].content);
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: reply } }] };
      },
      async text() {
        return reply;
      },
    };
  });
}

function writeSkill(name: string, contents: string): void {
  mkdirSync(join(SKILLS_DIR, name), { recursive: true });
  writeFileSync(join(SKILLS_DIR, name, 'SKILL.md'), contents);
}

function taskWithPm(teamExpertise: string, pmIntegrations: string): void {
  taskGet.mockResolvedValue({
    team: [
      { id: 'backend-agent', pluginName: 'engineering', visibility: 'global' },
      { id: 'pm-agent', isPm: true, pluginName: 'pm', visibility: 'global', pmConfig: { teamList: 'x', teamExpertise, pmIntegrations } },
    ],
  });
}

beforeEach(() => {
  rmSync(SKILLS_DIR, { recursive: true, force: true });
  sentUserMessages.length = 0;
  taskGet.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildCapabilitySummary — gathering the inputs', () => {
  it('reads a description in each of the three shapes the real skills use', async () => {
    writeSkill('data-analytics', '---\nname: data-analytics\ndescription: Use when someone asks a Sweatcoin data question.\n---\n\nBody.\n');
    writeSkill('qa-team', '---\nname: qa-team\ndescription: "Coordinating QA work. Use when the task involves testing."\n---\n\nBody.\n');
    writeSkill(
      'ci-failure-diagnosis',
      '---\nname: ci-failure-diagnosis\ndescription: >\n  Auto-diagnose a failed mobile RC build when Tramline posts an alert.\n  Classify transient-vs-real with confidence tiers.\n---\n\nBody.\n',
    );
    taskWithPm('- backend-agent: APIs', 'You can also query these external systems yourself directly: notion (docs).');
    stubModel();

    await buildCapabilitySummary(cfg, 'task-shapes');

    expect(sentUserMessages).toHaveLength(1);
    const sent = sentUserMessages[0];
    expect(sent).toContain('Use when someone asks a Sweatcoin data question.');
    expect(sent).toContain('Coordinating QA work. Use when the task involves testing.');
    expect(sent).toContain('Auto-diagnose a failed mobile RC build when Tramline posts an alert.');
    expect(sent).toContain('Classify transient-vs-real with confidence tiers.');
  });

  it('carries the PM roster strings through as their own sources', async () => {
    writeSkill('one', '---\ndescription: A thing.\n---\n');
    taskWithPm('- mobile-agent: Mobile UI/UX', 'You can also query these external systems yourself directly: rollbar (errors).');
    stubModel();

    await buildCapabilitySummary(cfg, 'task-roster');

    expect(sentUserMessages[0]).toContain('<team>\n- mobile-agent: Mobile UI/UX\n</team>');
    expect(sentUserMessages[0]).toContain('rollbar (errors)');
  });

  it('returns the summary the model produced, verbatim', async () => {
    writeSkill('one', '---\ndescription: A thing.\n---\n');
    taskWithPm('- backend-agent: APIs', '');
    const list = ['- Look up numbers in the analytics warehouse', '- Read the code in the team repositories'].join('\n');
    stubModel(list);

    expect(await buildCapabilitySummary(cfg, 'task-verbatim')).toBe(list);
  });

  it('skips a skill directory with no SKILL.md rather than failing the set', async () => {
    writeSkill('good', '---\ndescription: A real one.\n---\n');
    mkdirSync(join(SKILLS_DIR, 'empty-dir'), { recursive: true });
    taskWithPm('- backend-agent: APIs', '');
    stubModel();

    await buildCapabilitySummary(cfg, 'task-partial');

    expect(sentUserMessages[0]).toContain('A real one.');
    expect(sentUserMessages[0]).toContain('<skills>\n- A real one.\n</skills>');
  });

  it('skips a skill whose frontmatter has no description', async () => {
    writeSkill('good', '---\ndescription: A real one.\n---\n');
    writeSkill('nameless', '---\nname: nameless\n---\n\nBody with no description.\n');
    taskWithPm('- backend-agent: APIs', '');
    stubModel();

    await buildCapabilitySummary(cfg, 'task-nodesc');

    expect(sentUserMessages[0]).toContain('<skills>\n- A real one.\n</skills>');
  });
});

describe('buildCapabilitySummary — failing safe', () => {
  it('summarises the skills alone when the task cannot be loaded, saying so', async () => {
    // Half the inputs is a worse summary, not a failed join.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    writeSkill('one', '---\ndescription: A thing.\n---\n');
    taskGet.mockRejectedValue(new Error('no such task'));
    stubModel();

    expect(await buildCapabilitySummary(cfg, 'task-gone')).not.toBe('');
    expect(sentUserMessages[0]).toContain('<team>\n(none)\n</team>');
    expect(warn.mock.calls.some((c) => String(c[1]).includes('task-gone'))).toBe(true);
  });

  it('is empty and quiet-but-logged when there is no plugins directory at all', async () => {
    // A valid state, not a fault.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    taskGet.mockResolvedValue({ team: [] });
    stubModel();

    expect(await buildCapabilitySummary(cfg, 'task-noplugins')).toBe('');
    // summariseCapabilities bails before the wire when every source is empty.
    expect(sentUserMessages).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[1]).includes('Could not list PM skills'))).toBe(true);
  });

  it('is empty when the model call fails, with the skills read successfully', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    writeSkill('one', '---\ndescription: A thing.\n---\n');
    taskWithPm('- backend-agent: APIs', '');
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 503,
      async json() {
        return {};
      },
      async text() {
        return 'upstream unavailable';
      },
    }));

    await expect(buildCapabilitySummary(cfg, 'task-modelfail')).resolves.toBe('');
  });

  it('resolves to an empty summary, whatever happens underneath', async () => {
    // The connector hands whatever this resolves to straight to the meeting, so a rejection would leave it with no capability block and no record of why.
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    writeSkill('one', '---\ndescription: A thing.\n---\n');
    taskGet.mockImplementation(() => {
      throw new Error('synchronous explosion');
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('network is on fire');
    });

    await expect(buildCapabilitySummary(cfg, 'task-boom')).resolves.toBe('');
  });
});
