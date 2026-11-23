/**
 * Settings of a live run: the eval instances the providers may drive and the
 * spend cap. run.ts takes them from its command line, opens its network block
 * for exactly these instances, and hands them to the live providers through
 * one environment variable, so a config file cannot name another target.
 */

import { resolve } from 'path';
import { z } from 'zod';

export const LIVE_SETTINGS_ENV = 'ARCHIE_EVAL_LIVE';

export interface EvalInstance {
  /** `http://<loopback host>:<port>`, as `boot.ts --profile eval` prints it. */
  url: string;
  /** The checkout the instance was booted from; its task folders are read from there. */
  checkout: string;
}

export interface LiveSettings {
  instances: Record<string, EvalInstance>;
  spendCapUsd: number;
}

const settingsSchema = z.object({
  instances: z.record(z.string(), z.object({ url: z.string(), checkout: z.string() })),
  spendCapUsd: z.number().positive(),
});

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];
const LABEL = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Parse one `--instance <label>=<url>,<checkout>` value. */
export function parseInstanceOption(value: string): { label: string; instance: EvalInstance } {
  const match = /^([^=]+)=([^,]+),(.+)$/.exec(value);
  const [, label, url, checkout] = match ?? [];
  if (!label || !url || !checkout) {
    throw new Error(`--instance expects <label>=<url>,<checkout>, got "${value}"`);
  }
  if (!LABEL.test(label)) throw new Error(`instance label "${label}" must be a plain name`);
  return { label, instance: { url: parseInstanceUrl(url), checkout: resolve(checkout) } };
}

/** An eval instance listens on this machine: plain HTTP, a loopback host and an explicit port. */
function parseInstanceUrl(text: string): string {
  const expected = `instance URL must look like http://localhost:<port>, got "${text}"`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(expected);
  }
  const isBareOrigin =
    url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.includes(url.hostname) ||
    !url.port ||
    !isBareOrigin
  ) {
    throw new Error(expected);
  }
  return `http://${url.hostname}:${url.port}`;
}

export function parseSpendCap(value: string): number {
  const capUsd = Number(value);
  if (!value.trim() || !Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(`--spend-cap-usd expects a positive number of dollars, got "${value}"`);
  }
  return capUsd;
}

/** `host:port` entries that exempt the instances, and nothing else, from the closed proxy. */
export function noProxyEntries(settings: LiveSettings): string[] {
  return Object.values(settings.instances).map((instance) => new URL(instance.url).host);
}

export function encodeLiveSettings(settings: LiveSettings): string {
  return JSON.stringify(settings);
}

/** The settings run.ts exported, or undefined when the run is not a live one. */
export function readLiveSettings(env: NodeJS.ProcessEnv): LiveSettings | undefined {
  const encoded = env[LIVE_SETTINGS_ENV];
  if (!encoded) return undefined;
  return settingsSchema.parse(JSON.parse(encoded));
}
