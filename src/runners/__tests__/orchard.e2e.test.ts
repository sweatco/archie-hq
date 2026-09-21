import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRunnerConfig } from '../config.js';
import { RunnerManager } from '../manager.js';
import { OrchardRunnerProvider } from '../orchard-provider.js';
import { generateTaskId } from '../../tasks/persistence.js';

const e2e = process.env.ARCHIE_ORCHARD_E2E === 'true' ? it : it.skip;

describe('real Orchard runner', () => {
  e2e('provisions, syncs, executes Xcode, collects an artifact, reconnects, and deletes the VM', async () => {
    const loaded = await loadRunnerConfig();
    if (!loaded) throw new Error('ARCHIE_RUNNERS_CONFIG is required');
    const profile = process.env.ARCHIE_ORCHARD_E2E_PROFILE;
    const agentId = process.env.ARCHIE_ORCHARD_E2E_AGENT;
    const repoPath = process.env.ARCHIE_ORCHARD_E2E_REPO_PATH;
    const github = process.env.ARCHIE_ORCHARD_E2E_GITHUB ?? 'e2e/local';
    const publicEndpoint = process.env.ARCHIE_ORCHARD_E2E_PUBLIC_ENDPOINT;
    const blockedHostEndpoint = process.env.ARCHIE_ORCHARD_E2E_BLOCKED_HOST_ENDPOINT;
    const blockedIpv6Endpoint = process.env.ARCHIE_ORCHARD_E2E_BLOCKED_IPV6_ENDPOINT;
    if (!profile || !agentId || !repoPath) throw new Error('ARCHIE_ORCHARD_E2E_PROFILE, ARCHIE_ORCHARD_E2E_AGENT, and ARCHIE_ORCHARD_E2E_REPO_PATH are required');
    if (!publicEndpoint || !blockedHostEndpoint || !blockedIpv6Endpoint) {
      throw new Error('ARCHIE_ORCHARD_E2E_PUBLIC_ENDPOINT, ARCHIE_ORCHARD_E2E_BLOCKED_HOST_ENDPOINT, and ARCHIE_ORCHARD_E2E_BLOCKED_IPV6_ENDPOINT are required');
    }
    for (const endpoint of [publicEndpoint, blockedHostEndpoint, blockedIpv6Endpoint]) {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Control-side endpoint is not reachable: ${endpoint} (${response.status})`);
    }

    const commands = process.env.ARCHIE_ORCHARD_E2E_COMMANDS
      ? JSON.parse(process.env.ARCHIE_ORCHARD_E2E_COMMANDS) as string[][]
      : [
          ['/usr/bin/xcodebuild', '-version'],
          ['/bin/sh', '-lc', 'device="$(xcrun simctl list devices available | awk -F "[()]" "/iPhone/{print \\$2; exit}")"; test -n "$device"; xcrun simctl boot "$device"; xcrun simctl bootstatus "$device" -b; xcrun simctl shutdown "$device"'],
          ['/usr/bin/curl', '-fsS', '--max-time', '15', publicEndpoint],
          ['/bin/sh', '-lc', `! /usr/bin/curl -fsS --max-time 5 ${JSON.stringify(blockedHostEndpoint)}`],
          ['/bin/sh', '-lc', `! /usr/bin/curl -gfsS --max-time 5 ${JSON.stringify(blockedIpv6Endpoint)}`],
        ];
    const provider = new OrchardRunnerProvider(
      loaded.config.orchard.baseUrl,
      loaded.serviceAccountName,
      loaded.serviceAccountToken,
      30000,
      loaded.accessClientId,
      loaded.accessClientSecret,
    );
    const manager = new RunnerManager(loaded, provider);
    const taskId = generateTaskId();
    let backendId: string | undefined;
    let failure: unknown;
    try {
      const lease = await manager.ensure(taskId, agentId, profile);
      backendId = lease.backendId;
      await manager.sync(taskId, agentId, profile, github, repoPath);
      for (const command of commands) {
        const result = await manager.exec(taskId, agentId, profile, github, command);
        expect(result.state).toBe('completed');
        expect(result.exitCode).toBe(0);
      }

      const artifactContent = `archie-e2e-${Date.now()}`;
      const artifactCommand = await manager.exec(taskId, agentId, profile, github, ['/bin/sh', '-lc', `printf %s ${JSON.stringify(artifactContent)} > archie-e2e-artifact.txt`]);
      expect(artifactCommand.exitCode).toBe(0);
      const artifactDir = await manager.collect(taskId, agentId, profile, github, ['archie-e2e-artifact.txt']);
      await expect(readFile(join(artifactDir, 'archie-e2e-artifact.txt'), 'utf8')).resolves.toBe(artifactContent);

      const detached = await manager.exec(taskId, agentId, profile, github, ['/bin/sh', '-lc', 'sleep 2; echo reconnected'], '.', {}, 0);
      expect(detached.state).toBe('running');
      const reconnected = await manager.poll(taskId, agentId, profile, detached.execId, detached.cursor, 10);
      expect(reconnected.state).toBe('completed');
      expect(reconnected.stdout).toContain('reconnected');

    } catch (error) {
      failure = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await manager.release(taskId, agentId, profile);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (backendId) {
        try {
          expect(await provider.inspect(backendId)).toBeNull();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        const leftovers = (await provider.list()).filter((instance) => instance.id.startsWith(`archie-${loaded.config.instanceId}-`) && instance.id === backendId);
        expect(leftovers, `leftover VMs: ${leftovers.map((vm) => vm.id).join(', ')}`).toHaveLength(0);
      } catch (error) {
        cleanupErrors.push(error);
      }
      manager.shutdown();
      if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Runner lifecycle or cleanup failed');
    }
    expect(backendId).toBeDefined();
  }, 30 * 60 * 1000);
});
