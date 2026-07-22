import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { LoadedRunnerConfig, RunnerConfig } from './types.js';

const cidrSchema = z.string().refine((value) => {
  const [address, prefix, extra] = value.split('/');
  if (extra !== undefined || !address || prefix === undefined || !/^\d+$/.test(prefix)) return false;
  const family = isIP(address);
  const bits = Number(prefix);
  return family === 4 && bits <= 32;
}, 'Expected an IPv4 CIDR');

export const runnerProfileSchema = z.object({
  image: z.string().regex(/^[^\s@]+@sha256:[a-fA-F0-9]{64}$/, 'Runner images must be pinned by sha256 digest'),
  os: z.enum(['darwin', 'linux']).default('darwin'),
  cpu: z.number().int().min(1).max(64).default(4),
  memoryMiB: z.number().int().min(1024).max(262144).default(8192),
  diskGiB: z.number().int().min(10).max(2048).default(100),
  username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/i).default('admin'),
  passwordEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  allowedAgents: z.array(z.string().min(1)).min(1),
  labels: z.record(z.string(), z.string()).default({}),
  resources: z.record(z.string(), z.number().int().nonnegative()).default({}),
  softnetAllow: z.array(cidrSchema).default([]),
  readinessCommand: z.array(z.string()).min(1).optional(),
  remoteWorkspaceRoot: z.string().refine((value) => value.startsWith('/') && !value.includes('\n') && !value.includes('\0'), 'Expected an absolute guest path').optional(),
  leaseTtlMinutes: z.number().int().min(1).max(10080).default(120),
  debugTtlMinutes: z.number().int().min(1).max(1440).default(30),
  maxDebugTtlMinutes: z.number().int().min(1).max(1440).default(120),
  execTimeoutSeconds: z.number().int().min(1).max(86400).default(3600),
  provisionTimeoutSeconds: z.number().int().min(10).max(3600).default(900),
  readinessTimeoutSeconds: z.number().int().min(1).max(1800).default(300),
  maxExecWaitSeconds: z.number().int().min(1).max(120).default(30),
  maxExecOutputBytes: z.number().int().min(1024).max(1073741824).default(10485760),
  maxUploadBytes: z.number().int().min(1024).max(10737418240).default(2147483648),
  maxDownloadBytes: z.number().int().min(1024).max(10737418240).default(1073741824),
}).strict().superRefine((profile, ctx) => {
  if (profile.debugTtlMinutes > profile.maxDebugTtlMinutes) {
    ctx.addIssue({ code: 'custom', path: ['debugTtlMinutes'], message: 'Must not exceed maxDebugTtlMinutes' });
  }
  if (new Set(profile.allowedAgents).size !== profile.allowedAgents.length) {
    ctx.addIssue({ code: 'custom', path: ['allowedAgents'], message: 'Agent IDs must be unique' });
  }
});

export const runnerConfigSchema = z.object({
  version: z.literal(1),
  instanceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  maxConcurrent: z.number().int().min(1).max(100).default(1),
  orphanGraceMinutes: z.number().int().min(1).max(1440).default(30),
  reaperIntervalSeconds: z.number().int().min(10).max(3600).default(60),
  orchard: z.object({
    baseUrl: z.url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), 'Expected an HTTP(S) URL'),
    context: z.string().min(1),
  }).strict(),
  profiles: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), runnerProfileSchema),
}).strict().refine((config) => Object.keys(config.profiles).length > 0, {
  path: ['profiles'],
  message: 'At least one runner profile is required',
});

export async function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): Promise<LoadedRunnerConfig | null> {
  const configPath = env.ARCHIE_RUNNERS_CONFIG;
  if (!configPath) return null;

  const raw = await readFile(resolve(configPath), 'utf8');
  const parsed = runnerConfigSchema.parse(JSON.parse(raw)) as RunnerConfig;
  parsed.orchard.baseUrl = parsed.orchard.baseUrl.replace(/\/+$/, '');

  const serviceAccountName = env.ORCHARD_SERVICE_ACCOUNT_NAME;
  const serviceAccountToken = env.ORCHARD_SERVICE_ACCOUNT_TOKEN;
  if (!serviceAccountName || !serviceAccountToken) {
    throw new Error('ORCHARD_SERVICE_ACCOUNT_NAME and ORCHARD_SERVICE_ACCOUNT_TOKEN are required when runners are enabled');
  }

  const guestPasswords: Record<string, string> = {};
  for (const [name, profile] of Object.entries(parsed.profiles)) {
    const password = env[profile.passwordEnv];
    if (!password) throw new Error(`Runner profile "${name}" requires ${profile.passwordEnv}`);
    guestPasswords[name] = password;
  }

  return { config: parsed, serviceAccountName, serviceAccountToken, guestPasswords };
}

export function profileWorkspaceRoot(profile: RunnerConfig['profiles'][string]): string {
  if (profile.remoteWorkspaceRoot) return profile.remoteWorkspaceRoot.replace(/\/+$/, '');
  return profile.os === 'darwin' ? `/Users/${profile.username}/archie` : `/home/${profile.username}/archie`;
}
