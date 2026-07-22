import { logger } from '../system/logger.js';
import { loadRunnerConfig } from './config.js';
import { RunnerManager } from './manager.js';
import { OrchardRunnerProvider } from './orchard-provider.js';
import type { RunnerHealth } from './types.js';
import { getAllAgentDefs } from '../agents/registry.js';
import { isRepoAgent } from '../types/agent.js';

let manager: RunnerManager | null = null;

export async function initRunners(): Promise<void> {
  const loaded = await loadRunnerConfig();
  if (!loaded) {
    logger.system('Runners: disabled (ARCHIE_RUNNERS_CONFIG is not set)');
    return;
  }
  const repoAgentIds = new Set(getAllAgentDefs().filter(isRepoAgent).map((agent) => agent.id));
  for (const [profileName, profile] of Object.entries(loaded.config.profiles)) {
    for (const agentId of profile.allowedAgents) {
      if (!repoAgentIds.has(agentId)) throw new Error(`Runner profile "${profileName}" references unknown repository agent "${agentId}"`);
    }
  }
  const provider = new OrchardRunnerProvider(
    loaded.config.orchard.baseUrl,
    loaded.serviceAccountName,
    loaded.serviceAccountToken,
  );
  manager = new RunnerManager(loaded, provider);
  await manager.initialize();
  const health = manager.health();
  logger.system(`Runners: enabled (${Object.keys(loaded.config.profiles).length} profile(s), ${health.activeLeases} active lease(s))`);
}

export function getRunnerManager(): RunnerManager | null {
  return manager;
}

export function getRunnerHealth(): RunnerHealth {
  return manager?.health() ?? { enabled: false, degraded: false, activeLeases: 0 };
}

export async function completeTaskRunners(taskId: string): Promise<void> {
  if (!manager) return;
  await manager.completeTask(taskId);
}

export function shutdownRunners(): void {
  manager?.shutdown();
}

export function resetRunnersForTests(): void {
  manager?.shutdown();
  manager = null;
}
