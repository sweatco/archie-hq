/**
 * Claude credential resolution. Auto-detects, in priority order:
 *   1. ANTHROPIC_API_KEY        — preserves legacy behavior exactly
 *   2. CLAUDE_CODE_OAUTH_TOKEN  — subscription token (`claude setup-token`)
 * Each branch normalizes to an env fragment the spawned Claude Code CLI honors,
 * so the CLI's isolated CLAUDE_CONFIG_DIR is left untouched. Token values are
 * never logged — only the resolved kind.
 */
import { logger } from './logger.js';
import { StartupError } from './startup-error.js';

export type ClaudeCredentialKind =
  | 'api_key'
  | 'oauth_token_env'
  | 'none';

export interface ResolvedClaudeCredential {
  kind: ClaudeCredentialKind;
  env: Record<string, string>;
}

export function resolveClaudeCredential(): ResolvedClaudeCredential {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.trim()) {
    return { kind: 'api_key', env: { ANTHROPIC_API_KEY: apiKey } };
  }
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken && envToken.trim()) {
    return { kind: 'oauth_token_env', env: { CLAUDE_CODE_OAUTH_TOKEN: envToken } };
  }
  return { kind: 'none', env: {} };
}

export function claudeCredentialEnv(): Record<string, string> {
  return resolveClaudeCredential().env;
}

const KIND_LABEL: Record<ClaudeCredentialKind, string> = {
  api_key: 'api_key',
  oauth_token_env: 'oauth_token (env)',
  none: 'none',
};

export function assertClaudeCredentialAvailable(): void {
  const { kind } = resolveClaudeCredential();
  if (kind === 'none') {
    throw new StartupError(
      "No Claude credential found — Archie can't authenticate to Claude.",
      [
        'Set ONE of the following, then restart:',
        '  • CLAUDE_CODE_OAUTH_TOKEN   subscription token — run: claude setup-token',
        '  • ANTHROPIC_API_KEY         a standard Anthropic API key',
      ],
    );
  }
  logger.system(`Claude auth: ${KIND_LABEL[kind]}`);
}
