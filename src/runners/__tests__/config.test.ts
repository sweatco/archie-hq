import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRunnerConfig, runnerConfigSchema } from '../config.js';

const digest = `ghcr.io/example/xcode@sha256:${'a'.repeat(64)}`;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function baseConfig() {
  return {
    version: 1,
    instanceId: 'archie-1',
    orchard: { baseUrl: 'https://orchard.example.test/', context: 'production' },
    profiles: {
      ios: {
        image: digest,
        passwordEnv: 'IOS_RUNNER_PASSWORD',
        allowedAgents: ['mobile-agent'],
      },
    },
  };
}

describe('runner configuration', () => {
  it('applies bounded defaults and requires digest-pinned images', () => {
    const parsed = runnerConfigSchema.parse(baseConfig());
    expect(parsed.maxConcurrent).toBe(1);
    expect(parsed.profiles.ios.memoryMiB).toBe(8192);
    expect(() => runnerConfigSchema.parse({
      ...baseConfig(),
      profiles: { ios: { ...baseConfig().profiles.ios, image: 'ghcr.io/example/xcode:latest' } },
    })).toThrow(/sha256 digest/);
    expect(() => runnerConfigSchema.parse({
      ...baseConfig(),
      profiles: { ios: { ...baseConfig().profiles.ios, softnetAllow: ['::/0'] } },
    })).toThrow(/IPv4 CIDR/);
  });

  it('loads secrets from environment without adding them to parsed config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archie-runner-config-'));
    tempDirs.push(dir);
    const path = join(dir, 'runners.json');
    await writeFile(path, JSON.stringify(baseConfig()));
    const loaded = await loadRunnerConfig({
      ARCHIE_RUNNERS_CONFIG: path,
      ORCHARD_SERVICE_ACCOUNT_NAME: 'archie',
      ORCHARD_SERVICE_ACCOUNT_TOKEN: 'service-secret',
      IOS_RUNNER_PASSWORD: 'guest-secret',
    });
    expect(loaded?.config.orchard.baseUrl).toBe('https://orchard.example.test');
    expect(loaded?.guestPasswords.ios).toBe('guest-secret');
    expect(JSON.stringify(loaded?.config)).not.toContain('secret');
  });

  it('fails enabled startup when credentials are missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archie-runner-config-'));
    tempDirs.push(dir);
    const path = join(dir, 'runners.json');
    await writeFile(path, JSON.stringify(baseConfig()));
    await expect(loadRunnerConfig({ ARCHIE_RUNNERS_CONFIG: path })).rejects.toThrow(/ORCHARD_SERVICE_ACCOUNT/);
  });

  it('is disabled when no config path is set', async () => {
    await expect(loadRunnerConfig({})).resolves.toBeNull();
  });
});
