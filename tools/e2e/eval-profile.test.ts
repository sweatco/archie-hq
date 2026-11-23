import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  EVAL_DIR,
  evalComposeArgs,
  evalProjectName,
  findIsolationViolations,
  isCredentialName,
  needsOpenModes,
  prepareEvalInstance,
  readEffectiveSettings,
  removeEvalInstance,
  renderEffectiveSettings,
  resolveModelKey,
  runEvalPrepare,
  type EvalPrepareInput,
} from './eval-profile.js';
import type { ExecFn } from './exec.js';

const MAIN_DOTENV = [
  'SLACK_BOT_TOKEN=xoxb-main-secret',
  'SLACK_SIGNING_SECRET=main-signing-secret',
  'SLACK_APP_TOKEN=xapp-main-secret',
  'ANTHROPIC_API_KEY=sk-ant-main-key',
  'GITHUB_APP_ID=123456',
  'GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-private-key.pem',
  'GITHUB_INSTALLATION_ID=987',
  'GITHUB_WEBHOOK_SECRET=gh-webhook-secret',
  'GH_TOKEN=ghs_main_token',
  'ARCHIE_SECRETS_KEY=main-secrets-key',
  'MCP_JIRA_TOKEN=jira-secret',
  'ARCHIE_PM_MODEL=claude-haiku-5-5',
  'PORT=3000',
  '',
].join('\n');

const SECRET_VALUES = [
  'xoxb-main-secret',
  'main-signing-secret',
  'xapp-main-secret',
  '123456',
  'gh-webhook-secret',
  'ghs_main_token',
  'main-secrets-key',
  'jira-secret',
  'claude-haiku-5-5',
];

describe('evalProjectName', () => {
  const asIs = (path: string) => path;
  /** Compose's rule for project names. */
  const VALID = /^[a-z0-9][a-z0-9_-]*$/;

  it('is the checkout’s directory name, a hash of its path, and -eval', () => {
    const name = evalProjectName('/x/.claude/worktrees/festive-chatelet-62162a', asIs);
    expect(name).toMatch(/^festive-chatelet-62162a-[0-9a-f]{8}-eval$/);
    expect(evalProjectName('/x/.claude/worktrees/festive-chatelet-62162a', asIs)).toBe(name);
  });

  it('gives same-named checkouts of a paired run different projects', () => {
    const base = evalProjectName('/runs/base/archie-hq', asIs);
    const candidate = evalProjectName('/runs/candidate/archie-hq', asIs);
    expect(base).toMatch(/^archie-hq-[0-9a-f]{8}-eval$/);
    expect(candidate).toMatch(/^archie-hq-[0-9a-f]{8}-eval$/);
    expect(base).not.toBe(candidate);
  });

  it('normalises characters compose rejects', () => {
    expect(evalProjectName('/x/Feature.Branch_2', asIs)).toMatch(
      /^featurebranch_2-[0-9a-f]{8}-eval$/,
    );
    expect(evalProjectName('/x/_.hidden', asIs)).toMatch(/^hidden-[0-9a-f]{8}-eval$/);
    expect(evalProjectName('/x/...', asIs)).toMatch(/^archie-[0-9a-f]{8}-eval$/);
    for (const path of ['/x/Feature.Branch_2', '/x/_.hidden', '/x/...', '/runs/base/archie-hq']) {
      expect(evalProjectName(path, asIs)).toMatch(VALID);
    }
  });

  it('names one project however the checkout’s path is spelled, so boot and teardown agree', () => {
    const base = mkdtempSync(join(tmpdir(), 'eval-name-'));
    try {
      const real = join(base, 'archie-hq');
      mkdirSync(real);
      symlinkSync(real, join(base, 'via-link'));
      const name = evalProjectName(real);
      expect(evalProjectName(join(base, 'via-link'))).toBe(name);
      expect(evalProjectName(`${real}/`)).toBe(name);
      expect(name).toMatch(/^archie-hq-[0-9a-f]{8}-eval$/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('selects that project and the overlay on top of the base compose file', () => {
    expect(evalComposeArgs('/repos/archie-hq')).toEqual([
      '-p',
      evalProjectName('/repos/archie-hq'),
      '-f',
      'docker-compose.yml',
      '-f',
      'tools/e2e/docker-compose.eval.yml',
    ]);
  });
});

describe('resolveModelKey', () => {
  it('prefers E2E_ANTHROPIC_API_KEY, then this checkout’s .env, then the main checkout’s', () => {
    const all = {
      env: { E2E_ANTHROPIC_API_KEY: 'sk-env' },
      checkoutDotenv: 'ANTHROPIC_API_KEY=sk-checkout\n',
      mainDotenv: MAIN_DOTENV,
    };
    expect(resolveModelKey(all)).toMatchObject({ ok: true, key: 'sk-env' });
    expect(resolveModelKey({ ...all, env: {} })).toMatchObject({ ok: true, key: 'sk-checkout' });
    expect(resolveModelKey({ env: {}, mainDotenv: MAIN_DOTENV })).toEqual({
      ok: true,
      key: 'sk-ant-main-key',
      source: 'the main checkout’s .env',
    });
  });

  it('skips a source whose key is empty', () => {
    expect(
      resolveModelKey({
        env: { E2E_ANTHROPIC_API_KEY: '' },
        checkoutDotenv: 'ANTHROPIC_API_KEY=\n',
        mainDotenv: MAIN_DOTENV,
      }),
    ).toMatchObject({ ok: true, key: 'sk-ant-main-key' });
  });

  it('fails, naming every source, when no key exists', () => {
    const r = resolveModelKey({ env: {}, checkoutDotenv: 'SLACK_BOT_TOKEN=xoxb\n' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('E2E_ANTHROPIC_API_KEY');
  });

  it('refuses a mangled value without repeating it', () => {
    const r = resolveModelKey({
      env: {},
      checkoutDotenv: 'ANTHROPIC_API_KEY="sk-x\nSLACK_BOT_TOKEN=xoxb-smuggled"\n',
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('xoxb-smuggled');
  });
});

describe('needsOpenModes', () => {
  it('opens the directories only on Linux, for any host user but the container’s uid 1001', () => {
    expect(needsOpenModes({ platform: 'linux', uid: 1000 })).toBe(true);
    expect(needsOpenModes({ platform: 'linux', uid: 0 })).toBe(true);
    expect(needsOpenModes({ platform: 'linux', uid: 1001 })).toBe(false);
    expect(needsOpenModes({ platform: 'darwin', uid: 501 })).toBe(false);
    expect(needsOpenModes({ platform: 'win32' })).toBe(false);
  });
});

describe('isCredentialName', () => {
  it('counts every Slack and GitHub setting and anything named like a secret', () => {
    for (const name of [
      'SLACK_BOT_TOKEN',
      'SLACK_SIGNING_SECRET',
      'SLACK_APP_TOKEN',
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY_PATH',
      'GH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ARCHIE_SECRETS_KEY',
      'MCP_JIRA_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'DB_PASSWORD',
    ]) {
      expect(isCredentialName(name), name).toBe(true);
    }
  });

  it('leaves the base compose file’s own settings alone', () => {
    for (const name of [
      'ARCHIE_WORKDIR',
      'CLAUDE_PATH',
      'GIT_SHA',
      'NODE_ENV',
      'PORT',
      'SSH_AUTH_SOCK',
      'KEYBOARD_LAYOUT',
    ]) {
      expect(isCredentialName(name), name).toBe(false);
    }
  });
});

// ---- The instance directory, on a real filesystem ----

/** Every path under `dir` with its kind and content, to prove a tree was not touched. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out.push(`${full} -> ${readlinkSync(full)}`);
      else if (st.isDirectory()) {
        out.push(`${full}/`);
        walk(full);
      } else out.push(`${full} ${st.mtimeMs} ${readFileSync(full, 'utf-8')}`);
    }
  };
  walk(dir);
  return out;
}

/** Files under `dir` whose content contains `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && readFileSync(full, 'utf-8').includes(needle)) hits.push(full);
    }
  };
  walk(dir);
  return hits;
}

function symlinksUnder(dir: string): string[] {
  const links: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) links.push(full);
      else if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return links;
}

describe('prepareEvalInstance', () => {
  let base: string;
  let main: string;
  let worktree: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'eval-profile-'));
    main = join(base, 'main');
    worktree = join(base, 'main', '.claude', 'worktrees', 'feat');
    // A main checkout with live state, and a worktree the default profile already prepared.
    mkdirSync(join(main, 'workdir', 'sessions', 'task-1'), { recursive: true });
    writeFileSync(join(main, 'workdir', 'sessions', 'task-1', 'events.jsonl'), '{}\n');
    mkdirSync(join(main, 'claude-data'));
    writeFileSync(join(main, 'claude-data', '.claude.json'), '{"oauthAccount":"main"}\n');
    mkdirSync(join(main, 'secrets'));
    writeFileSync(join(main, 'secrets', 'github-private-key.pem'), 'PEM\n');
    writeFileSync(join(main, '.env'), MAIN_DOTENV);
    mkdirSync(worktree, { recursive: true });
    symlinkSync(join(main, 'workdir'), join(worktree, 'workdir'));
    symlinkSync(join(main, 'claude-data'), join(worktree, 'claude-data'));
    writeFileSync(join(worktree, '.env'), MAIN_DOTENV.replace('PORT=3000', 'PORT=3017'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const prepare = (extra: Partial<EvalPrepareInput> = {}) =>
    prepareEvalInstance({ repoRoot: worktree, mainCheckout: main, env: {}, ...extra });

  it('returns the model key for compose and writes no key or other credential to disk, though both source .env files carry Slack and GitHub credentials', () => {
    const r = prepare();

    expect(r).toEqual({ ok: true, key: 'sk-ant-main-key', keySource: 'this checkout’s .env' });
    const root = join(worktree, EVAL_DIR);
    expect(readdirSync(root).sort()).toEqual(['claude-data', 'secrets', 'workdir']);
    for (const value of ['sk-ant-main-key', ...SECRET_VALUES]) {
      expect(filesContaining(root, value), value).toEqual([]);
    }
  });

  it('takes the key from the main checkout’s .env when this checkout has none', () => {
    rmSync(join(worktree, '.env'));
    expect(prepare()).toEqual({
      ok: true,
      key: 'sk-ant-main-key',
      keySource: 'the main checkout’s .env',
    });
    expect(filesContaining(join(worktree, EVAL_DIR), 'sk-ant-main-key')).toEqual([]);
  });

  it('builds a fresh state of real directories — nothing links to the main checkout', () => {
    prepare();
    const root = join(worktree, EVAL_DIR);

    expect(symlinksUnder(root)).toEqual([]);
    expect(readdirSync(join(root, 'workdir'))).toEqual(['plugins']);
    expect(readdirSync(join(root, 'workdir', 'plugins'))).toEqual([]);
    expect(readdirSync(join(root, 'secrets'))).toEqual([]);
    expect(readFileSync(join(root, 'claude-data', '.claude.json'), 'utf-8')).toBe('{}\n');
  });

  it('leaves the main checkout and this checkout’s shared state exactly as they were', () => {
    const outsideEval = () =>
      snapshot(main).filter((line) => !line.startsWith(join(worktree, EVAL_DIR)));
    const before = outsideEval();

    prepare();

    expect(outsideEval()).toEqual(before);
    expect(readlinkSync(join(worktree, 'workdir'))).toBe(join(main, 'workdir'));
  });

  it('refuses, and changes nothing, when a previous eval instance was not torn down', () => {
    mkdirSync(join(worktree, EVAL_DIR, 'workdir', 'sessions', 'task-9'), { recursive: true });
    const before = snapshot(main);

    const r = prepare();

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('teardown.ts --profile eval');
    expect(snapshot(main)).toEqual(before);
  });

  it('writes nothing when no model key is found', () => {
    rmSync(join(worktree, '.env'));
    writeFileSync(join(main, '.env'), 'SLACK_BOT_TOKEN=xoxb-main-secret\n');

    const r = prepare();

    expect(r.ok).toBe(false);
    expect(readdirSync(worktree)).not.toContain(EVAL_DIR);
  });

  it('opens the state to the container’s user on Linux, and closes eval-instance/ to other host users', () => {
    prepare({ host: { platform: 'linux', uid: 1000 } });
    const root = join(worktree, EVAL_DIR);
    const mode = (path: string) => statSync(join(root, path)).mode & 0o777;

    expect(mode('.')).toBe(0o700);
    expect(mode('workdir')).toBe(0o777);
    expect(mode('claude-data')).toBe(0o777);
    expect(mode('secrets')).toBe(0o777);
    expect(mode('claude-data/.claude.json')).toBe(0o666);
  });

  it('leaves default modes where Docker maps ownership itself or the host user is uid 1001', () => {
    mkdirSync(join(base, 'reference-dir'));
    writeFileSync(join(base, 'reference-file'), '');
    const defaultDir = statSync(join(base, 'reference-dir')).mode & 0o777;
    const defaultFile = statSync(join(base, 'reference-file')).mode & 0o777;

    for (const host of [
      { platform: 'darwin' as const, uid: 501 },
      { platform: 'linux' as const, uid: 1001 },
    ]) {
      prepare({ host });
      const root = join(worktree, EVAL_DIR);
      const mode = (path: string) => statSync(join(root, path)).mode & 0o777;
      for (const dir of ['.', 'workdir', 'claude-data', 'secrets']) {
        expect(mode(dir), `${host.platform} ${dir}`).toBe(defaultDir);
      }
      expect(mode('claude-data/.claude.json')).toBe(defaultFile);
      removeEvalInstance(worktree);
    }
  });

  it('teardown removes the instance directory, and only removes a symlink put in its place', () => {
    prepare();
    expect(removeEvalInstance(worktree)).toBe('removed');
    expect(readdirSync(worktree)).not.toContain(EVAL_DIR);
    expect(removeEvalInstance(worktree)).toBe('absent');

    symlinkSync(join(main, 'workdir'), join(worktree, EVAL_DIR));
    expect(removeEvalInstance(worktree)).toBe('removed');
    expect(readdirSync(join(main, 'workdir', 'sessions'))).toEqual(['task-1']);
  });
});

describe('runEvalPrepare', () => {
  let base: string;
  let main: string;
  let worktree: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'eval-run-'));
    main = join(base, 'main');
    worktree = join(main, '.claude', 'worktrees', 'feat');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(main, '.env'), MAIN_DOTENV);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // Boot writes nothing after this step, so whatever fails next (compose config, build, up,
  // health) leaves on disk only what this step wrote.
  it('hands the key to the compose environment and leaves none on disk for a failed boot to strand', async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: `${main}/.git\n`, stderr: '' });
    const lines: string[] = [];
    const io = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };

    const r = await runEvalPrepare(worktree, exec, {}, io);

    expect(r.code).toBe(0);
    if (r.code !== 0) return;
    expect(r.composeEnv).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-main-key' });
    expect(r.keySource).toBe('the main checkout’s .env');
    expect(r.port).toMatch(/^\d+$/);
    expect(filesContaining(join(worktree, EVAL_DIR), 'sk-ant-main-key')).toEqual([]);
    expect(lines.join('\n')).not.toContain('sk-ant-main-key');
  });
});

describe('docker-compose.eval.yml', () => {
  const overlay = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'docker-compose.eval.yml'),
    'utf-8',
  )
    .split('\n')
    .map((line) => line.replace(/\s*#.*$/, ''))
    .join('\n');

  it('loads no env file, so teardown needs nothing from eval-instance/ and works again after a failure', () => {
    expect(overlay).toMatch(/^ {4}env_file: !reset \[\]$/m);
    expect(overlay).not.toContain('.env');
  });

  it('takes the model key from the compose environment, with no value of its own', () => {
    expect(overlay).toMatch(/^ {6}ANTHROPIC_API_KEY:$/m);
  });
});

// ---- The resolved compose config ----

const WT = '/repos/archie-hq/.claude/worktrees/feat';
const MAIN = '/repos/archie-hq';

function composeConfig(environment: Record<string, string>, binds: [string, string, boolean?][]) {
  return JSON.stringify({
    name: 'feat-eval',
    services: {
      archie: {
        environment,
        ports: [{ mode: 'ingress', target: 3042, published: '3042', protocol: 'tcp' }],
        volumes: [
          ...binds.map(([source, target, readOnly]) => ({
            type: 'bind',
            source,
            target,
            ...(readOnly ? { read_only: true } : {}),
            bind: {},
          })),
          { type: 'volume', target: '/app/node_modules', volume: {} },
        ],
      },
    },
  });
}

const BASE_ENV = {
  ARCHIE_WORKDIR: '/workdir',
  CLAUDE_PATH: '/usr/local/bin/claude',
  GIT_SHA: 'abc123',
  NODE_ENV: 'development',
  PORT: '3042',
};

/** What `docker compose config` resolves for the eval overlay (shape taken from compose v5.5). */
const EVAL_CONFIG = composeConfig(
  { ...BASE_ENV, ANTHROPIC_API_KEY: 'sk-ant-main-key', SSH_AUTH_SOCK: '' },
  [
    [`${WT}/eval-instance/workdir`, '/workdir'],
    [`${WT}/examples/plugins`, '/workdir/plugins', true],
    [`${WT}/src`, '/app/src'],
    [`${WT}/prompts`, '/app/prompts'],
    [`${WT}/core-plugin`, '/app/core-plugin'],
    [`${WT}/eval-instance/secrets`, '/app/secrets'],
    [`${WT}/eval-instance/claude-data`, '/home/archie/.claude'],
    [`${WT}/eval-instance/claude-data/.claude.json`, '/home/archie/.claude.json'],
  ],
);

/** What the base file alone resolves for a worktree the default profile prepared. */
const DEFAULT_CONFIG = composeConfig(
  {
    ...BASE_ENV,
    ANTHROPIC_API_KEY: 'sk-ant-main-key',
    SLACK_BOT_TOKEN: 'xoxb-main-secret',
    SLACK_SIGNING_SECRET: 'main-signing-secret',
    GITHUB_APP_ID: '123456',
    SSH_AUTH_SOCK: '/run/host-services/ssh-auth.sock',
  },
  [
    [`${WT}/workdir`, '/workdir'],
    [`${WT}/workdir/plugins`, '/workdir/plugins'],
    [`${WT}/src`, '/app/src'],
    ['/run/host-services/ssh-auth.sock', '/run/host-services/ssh-auth.sock'],
    [`${WT}/secrets`, '/app/secrets'],
    [`${WT}/claude-data`, '/home/archie/.claude'],
  ],
);

/** The worktree's workdir and claude-data are links to the main checkout's, as prepare-worktree leaves them. */
function fakeRealpath(path: string): string {
  for (const shared of ['workdir', 'claude-data']) {
    const link = `${WT}/${shared}`;
    if (path === link || path.startsWith(`${link}/`))
      return `${MAIN}/${shared}${path.slice(link.length)}`;
  }
  return path;
}

function settingsOf(configJson: string) {
  const read = readEffectiveSettings(configJson);
  if (!read.ok) throw new Error(read.error);
  return read.settings;
}

describe('readEffectiveSettings', () => {
  it('keeps variable names, bind mounts and the published port — never a value', () => {
    const settings = settingsOf(EVAL_CONFIG);
    expect(settings.project).toBe('feat-eval');
    expect(settings.port).toBe('3042');
    expect(settings.envKeys).toEqual([
      'ANTHROPIC_API_KEY',
      'ARCHIE_WORKDIR',
      'CLAUDE_PATH',
      'GIT_SHA',
      'NODE_ENV',
      'PORT',
      'SSH_AUTH_SOCK',
    ]);
    expect(settings.mounts).toHaveLength(8);
    expect(JSON.stringify(settings)).not.toContain('sk-ant-main-key');
  });

  it('reports unreadable output instead of an empty, apparently clean config', () => {
    expect(readEffectiveSettings('not json').ok).toBe(false);
    expect(readEffectiveSettings('{"services":{}}').ok).toBe(false);
  });
});

describe('findIsolationViolations', () => {
  it('passes the eval overlay’s resolved config', () => {
    expect(findIsolationViolations(settingsOf(EVAL_CONFIG), WT, fakeRealpath)).toEqual([]);
  });

  it('names every credential and every shared or outside mount the default profile would give the container', () => {
    const violations = findIsolationViolations(settingsOf(DEFAULT_CONFIG), WT, fakeRealpath);
    const text = violations.join('\n');

    for (const key of ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'GITHUB_APP_ID']) {
      expect(text).toContain(key);
    }
    expect(text).not.toContain('carries ANTHROPIC_API_KEY');
    expect(text).toContain(
      `${WT}/workdir -> /workdir mounts a host path outside this checkout (resolves to ${MAIN}/workdir)`,
    );
    expect(text).toContain(`${WT}/claude-data -> /home/archie/.claude mounts a host path outside`);
    expect(text).toContain(
      '/run/host-services/ssh-auth.sock -> /run/host-services/ssh-auth.sock mounts a host path outside',
    );
    expect(text).toContain(`${WT}/secrets -> /app/secrets mounts the checkout's shared secrets`);
    expect(text).not.toContain('/app/src');
  });

  it('rejects the main checkout’s own workdir when the eval profile runs there', () => {
    const inMain = composeConfig({ ...BASE_ENV, ANTHROPIC_API_KEY: 'k' }, [
      [`${MAIN}/workdir`, '/workdir'],
      [`${MAIN}/.env`, '/app/.env'],
      [MAIN, '/repo'],
    ]);
    expect(findIsolationViolations(settingsOf(inMain), MAIN, (p) => p)).toEqual([
      `${MAIN}/workdir -> /workdir mounts the checkout's shared workdir`,
      `${MAIN}/.env -> /app/.env mounts the checkout's shared .env`,
      `${MAIN} -> /repo mounts the whole checkout`,
    ]);
  });

  it('catches an eval-instance that is itself a symlink out of the checkout', () => {
    const realpath = (p: string) => p.replace(`${WT}/eval-instance`, `${MAIN}/workdir`);
    const violations = findIsolationViolations(settingsOf(EVAL_CONFIG), WT, realpath);
    expect(violations.some((v) => v.startsWith(`${WT}/eval-instance/workdir -> /workdir`))).toBe(
      true,
    );
  });
});

describe('renderEffectiveSettings', () => {
  it('states credentials by name with their source, the plugins directory and the port', () => {
    const lines = renderEffectiveSettings(settingsOf(EVAL_CONFIG), WT, 'the main checkout’s .env');
    const text = lines.join('\n');

    expect(text).toContain('compose project:          feat-eval');
    expect(text).toContain('port:                     3042');
    expect(text).toContain(
      'credentials (names only): ANTHROPIC_API_KEY (from the main checkout’s .env)',
    );
    expect(text).toContain('Slack/GitHub credentials: none');
    expect(text).toContain('host SSH agent:           not mounted');
    expect(text).toContain(
      'plugins:                  examples/plugins -> /workdir/plugins (read-only)',
    );
    expect(text).toContain('workdir:                  eval-instance/workdir -> /workdir');
    expect(text).not.toContain('sk-ant-main-key');
  });

  it('shows what leaked rather than hiding it, so a refused boot is explained', () => {
    const text = renderEffectiveSettings(settingsOf(DEFAULT_CONFIG), WT, undefined).join('\n');
    expect(text).toContain(
      'Slack/GitHub credentials: GITHUB_APP_ID, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET',
    );
    expect(text).toContain('host SSH agent:           mounted');
    expect(text).not.toContain('xoxb-main-secret');
  });
});
