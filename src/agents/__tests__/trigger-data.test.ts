/**
 * Tests for the two pure trigger-data helpers.
 *
 * The load-bearing assertion is that the trigger directory lands in BOTH sandbox
 * lists. `assertReadable` (src/agents/artifacts.ts) validates against
 * `allowReadPaths` alone, so a write-only grant would let an agent write a file
 * here and then be refused when it tried to `share_artifact` the result — see the
 * write-only case in artifacts.test.ts, which pins exactly that.
 *
 * An earlier version of this file asserted the opposite, on the belief that
 * listing a path in both lists makes bwrap lay a `--ro-bind` over the writable
 * mount and silently downgrade it. That was measured and is false; see the
 * corrected Known Limitation 1 in docs/architecture/security.md.
 */

import { describe, it, expect } from 'vitest';
import type { SandboxOptions } from '../sandbox.js';
import { grantTriggerDataAccess, buildTriggerDataPromptSection } from '../trigger-data.js';

const TRIGGER_DATA = '/workdir/triggers-data/trg-20260817-1200-abc123';

const base: SandboxOptions = {
  cwd: '/workdir/sessions/task-1/workspace',
  allowReadPaths: ['/workdir/sessions/task-1/workspace'],
  allowWritePaths: ['/workdir/sessions/task-1/workspace'],
  denyWritePaths: ['/workdir/sessions/task-1/workspace/.claude'],
  denyReadPaths: ['/workdir/secrets'],
  allowedNetworkDomains: ['registry.npmjs.org'],
};

describe('grantTriggerDataAccess', () => {
  it('appends the trigger directory to allowWritePaths', () => {
    expect(grantTriggerDataAccess(base, TRIGGER_DATA).allowWritePaths).toEqual([
      '/workdir/sessions/task-1/workspace',
      TRIGGER_DATA,
    ]);
  });

  it('appends the trigger directory to allowReadPaths too, so artifact tools can read it', () => {
    // Both lists, the same shape the workspace and the repo clones use. Write-only
    // would leave assertReadable (src/agents/artifacts.ts) refusing to share a file
    // the agent had just written there — see the write-only case in artifacts.test.ts.
    const granted = grantTriggerDataAccess(base, TRIGGER_DATA);
    expect(granted.allowReadPaths).toEqual([...base.allowReadPaths, TRIGGER_DATA]);
  });

  it('passes every other option through unchanged', () => {
    const granted = grantTriggerDataAccess(base, TRIGGER_DATA);
    expect(granted.cwd).toBe(base.cwd);
    expect(granted.denyReadPaths).toEqual(base.denyReadPaths);
    expect(granted.denyWritePaths).toEqual(base.denyWritePaths);
    expect(granted.allowedNetworkDomains).toEqual(base.allowedNetworkDomains);
  });

  it('does not mutate the options it was given', () => {
    const input: SandboxOptions = {
      ...base,
      allowReadPaths: [...base.allowReadPaths],
      allowWritePaths: [...base.allowWritePaths!],
    };
    grantTriggerDataAccess(input, TRIGGER_DATA);
    expect(input.allowWritePaths).not.toContain(TRIGGER_DATA);
    expect(input.allowReadPaths).not.toContain(TRIGGER_DATA);
  });

  it('produces a one-element list when the input had no allowWritePaths', () => {
    const readOnly: SandboxOptions = { cwd: base.cwd, allowReadPaths: base.allowReadPaths };
    expect(grantTriggerDataAccess(readOnly, TRIGGER_DATA).allowWritePaths).toEqual([TRIGGER_DATA]);
  });
});

describe('buildTriggerDataPromptSection', () => {
  it('names the path, marks it read-write, and points at the trigger-task skill', () => {
    const section = buildTriggerDataPromptSection(TRIGGER_DATA);
    expect(section).toContain(TRIGGER_DATA);
    expect(section).toContain('[READ-WRITE]');
    expect(section).toContain('trigger-task');
  });
});

describe('buildTriggerDataPromptSection listing', () => {
  const P = '/workdir/triggers-data/trg-20260817-1200-abc123';

  it('says the directory is empty when it is, rather than omitting the listing', () => {
    const out = buildTriggerDataPromptSection(P, []);
    expect(out).toContain('Contents: empty');
    expect(out).not.toContain('- ');
  });

  it('defaults to the empty listing when no entries are passed', () => {
    expect(buildTriggerDataPromptSection(P)).toContain('Contents: empty');
  });

  it('names every entry, sorted, so the agent can Read one without listing the directory', () => {
    const out = buildTriggerDataPromptSection(P, ['state.json', 'a-note.md']);
    expect(out).toContain('Contents (2 entries)');
    expect(out.indexOf('- a-note.md')).toBeLessThan(out.indexOf('- state.json'));
  });

  it('uses the singular for one entry', () => {
    expect(buildTriggerDataPromptSection(P, ['only.md'])).toContain('Contents (1 entry)');
  });

  it('caps the listing so a runaway directory cannot grow every later prompt without bound', () => {
    const many = Array.from({ length: 130 }, (_, i) => `f${String(i).padStart(3, '0')}.md`);
    const out = buildTriggerDataPromptSection(P, many);
    expect(out).toContain('Contents (130 entries)');
    expect(out).toContain('- f000.md');
    expect(out).toContain('and 80 more, not listed');
    expect(out).not.toContain('- f050.md');
    expect(out.split('\n').filter((l) => l.startsWith('- ')).length).toBe(51); // 50 names + the truncation line
  });

  it('does not mutate the caller\'s array while sorting', () => {
    const entries = ['z.md', 'a.md'];
    buildTriggerDataPromptSection(P, entries);
    expect(entries).toEqual(['z.md', 'a.md']);
  });
});
