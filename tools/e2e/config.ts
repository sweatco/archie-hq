/**
 * Shared config resolution for the archie-e2e harness CLIs.
 *
 * Pure functions only — CLI mains do the disk reads and pass strings in;
 * nothing here touches the filesystem or process globals.
 *
 * Base URL precedence deliberately mirrors the archie-debug MCP
 * (tools/debug-mcp/server.ts) so the harness and the MCP always agree on
 * which instance they are talking to. The MCP's resolver is not importable
 * without editing tools/debug-mcp/ (off-limits), so the ~20 lines are
 * duplicated here and pinned by tests asserting the same precedence:
 *
 *   1. ARCHIE_URL      — explicit override (e.g. a remote host)
 *   2. PORT env var    — http://localhost:$PORT
 *   3. PORT from .env  — the same file the server reads its PORT from
 *   4. http://localhost:3000
 */

export type EnvLike = Record<string, string | undefined>;

/**
 * Extract PORT from already-read .env file content.
 * Captures the value only — stops at whitespace, a quote, or an inline `#`.
 */
export function portFromDotenv(dotenvText: string | undefined): string | undefined {
  if (!dotenvText) return undefined;
  const m = dotenvText.match(/^\s*PORT\s*=\s*["']?([^\s"'#]+)/m);
  return m ? m[1] : undefined;
}

/** Resolve the Archie base URL (see precedence in the file header). */
export function resolveBaseUrl(env: EnvLike, dotenvText: string | undefined): string {
  if (env.ARCHIE_URL) return env.ARCHIE_URL;
  const port = env.PORT || portFromDotenv(dotenvText) || '3000';
  return `http://localhost:${port}`;
}

/**
 * Resolve a timeout tunable: CLI flag beats env var beats default.
 * A present-but-invalid value fails loudly rather than silently falling through.
 */
export function resolveTimeoutSeconds(
  flag: string | undefined,
  env: string | undefined,
  defaultSeconds: number,
): number {
  const parse = (raw: string, source: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`invalid timeout from ${source}: "${raw}" (expected a positive number of seconds)`);
    }
    return n;
  };
  if (flag !== undefined) return parse(flag, 'flag');
  if (env !== undefined && env !== '') return parse(env, 'env');
  return defaultSeconds;
}
