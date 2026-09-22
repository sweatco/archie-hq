/**
 * The PM overlay — `pm.md` at the plugins repository root.
 *
 * One file a deployment owns without touching the engine: frontmatter decides
 * the PM's model and effort, the body says what this instance is and rides at
 * the end of its system prompt. The precedence it sits in is the point of these
 * cases — an operator's ARCHIE_PM_* on the process is a decision about THIS
 * instance and must outrank whatever the plugins repo happens to say, while the
 * built-in defaults are only what is left when neither speaks.
 *
 * Read on every call rather than cached, so an edit lands on the next task.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { LoadedMcpConfig, ArchieConfig } from '../../system/plugin-loader.js';

const { PLUGINS_DIR, TEST_ROOT } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'archie-pm-overlay-test-'));
  return { TEST_ROOT: root, PLUGINS_DIR: join(root, 'plugins') };
});

vi.mock('../../system/workdir.js', () => ({ PLUGINS_DIR }));

vi.mock('../../system/plugin-loader.js', () => ({
  getRootMcpConfig: vi.fn(),
  getArchieConfig: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { getRootMcpConfig, getArchieConfig } from '../../system/plugin-loader.js';
import { logger } from '../../system/logger.js';
import { readPmOverlay, appendDeploymentContext, scanPmDef } from '../registry.js';

const ROOT_MCP: LoadedMcpConfig = { servers: {}, descriptions: {}, policies: {} };
const ARCHIE_CONFIG: ArchieConfig = { allowedNetworkDomains: [], repos: {} };

const PM_ENV = ['ARCHIE_PM_MODEL', 'ARCHIE_PM_EFFORT', 'ARCHIE_PM_MAX_MODEL', 'ARCHIE_PM_MAX_EFFORT'];

function writePmMd(contents: string): void {
  writeFileSync(join(PLUGINS_DIR, 'pm.md'), contents);
}

beforeEach(() => {
  vi.mocked(getRootMcpConfig).mockReturnValue(ROOT_MCP);
  vi.mocked(getArchieConfig).mockReturnValue(ARCHIE_CONFIG);
  vi.mocked(logger.warn).mockClear();
  for (const key of PM_ENV) delete process.env[key];
  rmSync(PLUGINS_DIR, { recursive: true, force: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
});

afterAll(() => {
  for (const key of PM_ENV) delete process.env[key];
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('pm.md precedence', () => {
  it('falls back to the engine defaults when there is no file', () => {
    const def = scanPmDef();

    expect(def.model).toBe('opus');
    expect(def.effort).toBe('medium');
    expect(def.maxMode).toEqual({ model: 'claude-fable-5-1', effort: 'high' });
  });

  it('lets pm.md override the defaults', () => {
    writePmMd('---\nmodel: sonnet\neffort: high\nmaxMode:\n  model: claude-opus-5\n  effort: xhigh\n---\n\nBody.\n');

    const def = scanPmDef();

    expect(def.model).toBe('sonnet');
    expect(def.effort).toBe('high');
    expect(def.maxMode).toEqual({ model: 'claude-opus-5', effort: 'xhigh' });
  });

  it('lets the environment override pm.md', () => {
    writePmMd('---\nmodel: sonnet\neffort: high\nmaxMode:\n  model: claude-opus-5\n  effort: xhigh\n---\n');
    process.env.ARCHIE_PM_MODEL = 'haiku';
    process.env.ARCHIE_PM_EFFORT = 'low';
    process.env.ARCHIE_PM_MAX_MODEL = 'claude-fable-5-1';
    process.env.ARCHIE_PM_MAX_EFFORT = 'max';

    const def = scanPmDef();

    expect(def.model).toBe('haiku');
    expect(def.effort).toBe('low');
    expect(def.maxMode).toEqual({ model: 'claude-fable-5-1', effort: 'max' });
  });

  it('takes each field independently — pm.md still decides what the env leaves unset', () => {
    writePmMd('---\nmodel: sonnet\neffort: xhigh\n---\n');
    process.env.ARCHIE_PM_MODEL = 'haiku';

    const def = scanPmDef();

    expect(def.model).toBe('haiku');
    expect(def.effort).toBe('xhigh');
  });

  it('ignores an effort that names no real level, rather than pinning the PM to a fallback', () => {
    writePmMd('---\nmodel: sonnet\neffort: turbo\n---\n');

    const def = scanPmDef();

    expect(def.model).toBe('sonnet');
    expect(def.effort).toBe('medium');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('re-reads the file on every scan, so an edit lands without a restart', () => {
    writePmMd('---\nmodel: sonnet\n---\n');
    expect(scanPmDef().model).toBe('sonnet');

    writePmMd('---\nmodel: haiku\n---\n');
    expect(scanPmDef().model).toBe('haiku');
  });
});

describe('pm.md body', () => {
  it('appends the body to the system prompt under a final Deployment context heading', () => {
    writePmMd('---\nmodel: opus\n---\n\nArchie runs for the Sweatcoin platform team.\n');

    const prompt = appendDeploymentContext('SYSTEM PROMPT');

    expect(prompt).toBe('SYSTEM PROMPT\n\n# Deployment context\n\nArchie runs for the Sweatcoin platform team.');
  });

  it('takes the whole file as body when there is no frontmatter', () => {
    writePmMd('Archie runs for the Sweatcoin platform team.\n');

    expect(readPmOverlay().body).toBe('Archie runs for the Sweatcoin platform team.');
    expect(readPmOverlay().model).toBeUndefined();
  });

  it('is a no-op when the file is missing', () => {
    expect(readPmOverlay()).toEqual({ body: '' });
    expect(appendDeploymentContext('SYSTEM PROMPT')).toBe('SYSTEM PROMPT');
  });

  it('is a no-op when the file carries frontmatter and nothing else', () => {
    writePmMd('---\nmodel: sonnet\n---\n');

    expect(appendDeploymentContext('SYSTEM PROMPT')).toBe('SYSTEM PROMPT');
  });

  it('warns and keeps the file as body when the frontmatter does not parse', () => {
    writePmMd('---\nmodel: [unclosed\n  effort: "high\n---\n\nStill worth reading.\n');

    const prompt = appendDeploymentContext('SYSTEM PROMPT');

    expect(prompt).toContain('# Deployment context');
    expect(prompt).toContain('Still worth reading.');
    expect(logger.warn).toHaveBeenCalled();
    // The definition falls back to the defaults rather than half-applying a broken file.
    expect(scanPmDef().model).toBe('opus');
  });
});
