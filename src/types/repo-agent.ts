/**
 * Repo Agent configuration type
 *
 * Defines the specialization for a repository agent.
 * All repo agents share the same behavior/prompt structure,
 * just with different expertise and repository assignments.
 */

export interface RepoAgentConfig {
  /** Unique agent identifier, e.g., 'backend-agent', 'mobile-agent' */
  agentId: string;

  /** Key in TaskMetadata.repositories, e.g., 'backend', 'mobile' */
  repoKey: string;

  /** Default repository path if not specified in task metadata */
  defaultRepoPath: string;

  /** Short role description, used in peer agent list, e.g., 'Senior Ruby on Rails engineer' */
  role: string;

  /** Detailed expertise, used in agent's own prompt, e.g., 'APIs, databases, authentication, background jobs' */
  expertise: string;

  /** GitHub repository identifier, e.g., 'sweatco/backend' */
  githubRepo: string;

  /** Base branch for PRs and merges, e.g., 'main', 'master', 'develop'. Defaults to 'main' if not specified. */
  baseBranch?: string;

  /** Layer 3 agent prompt body from plugins/<name>/agents/<key>.md (domain-specific instructions) */
  agentPrompt?: string;

  /** Plugin name this agent belongs to, e.g., 'engineering' */
  pluginName: string;
}
