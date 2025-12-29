/**
 * Repository Agent Configurations
 *
 * Define all repo agent specializations here.
 * To add a new repo agent, just add an entry to the repoConfigs array.
 */

import type { RepoAgentConfig } from '../types/repo-agent.js';

export const repoConfigs: RepoAgentConfig[] = [
  {
    agentId: 'backend-agent',
    repoKey: 'backend',
    defaultRepoPath: '/repos/backend',
    role: 'Senior Ruby on Rails engineer. Expert in APIs, databases, authentication, background jobs.',
    expertise:
      'APIs, databases, business logic, infrastructure, Ruby on Rails best practices, database queries and optimization, authentication and authorization, background jobs and queues',
  },
  {
    agentId: 'mobile-agent',
    repoKey: 'mobile',
    defaultRepoPath: '/repos/mobile',
    role: 'Senior React Native engineer with Swift/Kotlin expertise. Expert in mobile UI/UX, deep linking, push notifications.',
    expertise:
      'React Native, Swift for iOS native modules, Kotlin for Android native modules, iOS and Android platform specifics, mobile UI/UX patterns, deep linking and push notifications, app store deployment, mobile performance optimization, network handling and offline support',
  },
];

/**
 * Get a repo config by agent ID
 */
export function getRepoConfig(agentId: string): RepoAgentConfig | undefined {
  return repoConfigs.find((c) => c.agentId === agentId);
}

/**
 * Get all repo configs
 */
export function getAllRepoConfigs(): RepoAgentConfig[] {
  return repoConfigs;
}

/**
 * Get all repo agent IDs
 */
export function getAllRepoAgentIds(): string[] {
  return repoConfigs.map((c) => c.agentId);
}
