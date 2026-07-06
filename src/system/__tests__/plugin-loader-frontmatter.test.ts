/**
 * Plugin Loader — agent frontmatter parsing tests.
 *
 * Exercises scanPlugins() (via initPlugins/getPlugins) against real plugin
 * fixtures written to a temp PLUGINS_DIR. Focused on the repo-entry fields,
 * in particular the strict-boolean `autoMerge` parse: only the YAML literal
 * `true` may enable auto-merge — anything else fails safe to `false`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

const { PLUGINS_DIR, PLUGINS_DATA_DIR, TEST_ROOT } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'archie-frontmatter-test-'));
  return {
    TEST_ROOT: root,
    PLUGINS_DIR: join(root, 'plugins'),
    PLUGINS_DATA_DIR: join(root, 'plugins-data'),
  };
});

vi.mock('../workdir.js', () => ({ PLUGINS_DIR, PLUGINS_DATA_DIR }));

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { initPlugins, getPlugins } from '../plugin-loader.js';

function writeAgentPlugin(name: string, frontmatter: string): void {
  const dir = join(PLUGINS_DIR, name);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', description: 'test plugin' }),
  );
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'dev.md'), `---\n${frontmatter}\n---\nAgent body.\n`);
}

function loadSingleAgentRepos() {
  initPlugins();
  const plugins = getPlugins();
  expect(plugins).toHaveLength(1);
  expect(plugins[0].agents).toHaveLength(1);
  return plugins[0].agents[0].repo!;
}

describe('agent frontmatter repo parsing — autoMerge', () => {
  beforeEach(() => {
    rmSync(PLUGINS_DIR, { recursive: true, force: true });
    mkdirSync(PLUGINS_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('parses autoMerge: true on a plural repos entry', () => {
    writeAgentPlugin('eng', [
      'role: Backend',
      'expertise: Node',
      'metadata:',
      '  archie:',
      '    repos:',
      '      - github: org/backend',
      '        baseBranch: main',
      '        autoMerge: true',
    ].join('\n'));

    const repo = loadSingleAgentRepos();
    expect(repo.repos).toEqual([{ github: 'org/backend', baseBranch: 'main', autoMerge: true }]);
  });

  it('defaults autoMerge to false when absent', () => {
    writeAgentPlugin('eng', [
      'role: Backend',
      'expertise: Node',
      'metadata:',
      '  archie:',
      '    repos:',
      '      - github: org/backend',
    ].join('\n'));

    const repo = loadSingleAgentRepos();
    expect(repo.repos[0].autoMerge).toBe(false);
  });

  it('fails safe to false on a string "true"', () => {
    writeAgentPlugin('eng', [
      'role: Backend',
      'expertise: Node',
      'metadata:',
      '  archie:',
      '    repos:',
      '      - github: org/backend',
      '        autoMerge: "true"',
    ].join('\n'));

    const repo = loadSingleAgentRepos();
    expect(repo.repos[0].autoMerge).toBe(false);
  });

  it('fails safe to false on a numeric 1', () => {
    writeAgentPlugin('eng', [
      'role: Backend',
      'expertise: Node',
      'metadata:',
      '  archie:',
      '    repos:',
      '      - github: org/backend',
      '        autoMerge: 1',
    ].join('\n'));

    const repo = loadSingleAgentRepos();
    expect(repo.repos[0].autoMerge).toBe(false);
  });

  it('migrates autoMerge from the legacy singular repo shape', () => {
    writeAgentPlugin('eng', [
      'role: Backend',
      'expertise: Node',
      'metadata:',
      '  archie:',
      '    repo:',
      '      github: org/backend',
      '      baseBranch: develop',
      '      autoMerge: true',
    ].join('\n'));

    const repo = loadSingleAgentRepos();
    expect(repo.primary).toBe('org/backend');
    expect(repo.repos).toEqual([{ github: 'org/backend', baseBranch: 'develop', autoMerge: true }]);
  });

  it('legacy singular shape without autoMerge defaults to false', () => {
    writeAgentPlugin('eng', [
      'role: Backend',
      'expertise: Node',
      'metadata:',
      '  archie:',
      '    repo:',
      '      github: org/backend',
    ].join('\n'));

    const repo = loadSingleAgentRepos();
    expect(repo.repos[0].autoMerge).toBe(false);
  });
});
