import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  parseEvidenceJson,
  renderEvidenceMarkdown,
  resolveOutDir,
  runEvidenceWriter,
  validateEvidence,
  writeEvidencePair,
  type Evidence,
  type EvidenceFs,
} from './evidence.js';

function validPayload(): Evidence {
  return {
    schema: 'archie-e2e-evidence/v1',
    scenario: 'edit-mode-approval',
    ac_ids: ['AC3'],
    started_at: '2026-07-04T12:00:00Z',
    finished_at: '2026-07-04T12:03:10Z',
    environment: {
      base_url: 'http://localhost:3000',
      git_branch: 'forge/archie-e2e-harness',
      git_commit: 'abc1234',
    },
    nonce: 'E2E-a1b2c3d4',
    task_id: 'task-20260704-1200-x1y2z3',
    terminal_state: 'completed',
    assertions: [
      {
        id: 'gate-fired',
        description: 'wait_for_task reports approval_requested with type edit_mode',
        expected: 'STATE=approval_requested, APPROVAL_TYPE=edit_mode',
        observed: 'STATE=approval_requested APPROVAL_TYPE=edit_mode',
        pass: true,
      },
      {
        id: 'task-completed',
        description: 'continued waiting reaches completed',
        expected: 'STATE=completed',
        observed: 'STATE=completed',
        pass: true,
      },
    ],
    excerpts: {
      knowledge_log: ['[2026-07-04T12:00:01Z] [system] task created'],
      events: [{ type: 'approval:requested', data: { type: 'edit_mode' } }],
    },
    result: 'pass',
  };
}

describe('validateEvidence', () => {
  it('accepts a complete valid payload', () => {
    const r = validateEvidence(validPayload());
    expect(r.ok).toBe(true);
  });

  it('rejects a payload without assertions, naming the field', () => {
    const p = { ...validPayload(), assertions: [] };
    const r = validateEvidence(p);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join('\n')).toContain('assertions must be a non-empty array');
  });

  it('rejects a result inconsistent with assertion outcomes', () => {
    const p = validPayload();
    p.assertions[1]!.pass = false;
    // result still claims pass
    const r = validateEvidence(p);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join('\n')).toContain('inconsistent with assertion outcomes');
  });

  it('rejects an unknown terminal_state', () => {
    const p = { ...validPayload(), terminal_state: 'exploded' };
    const r = validateEvidence(p);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join('\n')).toContain('terminal_state must be one of');
  });

  it('rejects a wrong schema tag and missing required fields', () => {
    const r = validateEvidence({ schema: 'archie-e2e-evidence/v2', scenario: 'x' });
    expect(r.ok).toBe(false);
    const msg = !r.ok ? r.errors.join('\n') : '';
    expect(msg).toContain('schema must be "archie-e2e-evidence/v1"');
    expect(msg).toContain('nonce must be a non-empty string');
    expect(msg).toContain('environment must be an object');
  });

  it('rejects a scenario name unsafe for filenames', () => {
    const p = { ...validPayload(), scenario: '../escape' };
    const r = validateEvidence(p);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join('\n')).toContain('kebab-case');
  });

  it('rejects assertions missing expected/observed/pass', () => {
    const p = { ...validPayload(), assertions: [{ id: 'a', description: 'b' }] };
    const r = validateEvidence(p);
    expect(r.ok).toBe(false);
    const msg = !r.ok ? r.errors.join('\n') : '';
    expect(msg).toContain('assertions[0].expected');
    expect(msg).toContain('assertions[0].pass must be a boolean');
  });
});

describe('renderEvidenceMarkdown', () => {
  it('includes every assertion row and the verdict', () => {
    const md = renderEvidenceMarkdown(validPayload());
    expect(md).toContain('# E2E evidence — edit-mode-approval');
    expect(md).toContain('| gate-fired |');
    expect(md).toContain('| task-completed |');
    expect(md).toContain('STATE=approval_requested');
    expect(md).toContain('## Verdict');
    expect(md).toContain('**PASS** — 2/2 assertions passed.');
    expect(md).toContain('[system] task created');
    expect(md).toContain('"approval:requested"');
  });

  it('marks a failing run FAIL in the verdict', () => {
    const p = validPayload();
    p.assertions[1]!.pass = false;
    p.result = 'fail';
    const md = renderEvidenceMarkdown(p);
    expect(md).toContain('**FAIL** — 1/2 assertions passed.');
    expect(md).toContain('| task-completed |');
    expect(md).toMatch(/task-completed.*FAIL \|/);
  });

  it('escapes backslashes before pipes in table cells so escapes stay unambiguous', () => {
    const p = validPayload();
    p.assertions[0]!.observed = 'path C:\\dir | raw pipe';
    const md = renderEvidenceMarkdown(p);
    expect(md).toContain('C:\\\\dir \\| raw pipe');
  });
});

describe('parseEvidenceJson', () => {
  it('classifies EOF mid-JSON as truncated input', () => {
    const r = parseEvidenceJson('{"schema": "archie-e2e-evidence/v1", "scenario": "bas');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('truncated JSON input from stdin');
  });

  it('classifies empty input as truncated', () => {
    const r = parseEvidenceJson('');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('truncated JSON input from stdin: empty input');
  });

  it('classifies structurally broken JSON as invalid, naming the source', () => {
    const r = parseEvidenceJson('{"a": nope}', '/tmp/evidence.json');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/invalid JSON from \/tmp\/evidence\.json/);
  });

  it('classifies a cut right after a complete value as truncated (missing comma/closer at end of input)', () => {
    for (const input of ['{"a": 5', '[{"a":1}']) {
      const r = parseEvidenceJson(input);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error, input).toContain('truncated JSON input from stdin');
    }
  });

  it('the same missing-comma complaint mid-input stays classified as invalid, not truncated', () => {
    const r = parseEvidenceJson('{"a": 5 "b": 6}');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('invalid JSON from stdin');
  });
});

describe('parseArgs', () => {
  it('accepts both flag forms', () => {
    expect(parseArgs(['--in', 'p.json', '--out-dir', 'out'])).toEqual({ inFile: 'p.json', outDir: 'out' });
    expect(parseArgs(['--in=p.json', '--out-dir=out'])).toEqual({ inFile: 'p.json', outDir: 'out' });
    expect(parseArgs([])).toEqual({});
  });

  it('rejects flags missing their value instead of silently ignoring them', () => {
    expect(() => parseArgs(['--in'])).toThrow(/--in requires a value/);
    expect(() => parseArgs(['--out-dir'])).toThrow(/--out-dir requires a value/);
  });

  it('rejects unknown arguments', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument: --bogus/);
  });
});

describe('resolveOutDir', () => {
  it('flag beats env beats default', () => {
    expect(resolveOutDir('flagged', 'from-env', '/default')).toBe('flagged');
    expect(resolveOutDir(undefined, 'from-env', '/default')).toBe('from-env');
    expect(resolveOutDir(undefined, undefined, '/default')).toBe('/default');
  });

  it('treats a set-but-empty E2E_EVIDENCE_DIR as unset (no writes to cwd by accident)', () => {
    expect(resolveOutDir(undefined, '', '/default')).toBe('/default');
  });
});

// ---- Fake fs: tracks files on a virtual disk so tests can assert "nothing on disk" ----

function fakeFs(opts: { failRename?: (to: string) => boolean } = {}) {
  const disk = new Map<string, string>();
  let writes = 0;
  const fs: EvidenceFs = {
    async mkdir() {},
    async writeFile(path, content) {
      writes++;
      disk.set(path, content);
    },
    async rename(from, to) {
      if (opts.failRename?.(to)) throw new Error(`EACCES: rename to ${to}`);
      const content = disk.get(from);
      if (content === undefined) throw new Error(`ENOENT: ${from}`);
      disk.delete(from);
      disk.set(to, content);
    },
    async unlink(path) {
      disk.delete(path);
    },
  };
  return { fs, disk, writeCount: () => writes };
}

const io = () => {
  const logs: string[] = [];
  const errors: string[] = [];
  return { log: (l: string) => void logs.push(l), error: (l: string) => void errors.push(l), logs, errors };
};

describe('runEvidenceWriter — all-or-nothing', () => {
  it('writes the json/md pair for a valid payload', async () => {
    const { fs, disk } = fakeFs();
    const out = io();
    const code = await runEvidenceWriter(JSON.stringify(validPayload()), 'stdin', '/evidence', fs, out);
    expect(code).toBe(0);
    expect([...disk.keys()].sort()).toEqual(['/evidence/edit-mode-approval.json', '/evidence/edit-mode-approval.md']);
    const roundTripped: unknown = JSON.parse(disk.get('/evidence/edit-mode-approval.json')!);
    expect(validateEvidence(roundTripped).ok).toBe(true);
  });

  it('truncated stdin → classed error, non-zero exit, zero filesystem writes', async () => {
    const { fs, disk, writeCount } = fakeFs();
    const out = io();
    const code = await runEvidenceWriter('{"schema": "archie-e2e-ev', 'stdin', '/evidence', fs, out);
    expect(code).toBe(1);
    expect(out.errors.join('\n')).toContain('truncated JSON input from stdin');
    expect(writeCount()).toBe(0);
    expect(disk.size).toBe(0);
  });

  it('invalid payload → non-zero exit naming the errors, zero filesystem writes', async () => {
    const { fs, disk, writeCount } = fakeFs();
    const out = io();
    const payload = { ...validPayload(), assertions: [] };
    const code = await runEvidenceWriter(JSON.stringify(payload), 'stdin', '/evidence', fs, out);
    expect(code).toBe(1);
    expect(out.errors.join('\n')).toContain('assertions must be a non-empty array');
    expect(writeCount()).toBe(0);
    expect(disk.size).toBe(0);
  });
});

describe('writeEvidencePair — transactional', () => {
  it('rolls back the landed json when the md rename fails (both or neither)', async () => {
    const { fs, disk } = fakeFs({ failRename: (to) => to.endsWith('.md') });
    await expect(writeEvidencePair(fs, '/evidence', validPayload())).rejects.toThrow(/EACCES/);
    expect(disk.size).toBe(0); // no finals, no temps
  });

  it('cleans up temps when a write fails', async () => {
    const { disk } = fakeFs();
    const failingFs: EvidenceFs = {
      async mkdir() {},
      async writeFile(path, content) {
        if (path.endsWith('.md.tmp')) throw new Error('ENOSPC');
        disk.set(path, content);
      },
      async rename() {
        throw new Error('should not get here');
      },
      async unlink(path) {
        disk.delete(path);
      },
    };
    await expect(writeEvidencePair(failingFs, '/evidence', validPayload())).rejects.toThrow(/ENOSPC/);
    expect(disk.size).toBe(0);
  });
});
