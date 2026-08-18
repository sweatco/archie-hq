/**
 * Live egress boundary probe — runs INSIDE the archie container.
 *
 * Copied in and executed by tools/e2e/egress-check.ts; not meant to be run by
 * hand. It imports the real /app/src/agents/sandbox.ts (src is bind-mounted, so
 * this exercises the code under test) and spawns one throwaway sandboxed agent
 * with exactly the options spawn.ts uses, then reports two verdicts on stdout:
 *
 *   EGRESS_DENIED_HOST=<blocked|reachable>   a host NOT on the allowlist
 *   EGRESS_ALLOWED_HOST=<blocked|reachable>  a host ON the allowlist
 *
 * Both directions matter. "denied blocked" alone can be achieved by breaking
 * egress entirely; "allowed reachable" alone is the regression we shipped for
 * six weeks. The check passes only when the filter discriminates.
 *
 * The agent shape is the edit-mode repo agent (the widest egress any agent
 * gets), so a pass here bounds every other agent.
 */

import { dirname } from 'node:path';
import { query } from '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import {
  buildSandboxConfig,
  buildManagedNetworkPolicy,
  buildPackageManagerCacheEnv,
  TRUSTED_PACKAGE_REGISTRY_DOMAINS,
} from '/app/src/agents/sandbox.ts';

/** Not on any allowlist. Chosen because it is stable, unrelated to our stack, and safe to hit. */
const DENIED_HOST = 'https://example.com';
/** On the edit-mode allowlist. Reachability proves the filter allows, not just denies. */
const ALLOWED_HOST = `https://${TRUSTED_PACKAGE_REGISTRY_DOMAINS[0]}/npm`;

const WORKSPACE = '/tmp/egress-check-ws';

// Package-manager caches live in one shared directory outside the workspace, so
// the probe's sandbox has to allow writing there or step 3 fails on EROFS for a
// reason that has nothing to do with the network. Derived from the env builder
// rather than hardcoded: this file is outside `tsconfig.json`'s `src/**/*`
// include, so a drifting cache location is not a type error here — it is a
// silent PKG=failed. Reading the path back from the function keeps the two in
// step by construction.
const cacheEnv = buildPackageManagerCacheEnv();
const CACHE_ROOT = dirname(cacheEnv.npm_config_cache);

const sandboxOpts = {
  cwd: WORKSPACE,
  allowReadPaths: [WORKSPACE],
  // allowWrite only — a path in both lists loses its rw mount (see sandbox.ts).
  allowWritePaths: [WORKSPACE, CACHE_ROOT],
  allowedNetworkDomains: [...TRUSTED_PACKAGE_REGISTRY_DOMAINS],
};

const prompt = `Run these commands with the Bash tool, one call each, and report their raw output verbatim. Run ALL of them even if an earlier one fails.
1. curl -sS -m 10 -o /dev/null -w 'DENIED=%{http_code}\\n' ${DENIED_HOST} || echo 'DENIED=blocked'
2. curl -sS -m 10 -o /dev/null -w 'ALLOWED=%{http_code}\\n' ${ALLOWED_HOST} || echo 'ALLOWED=blocked'
3. rm -rf ${WORKSPACE}/pkg && mkdir -p ${WORKSPACE}/pkg && cd ${WORKSPACE}/pkg && npm init -y >/dev/null && (npm install left-pad --no-audit --no-fund >/dev/null 2>&1 && test -f node_modules/left-pad/package.json && echo 'PKG=ok' || echo 'PKG=failed')
4. test -n "$YARN_HTTPS_PROXY" && echo 'YARNPROXY=mapped' || echo 'YARNPROXY=unset'`;

// Mirrors src/agents/spawn.ts buildQueryOptions for everything that bears on the
// sandbox boundary: permissionMode, sandbox, managedSettings, settingSources.
const it = query({
  prompt,
  options: {
    model: 'claude-haiku-4-5-20251001',
    cwd: WORKSPACE,
    executable: 'node' as const,
    settingSources: ['project'] as never,
    env: {
      NODE_ENV: 'development',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SHELL: '/bin/bash',
      // Same cache redirection spawn.ts applies — without it npm dies on the
      // read-only $HOME and step 3 fails for a reason unrelated to the network.
      ...cacheEnv,
      // Same as spawn.ts: maps the sandbox proxy onto Yarn Berry's own config keys.
      ...(process.env.BASH_ENV ? { BASH_ENV: process.env.BASH_ENV } : {}),
      ...(process.env.NODE_USE_SYSTEM_CA ? { NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA } : {}),
      ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
    },
    maxTurns: 8,
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    sandbox: buildSandboxConfig(sandboxOpts),
    managedSettings: buildManagedNetworkPolicy(sandboxOpts),
    disallowedTools: ['WebSearch', 'WebFetch'],
  },
});

/**
 * A host counts as reachable only on an explicit 2xx/3xx/4xx/5xx status line —
 * an HTTP response came back, so the proxy let it through. Anything else (curl
 * exit non-zero, our `|| echo blocked` fallback, a 000 status) is blocked.
 * Deliberately conservative in the direction of reporting "reachable": a
 * misparse must not turn an open boundary into a pass.
 */
function classify(transcript: string, label: string): 'blocked' | 'reachable' | 'unknown' {
  const status = transcript.match(new RegExp(`${label}=(\\d{3})`));
  if (status && status[1] !== '000') return 'reachable';
  if (new RegExp(`${label}=(blocked|000)`).test(transcript)) return 'blocked';
  return 'unknown';
}

let transcript = '';
let cliVersion = 'unknown';

for await (const m of it as AsyncIterable<Record<string, any>>) {
  if (m.type === 'system' && m.subtype === 'init') {
    cliVersion = String(m.claude_code_version ?? 'unknown');
  } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b.type === 'tool_result') {
        transcript += (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) + '\n';
      }
    }
  } else if (m.type === 'result') {
    transcript += String(m.result ?? '') + '\n';
  }
}

/** npm install counts as working only on an explicit PKG=ok from the agent's shell. */
function packageInstall(t: string): 'ok' | 'failed' | 'unknown' {
  if (/PKG=ok/.test(t)) return 'ok';
  if (/PKG=failed/.test(t)) return 'failed';
  return 'unknown';
}

console.log(`CLI_VERSION=${cliVersion}`);
console.log(`EGRESS_DENIED_HOST=${classify(transcript, 'DENIED')}`);
console.log(`EGRESS_ALLOWED_HOST=${classify(transcript, 'ALLOWED')}`);
console.log(`EGRESS_PKG_INSTALL=${packageInstall(transcript)}`);
console.log(`EGRESS_YARN_PROXY=${/YARNPROXY=mapped/.test(transcript) ? 'mapped' : 'unset'}`);
console.log('---- agent transcript ----');
console.log(transcript.trim());
