import { isIP } from 'node:net';
import type { RunnerCommandResult } from '../types.js';

/** Drain terminal output pages too: completion can precede delivery of all output. */
export async function finishCommand(
  initial: Promise<RunnerCommandResult>,
  poll: (execId: string, cursor: number) => Promise<RunnerCommandResult>,
  timeoutMs = 5 * 60_000,
): Promise<RunnerCommandResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const drain = async () => {
    let result = await initial;
    let stdout = result.stdout;
    let stderr = result.stderr;
    let truncated = result.truncated;
    let pages = 0;
    while (result.state === 'running' || result.hasMore) {
      if (expired) throw new Error('Canary command polling timed out');
      if (++pages > 10_000) throw new Error('Canary command exceeded output page limit');
      result = await poll(result.execId, result.cursor);
      stdout += result.stdout;
      stderr += result.stderr;
      truncated ||= result.truncated;
    }
    return { ...result, stdout, stderr, truncated };
  };
  try {
    return await Promise.race([
      drain(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('Canary command polling timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function canaryCommands(workload: string[][], endpoints: string[]): string[][] {
  if (endpoints.length !== 3) throw new Error('Three canary endpoints are required');
  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Canary endpoints require HTTP(S)');
  }
  const hostFamily = (endpoint: string) => isIP(new URL(endpoint).hostname.replace(/^\[|\]$/g, ''));
  if (!hostFamily(endpoints[1])) throw new Error('Blocked host endpoint must use a literal IP address');
  if (hostFamily(endpoints[2]) !== 6) throw new Error('Blocked IPv6 endpoint must use a literal IPv6 address');
  if (!Array.isArray(workload) || workload.some((command) => !Array.isArray(command) || command.length === 0 || command.some((arg) => typeof arg !== 'string'))) {
    throw new Error('Canary workload must be an array of nonempty string argv arrays');
  }
  // HTTP errors still prove connectivity. Only connection failure/timeout proves isolation.
  const blocked = `set +e; remote="$(/usr/bin/curl -gsS --connect-timeout 5 --max-time 5 --output /dev/null --write-out '%{remote_ip}' -- "$1")"; code=$?; test -z "$remote" && { test "$code" -eq 7 || test "$code" -eq 28; }`;
  return [
    ...workload,
    ['/usr/bin/curl', '-fsS', '--max-time', '15', '--', endpoints[0]],
    ...endpoints.slice(1).map((endpoint) => ['/bin/sh', '-c', blocked, 'canary-isolation', endpoint]),
  ];
}
