/** Return only a safe Slack API code; raw error details may contain credentials. */
export function slackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('data' in error)) return undefined;
  const data = error.data;
  if (!data || typeof data !== 'object' || !('error' in data)) return undefined;
  const code = data.error;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined;
}
