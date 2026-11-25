/**
 * Branch tools against real git repositories.
 *
 * The other branch-tool tests mock git away; these run it, so they cover what
 * git actually receives. A ref is one argument: nothing an agent names, or a
 * task stored from an earlier call, is interpreted by a shell or read by git
 * as an option. A marker file outside the repositories proves the negative.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mcpToolHandler } from '../../test-support/mcp.js';
import { createRepoToolsMcpServer } from '../tools.js';
import { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { AttachedRepo } from '../../types/task.js';

vi.mock('../../system/logger.js', () => ({
  logger: {
    agentAction: vi.fn(),
    system: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const execFileAsync = promisify(execFile);

const TASK_ID = 'task-20260101-1823-abc123';
const TASK_BRANCH = `archie/${TASK_ID}`;

let tmpDir: string;
let remotePath: string;
let clonePath: string;
let markerPath: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Values that would run `touch <marker>` if any part of them reached a shell. */
function refsWithShellSyntax(marker: string): string[] {
  return [
    `x;touch ${marker}`,
    `x$(touch ${marker})`,
    `x\`touch ${marker}\``,
    `main && touch ${marker}`,
    `main"; touch ${marker}; echo "`,
    `main'; touch ${marker}; echo '`,
  ];
}

function makeTask(attached: AttachedRepo): Task {
  return {
    taskId: TASK_ID,
    metadata: { repositories: [attached], edit_allowed: true },
    debouncedSave: vi.fn(),
  } as unknown as Task;
}

function repoTool(task: Task, name: string) {
  const agent = new Agent({
    id: 'pm-agent',
    key: 'pm',
    role: 'PM',
    expertise: '',
    isPm: true,
    pluginName: 'pm',
    visibility: 'global',
  });
  return mcpToolHandler(createRepoToolsMcpServer(agent, task), name);
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archie-branch-tools-'));
  markerPath = path.join(tmpDir, 'marker');
  const seedPath = path.join(tmpDir, 'seed');
  remotePath = path.join(tmpDir, 'remote.git');
  clonePath = path.join(tmpDir, 'clone');

  await fs.promises.mkdir(seedPath);
  await git(seedPath, 'init', '-q', '-b', 'main');
  await git(
    seedPath,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  await git(tmpDir, 'clone', '-q', '--bare', seedPath, remotePath);
  await git(remotePath, 'branch', 'feature/login.fix', 'main');
  await git(tmpDir, 'clone', '-q', remotePath, clonePath);
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

function attachedOnMain(): AttachedRepo {
  return { github: 'org/repo', clone_path: clonePath, current_branch: 'main', branch_states: {} };
}

describe('branch tools with ordinary names', () => {
  it('switches to a remote branch whose name has a slash and a dot', async () => {
    const attached = attachedOnMain();
    const result = await repoTool(
      makeTask(attached),
      'switch_branch',
    )({
      branch: 'feature/login.fix',
    });

    expect(resultText(result)).toBe('Switched to feature/login.fix');
    expect(await git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/login.fix');
    expect(attached.current_branch).toBe('feature/login.fix');
  });

  it('creates a branch from a named base and pushes it', async () => {
    const attached = attachedOnMain();
    const task = makeTask(attached);

    const created = await repoTool(task, 'create_branch')({ base: 'origin/feature/login.fix' });
    expect(resultText(created)).toContain(`Created and switched to ${TASK_BRANCH}`);
    expect(await git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(TASK_BRANCH);

    const pushed = await repoTool(task, 'push_branch')({});
    expect(resultText(pushed)).toContain(`Pushed ${TASK_BRANCH}`);
    expect(await git(remotePath, 'rev-parse', '--verify', `refs/heads/${TASK_BRANCH}`)).toBe(
      await git(clonePath, 'rev-parse', 'HEAD'),
    );
  });
});

describe('branch tools pass refs as single arguments', () => {
  it('refuses refs with shell metacharacters without running them', async () => {
    for (const ref of refsWithShellSyntax(markerPath)) {
      const attached = attachedOnMain();
      const task = makeTask(attached);

      const switched = await repoTool(task, 'switch_branch')({ branch: ref });
      const created = await repoTool(task, 'create_branch')({ base: ref });

      expect(resultText(switched), ref).toMatch(/^Error: Invalid branch/);
      expect(resultText(created), ref).toMatch(/^Error: Invalid base/);
      expect(attached.current_branch).toBe('main');
    }
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(await git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('pushes a stored branch name without a shell', async () => {
    // Branch names already in task metadata are not re-validated, so pushing
    // one must be safe however it was recorded.
    for (const ref of refsWithShellSyntax(markerPath)) {
      const attached: AttachedRepo = {
        github: 'org/repo',
        clone_path: clonePath,
        current_branch: ref,
        branch_states: { [ref]: {} },
      };

      const result = await repoTool(makeTask(attached), 'push_branch')({});

      expect(resultText(result), ref).toMatch(/^Error: Failed to push/);
    }
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
