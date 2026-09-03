/**
 * Routes agents through a self-hosted Anthropic-format LLM gateway (LiteLLM).
 *
 * Gateway models keep honest provider-prefixed ids (`openai/gpt-5.6-sol`), so
 * everything Archie records names the model that answered. The CLI then treats
 * them as unrecognised, which costs only a log line: effort, thinking and
 * context_management are sent identically, while the context window and output
 * ceiling are declared explicitly below.
 *
 * Fleet mode (any ALIAS_* set) routes every agent by repointing the CLI's alias
 * table. Otherwise only models with a non-Anthropic prefix route, leaving the
 * PM on Claude.
 */

const ALIASES = [
  ['opus', 'ARCHIE_MODEL_GATEWAY_ALIAS_OPUS', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
  ['sonnet', 'ARCHIE_MODEL_GATEWAY_ALIAS_SONNET', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
  ['haiku', 'ARCHIE_MODEL_GATEWAY_ALIAS_HAIKU', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
] as const;

const stripMarker = (model: string): string => model.replace(/\[1m\]\s*$/i, '').trim();

export function isGatewayModel(model: string): boolean {
  const base = stripMarker(model);
  const slash = base.indexOf('/');
  if (slash <= 0) return false;
  return base.slice(0, slash).toLowerCase() !== 'anthropic';
}

/** Bare integer, or a `model=tokens` map for mixed tiers. */
function tokenLimit(spec: string | undefined, model: string): string | undefined {
  const trimmed = spec?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return trimmed;

  const wanted = stripMarker(model);
  for (const pair of trimmed.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() !== wanted) continue;
    const value = pair.slice(eq + 1).trim();
    if (/^\d+$/.test(value)) return value;
  }
  return undefined;
}

function aliasOverrides(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, ourVar, cliVar] of ALIASES) {
    const value = env[ourVar]?.trim();
    if (value) out[cliVar] = value;
  }
  return out;
}

/** In fleet mode the agent's string is a bare alias, so limits key off its target. */
function effectiveModel(model: string, aliases: Record<string, string>): string {
  const base = stripMarker(model).toLowerCase();
  for (const [alias, , cliVar] of ALIASES) {
    if (base === alias && aliases[cliVar]) return aliases[cliVar];
  }
  return model;
}

export function buildModelGatewayEnv(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const url = env.ARCHIE_MODEL_GATEWAY_URL?.trim();
  if (!url) return {};

  const aliases = aliasOverrides(env);
  const fleetMode = Object.keys(aliases).length > 0;
  if (!fleetMode && !isGatewayModel(model)) return {};

  const target = fleetMode ? effectiveModel(model, aliases) : model;
  const token = env.ARCHIE_MODEL_GATEWAY_TOKEN?.trim();
  const contextTokens = tokenLimit(env.ARCHIE_MODEL_GATEWAY_CONTEXT_TOKENS, target);
  const maxOutputTokens = tokenLimit(env.ARCHIE_MODEL_GATEWAY_MAX_OUTPUT_TOKENS, target);

  return {
    ANTHROPIC_BASE_URL: url,
    // Must be emptied, not omitted: the CLI reads it before ANTHROPIC_AUTH_TOKEN,
    // so a non-empty value sends the real Anthropic key to the gateway.
    ANTHROPIC_API_KEY: '',
    ...(token ? { ANTHROPIC_AUTH_TOKEN: token } : {}),
    ...aliases,
    ...(contextTokens ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: contextTokens } : {}),
    // Verify from the request's `max_tokens`; modelUsage.maxOutputTokens keeps
    // reporting the CLI's table value even when this override is in force.
    ...(maxOutputTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: maxOutputTokens } : {}),
  };
}

export function isGatewayModelWithoutGateway(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isGatewayModel(model) && !env.ARCHIE_MODEL_GATEWAY_URL?.trim();
}
