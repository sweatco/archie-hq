import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRunnerConfig } from '../config.js';
import { RunnerManager } from '../manager.js';
import { OrchardRunnerProvider } from '../orchard-provider.js';
import { generateTaskId } from '../../tasks/persistence.js';
import type { RunnerSpec } from '../types.js';
import { canaryCommands, finishCommand } from './orchard-canary-helpers.js';

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
    const endpoints = [publicEndpoint, blockedHostEndpoint, blockedIpv6Endpoint];
    // Validate before control-side requests and before provisioning any VM.
    canaryCommands([], endpoints);
    for (const endpoint of endpoints) {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Control-side endpoint is not reachable: ${endpoint} (${response.status})`);
    }

    const workload = process.env.ARCHIE_ORCHARD_E2E_COMMANDS
      ? JSON.parse(process.env.ARCHIE_ORCHARD_E2E_COMMANDS) as string[][]
      : [
          ['/usr/bin/xcodebuild', '-version'],
          ['/usr/bin/xcrun', 'lldb', '--version'],
          ['/bin/sh', '-lc', 'set -eu\ndevice="$(xcrun simctl list devices available | awk -F "[()]" "/iPhone/{print \\$2; exit}")"\ntest -n "$device"\ntrap \'xcrun simctl shutdown "$device" >/dev/null 2>&1 || true\' EXIT\nxcrun simctl boot "$device"\nxcrun simctl bootstatus "$device" -b'],
        ];
    const commands = canaryCommands(workload, endpoints);
    // Record intent before the request: provisioning may create a VM and then throw.
    const attemptedBackendIds = new Set<string>();
    class CanaryProvider extends OrchardRunnerProvider {
      override async provision(spec: RunnerSpec) {
        attemptedBackendIds.add(spec.id);
        return super.provision(spec);
      }
    }
    const provider = new CanaryProvider(
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
    const deadline = Date.now() + 25 * 60_000;
    const signal = AbortSignal.timeout(25 * 60_000);
    const remaining = () => {
      signal.throwIfAborted();
      const milliseconds = deadline - Date.now();
      if (milliseconds <= 0) throw new Error('Canary lifecycle deadline exceeded');
      return milliseconds;
    };
    try {
      const lease = await manager.ensure(taskId, agentId, profile);
      backendId = lease.backendId;
      remaining();
      await manager.sync(taskId, agentId, profile, github, repoPath, signal);
      const finish = (start: () => ReturnType<RunnerManager['exec']>) => {
        const timeout = Math.min(remaining(), loaded.config.profiles[profile].execTimeoutSeconds * 1000, 20 * 60_000);
        return finishCommand(
          start(),
          (execId, cursor) => manager.poll(taskId, agentId, profile, execId, cursor, 30),
          timeout,
        );
      };
      const assertSuccess = (result: Awaited<ReturnType<typeof finish>>) => {
        expect(result.state).toBe('completed');
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.truncated).toBe(false);
      };
      for (const command of commands) {
        assertSuccess(await finish(() => manager.exec(taskId, agentId, profile, github, command)));
      }

      const debug = await manager.openDebug(taskId, agentId, profile, 1);
      expect(debug.backendId).toBe(backendId);
      expect(debug.context).toBe(loaded.config.orchard.context);
      expect(Date.parse(debug.expiresAt)).toBeGreaterThan(Date.now());
      expect(debug.commands).toContain(`orchard vnc vm '${backendId}'`);
      expect(debug.commands.some((command) => command.startsWith('orchard context default '))).toBe(true);

      const artifactContent = `archie-e2e-${Date.now()}`;
      const artifactCommand = await finish(() => manager.exec(taskId, agentId, profile, github, ['/bin/sh', '-c', 'printf %s "$1" > archie-e2e-artifact.txt', 'canary-artifact', artifactContent]));
      assertSuccess(artifactCommand);
      const artifactDir = await manager.collect(taskId, agentId, profile, github, ['archie-e2e-artifact.txt'], signal);
      await expect(readFile(join(artifactDir, 'archie-e2e-artifact.txt'), 'utf8')).resolves.toBe(artifactContent);

      remaining();
      const detached = await manager.exec(taskId, agentId, profile, github, ['/bin/sh', '-lc', 'sleep 2; echo reconnected'], '.', {}, 0);
      expect(detached.state).toBe('running');
      const reconnected = await finish(() => Promise.resolve(detached));
      assertSuccess(reconnected);
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
      if (backendId) attemptedBackendIds.add(backendId);
      for (const id of attemptedBackendIds) {
        try {
          // Normal manager release gets first attempt; fallback covers failed ensure/release.
          if (await provider.inspect(id)) {
            cleanupErrors.push(new Error(`Manager release left canary VM behind: ${id}`));
            await provider.release(id);
          }
          expect(await provider.inspect(id), `leftover VM: ${id}`).toBeNull();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        const leftovers = (await provider.list()).filter((instance) => attemptedBackendIds.has(instance.id));
        expect(leftovers, `leftover VMs: ${leftovers.map((vm) => vm.id).join(', ')}`).toHaveLength(0);
      } catch (error) {
        cleanupErrors.push(error);
      }
      manager.shutdown();
      if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Runner lifecycle or cleanup failed');
    }
    expect(backendId).toBeDefined();
  // Provider/provisioning have their own bounds; commands and transfers share a
  // lifecycle deadline. A Vitest timeout would abandon this function before its
  // finally cleanup, so let bounded operations settle and release the VM here.
  }, 0);
});
