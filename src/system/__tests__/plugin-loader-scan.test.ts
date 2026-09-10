/**
 * Plugin Loader — directory enumeration and the root `archie.json`.
 *
 * The two things the loader still owns now that the SDK loads plugin contents
 * natively: which directories of the plugins repo count as plugins (a valid
 * `.claude-plugin/plugin.json` and nothing else is required — the SDK reads
 * what is inside), and the engine-level config at the repo root.
 *
 * `archie.json`'s flags are strict-boolean on purpose: `autoMerge` decides
 * whether a merge skips its human approval, so a YAML/JSON typo must fail
 * safe rather than opt a repo in.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

const { PLUGINS_DIR, TEST_ROOT } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'archie-plugin-scan-test-'));
  return { TEST_ROOT: root, PLUGINS_DIR: join(root, 'plugins') };
});

vi.mock('../workdir.js', () => ({ PLUGINS_DIR }));

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { initPlugins, getPlugins, getArchieConfig } from '../plugin-loader.js';

function writePlugin(dirName: string, manifest: unknown): void {
  const dir = join(PLUGINS_DIR, dirName);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
}

function writeArchieJson(contents: string): void {
  writeFileSync(join(PLUGINS_DIR, 'archie.json'), contents);
}

beforeEach(() => {
  rmSync(PLUGINS_DIR, { recursive: true, force: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('plugin directory enumeration', () => {
  it('returns every directory carrying a valid manifest, keyed by manifest name', () => {
    writePlugin('engineering', { name: 'engineering', version: '1.0.0', description: 'eng' });
    writePlugin('growth', { name: 'growth', version: '2.0.0', description: 'growth' });

    initPlugins();
    const plugins = getPlugins();
    expect(plugins.map((p) => p.name).sort()).toEqual(['engineering', 'growth']);
    expect(plugins.find((p) => p.name === 'growth')!.dir).toBe(join(PLUGINS_DIR, 'growth'));
  });

  it('skips a directory with no manifest, an unparseable one, or missing fields', () => {
    mkdirSync(join(PLUGINS_DIR, 'no-manifest'), { recursive: true });
    mkdirSync(join(PLUGINS_DIR, 'broken', '.claude-plugin'), { recursive: true });
    writeFileSync(join(PLUGINS_DIR, 'broken', '.claude-plugin', 'plugin.json'), '{ not json');
    writePlugin('incomplete', { name: 'incomplete' });
    writePlugin('ok', { name: 'ok', version: '1.0.0', description: 'fine' });

    initPlugins();
    expect(getPlugins().map((p) => p.name)).toEqual(['ok']);
  });

  it('does not need agents/, skills/ or hooks/ — the SDK reads those itself', () => {
    writePlugin('bare', { name: 'bare', version: '1.0.0', description: 'nothing but a manifest' });

    initPlugins();
    expect(getPlugins()).toHaveLength(1);
  });
});

describe('getArchieConfig', () => {
  it('is empty when archie.json is absent', () => {
    expect(getArchieConfig()).toEqual({ allowedNetworkDomains: [], repos: {} });
  });

  it('is empty when archie.json is unparseable', () => {
    writeArchieJson('{ definitely not json');
    expect(getArchieConfig()).toEqual({ allowedNetworkDomains: [], repos: {} });
  });

  it('reads the network allowlist and per-repo flags', () => {
    writeArchieJson(JSON.stringify({
      allowedNetworkDomains: ['sheets.googleapis.com', 'oauth2.googleapis.com'],
      repos: {
        'org/mobile': { warm: true, autoMerge: true },
        'org/backend': { warm: true },
      },
    }));

    const config = getArchieConfig();
    expect(config.allowedNetworkDomains).toEqual(['sheets.googleapis.com', 'oauth2.googleapis.com']);
    expect(config.repos['org/mobile']).toEqual({ warm: true, autoMerge: true });
    expect(config.repos['org/backend']).toEqual({ warm: true, autoMerge: false });
  });

  it('fails safe on a non-boolean flag', () => {
    writeArchieJson(JSON.stringify({
      repos: { 'org/mobile': { autoMerge: 'true', warm: 1 } },
    }));

    expect(getArchieConfig().repos['org/mobile']).toEqual({ warm: false, autoMerge: false });
  });

  it('drops non-string domains and a non-object repos map', () => {
    writeArchieJson(JSON.stringify({ allowedNetworkDomains: ['ok.example', 42, ''], repos: [] }));

    expect(getArchieConfig()).toEqual({ allowedNetworkDomains: ['ok.example'], repos: {} });
  });
});
