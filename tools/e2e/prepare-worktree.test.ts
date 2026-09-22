import { describe, it, expect } from 'vitest';
import { mainCheckoutFrom, planPreparation, rewritePort, renderPlan, parseArgs, PORT_SCAN_RANGE, type TreeState } from './prepare-worktree.js';

const MAIN = '/repos/archie-hq';

function state(overrides: Partial<TreeState> = {}): TreeState {
  return {
    workdir: 'absent',
    claudeData: 'absent',
    secrets: 'empty-dir',
    secretsMissing: ['github-private-key.pem', 'oauth'],
    dotenv: 'absent',
    mainDotenv: 'ANTHROPIC_API_KEY=sk-x\nPORT=3000\n',
    nodeModules: true,
    ...overrides,
  };
}

describe('mainCheckoutFrom', () => {
  it('reads the main checkout out of a worktree common dir', () => {
    expect(mainCheckoutFrom(`${MAIN}/.git\n`, `${MAIN}/.claude/worktrees/feat-x`)).toEqual({
      kind: 'worktree',
      main: MAIN,
    });
  });

  it('recognises the main checkout itself — nothing to prepare', () => {
    expect(mainCheckoutFrom(`${MAIN}/.git\n`, MAIN)).toEqual({ kind: 'main-checkout' });
    expect(mainCheckoutFrom(`${MAIN}/.git/\n`, `${MAIN}/`)).toEqual({ kind: 'main-checkout' });
    expect(mainCheckoutFrom('  \n', MAIN)).toEqual({ kind: 'main-checkout' });
  });
});

describe('rewritePort', () => {
  it('replaces an existing PORT line and leaves the rest byte-identical', () => {
    const out = rewritePort('ANTHROPIC_API_KEY=sk-x\nPORT=3000\nSLACK_BOT_TOKEN=xoxb\n', '3117');
    expect(out).toBe('ANTHROPIC_API_KEY=sk-x\nPORT=3117\nSLACK_BOT_TOKEN=xoxb\n');
  });

  it('replaces a PORT line with surrounding whitespace or an inline comment', () => {
    expect(rewritePort('  PORT = 3000 # main\n', '3117')).toBe('PORT=3117\n');
  });

  it('appends a PORT when the source file has none', () => {
    const out = rewritePort('ANTHROPIC_API_KEY=sk-x\n', '3117');
    expect(out).toContain('ANTHROPIC_API_KEY=sk-x\n');
    expect(out.trimEnd().endsWith('PORT=3117')).toBe(true);
  });

  it('does not mistake a commented-out PORT for the real one', () => {
    const out = rewritePort('# PORT=9999\nANTHROPIC_API_KEY=sk-x\n', '3117');
    expect(out).toContain('# PORT=9999');
    expect(out.trimEnd().endsWith('PORT=3117')).toBe(true);
  });
});

describe('planPreparation — a cold worktree', () => {
  it('plans all four prerequisites, with .env on a free port', () => {
    const plan = planPreparation(state(), MAIN, '3117');
    expect(plan.errors).toEqual([]);
    expect(plan.actions).toEqual([
      { kind: 'link', path: 'workdir', from: `${MAIN}/workdir` },
      { kind: 'link', path: 'claude-data', from: `${MAIN}/claude-data` },
      { kind: 'copy-secrets', from: `${MAIN}/secrets`, entries: ['github-private-key.pem', 'oauth'], replacesSymlink: false },
      { kind: 'write-env', from: `${MAIN}/.env`, port: '3117' },
    ]);
  });

  it('links over an empty directory a previous boot left behind', () => {
    const plan = planPreparation(state({ workdir: 'empty-dir', claudeData: 'empty-dir' }), MAIN, '3117');
    expect(plan.actions.filter((a) => a.kind === 'link')).toHaveLength(2);
  });
});

describe('planPreparation — idempotence and non-destruction', () => {
  it('is a no-op on an already-prepared worktree', () => {
    const plan = planPreparation(
      state({ workdir: 'symlink', claudeData: 'symlink', secrets: 'dir', secretsMissing: [], dotenv: 'file' }),
      MAIN,
      '3117',
    );
    expect(plan.actions).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.notes.join(' ')).toMatch(/secrets\/: a real directory/);
  });

  it('never rewrites an existing .env — its PORT is the operator’s choice', () => {
    const plan = planPreparation(state({ dotenv: 'file' }), MAIN, '3117');
    expect(plan.actions.some((a) => a.kind === 'write-env')).toBe(false);
    expect(plan.notes.join(' ')).toMatch(/\.env: already present/);
  });

  it('leaves a real non-empty workdir alone and says it is not shared', () => {
    const plan = planPreparation(state({ workdir: 'dir' }), MAIN, '3117');
    expect(plan.actions.some((a) => a.kind === 'link' && a.path === 'workdir')).toBe(false);
    expect(plan.notes.join(' ')).toMatch(/NOT shared with the main checkout/);
  });

  it('tops up a partially-populated secrets/ with only the missing entries', () => {
    const plan = planPreparation(state({ secrets: 'dir', secretsMissing: ['oauth'] }), MAIN, '3117');
    expect(plan.actions).toContainEqual({
      kind: 'copy-secrets',
      from: `${MAIN}/secrets`,
      entries: ['oauth'],
      replacesSymlink: false,
    });
  });
});

describe('planPreparation — the Docker build-context asymmetry', () => {
  it('replaces a symlinked secrets/ with a real copy of every entry', () => {
    const plan = planPreparation(state({ secrets: 'symlink', secretsMissing: ['github-private-key.pem'] }), MAIN, '3117');
    const copy = plan.actions.find((a) => a.kind === 'copy-secrets');
    expect(copy).toMatchObject({ replacesSymlink: true, entries: ['github-private-key.pem'] });
    expect(renderPlan(plan).join('\n')).toMatch(/replacing a symlink/);
  });

  it('leaves symlinked workdir/claude-data as they are — bind mounts do follow them', () => {
    const plan = planPreparation(state({ workdir: 'symlink', claudeData: 'symlink' }), MAIN, '3117');
    expect(plan.actions.some((a) => a.kind === 'link')).toBe(false);
  });
});

describe('planPreparation — states the operator must resolve', () => {
  it('errors, and plans nothing, when a prerequisite name is taken by a file', () => {
    const plan = planPreparation(state({ workdir: 'file', secrets: 'file' }), MAIN, '3117');
    expect(plan.errors).toEqual([
      'workdir exists as a file — remove it and re-run.',
      'secrets exists as a file — remove it and re-run.',
    ]);
  });

  it('errors when there is no .env here and none to copy from', () => {
    const plan = planPreparation(state({ mainDotenv: undefined }), MAIN, '3117');
    expect(plan.errors.join(' ')).toMatch(/ANTHROPIC_API_KEY/);
    expect(plan.actions.some((a) => a.kind === 'write-env')).toBe(false);
  });

  it('notes a missing node_modules without blocking the boot', () => {
    const plan = planPreparation(state({ nodeModules: false }), MAIN, '3117');
    expect(plan.errors).toEqual([]);
    expect(plan.notes.join(' ')).toMatch(/npm install/);
  });
});

describe('PORT_SCAN_RANGE', () => {
  it('sits just above main’s 3000 and well below the OS ephemeral range', () => {
    expect(PORT_SCAN_RANGE.from).toBeGreaterThan(3000);
    expect(PORT_SCAN_RANGE.to).toBeLessThan(32768);
    expect(PORT_SCAN_RANGE.to).toBeGreaterThan(PORT_SCAN_RANGE.from);
  });
});

describe('parseArgs', () => {
  it('accepts --print-plan and rejects anything else', () => {
    expect(parseArgs([])).toEqual({ printPlanOnly: false });
    expect(parseArgs(['--print-plan'])).toEqual({ printPlanOnly: true });
    expect(() => parseArgs(['--force'])).toThrow(/unknown argument/);
  });
});
