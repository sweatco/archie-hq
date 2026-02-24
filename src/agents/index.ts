/**
 * Re-export all agents
 */

export { triageSlackMessage, triageGitHubComment } from './triage.js';
export { AGENT_PROMPTS } from './prompts.js';

// New unified modules
export { spawnAgent } from './spawn.js';
export { Agent } from './agent.js';
export {
  initRegistry,
  scanAgentDefs,
  getAllAgentDefs,
  getAgentIds,
  getRepoAgentIds,
  getAgentDef,
  getAgentDefByGithubRepo,
  getPmDef,
  buildPeerList,
} from './registry.js';
export {
  createPMAgentMcpServer,
  createBaseAgentMcpServer,
  type PRStatus,
  type PRReview,
  type PRReviewComment,
  type MergeableState,
} from './tools.js';

// Legacy shim (still used by server.ts, event-handler.ts, merge-orchestrator.ts)
export { getRepoConfig, getAllRepoConfigs, getAllRepoAgentIds } from './repo-configs.js';
