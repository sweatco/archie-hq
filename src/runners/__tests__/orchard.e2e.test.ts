import { describe, expect, it } from 'vitest';
import { loadRunnerConfig } from '../config.js';
import { RunnerManager } from '../manager.js';
import { OrchardRunnerProvider } from '../orchard-provider.js';

const e2e = process.env.ARCHIE_ORCHARD_E2E === 'true' ? it : it.skip;

describe('real Orchard runner', () => {
  e2e('provisions, syncs, executes, reconnects, exposes VNC handoff, and deletes the VM', async () => {
    const loaded = await loadRunnerConfig();
    if (!loaded) throw new Error('ARCHIE_RUNNERS_CONFIG is required');
    const profile = process.env.ARCHIE_ORCHARD_E2E_PROFILE;
    const agentId = process.env.ARCHIE_ORCHARD_E2E_AGENT;
    const repoPath = process.env.ARCHIE_ORCHARD_E2E_REPO_PATH;
    const github = process.env.ARCHIE_ORCHARD_E2E_GITHUB ?? 'e2e/local';
    if (!profile || !agentId || !repoPath) throw new Error('ARCHIE_ORCHARD_E2E_PROFILE, ARCHIE_ORCHARD_E2E_AGENT, and ARCHIE_ORCHARD_E2E_REPO_PATH are required');

    const commands = process.env.ARCHIE_ORCHARD_E2E_COMMANDS
      ? JSON.parse(process.env.ARCHIE_ORCHARD_E2E_COMMANDS) as string[][]
      : [
          ['/usr/bin/xcodebuild', '-version'],
          ['/usr/bin/xcrun', 'simctl', 'list', 'devices', 'available'],
          ['/usr/bin/xcrun', 'lldb', '--batch', '-o', 'version'],
        ];
    const provider = new OrchardRunnerProvider(loaded.config.orchard.baseUrl, loaded.serviceAccountName, loaded.serviceAccountToken);
    const manager = new RunnerManager(loaded, provider);
    const taskId = `task-e2e-${Date.now()}`;
    let backendId: string | undefined;
    try {
      const lease = await manager.ensure(taskId, agentId, profile);
      backendId = lease.backendId;
      await manager.sync(taskId, agentId, profile, github, repoPath);
      for (const command of commands) {
        const result = await manager.exec(taskId, agentId, profile, github, command);
        expect(result.state).toBe('completed');
        expect(result.exitCode).toBe(0);
      }

      const detached = await manager.exec(taskId, agentId, profile, github, ['/bin/sh', '-lc', 'sleep 2; echo reconnected'], '.', {}, 0);
      expect(detached.state).toBe('running');
      const reconnected = await manager.poll(taskId, agentId, profile, detached.execId, 10);
      expect(reconnected.state).toBe('completed');
      expect(reconnected.stdout).toContain('reconnected');

      const debug = await manager.openDebug(taskId, agentId, profile, 1);
      expect(debug.commands).toHaveLength(2);
      expect(debug.commands[1]).toContain(backendId);
    } finally {
      await manager.release(taskId, agentId, profile).catch(() => {});
      manager.shutdown();
    }
    expect(backendId).toBeDefined();
    await expect(provider.inspect(backendId!)).resolves.toBeNull();
  }, 30 * 60 * 1000);
});
