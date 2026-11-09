import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: '',
  getTask: vi.fn(),
  download: vi.fn(),
  send: vi.fn(),
  append: vi.fn(),
}));
vi.mock('../../../tasks/task.js', () => ({ Task: { get: mocks.getTask } }));
vi.mock('../../../tasks/persistence.js', () => ({
  appendGitHubEvent: mocks.append,
}));
vi.mock('../../../system/workdir.js', () => ({
  get WORKDIR() {
    return mocks.root;
  },
}));
vi.mock('../../../agents/prompts.js', () => ({
  AGENT_PROMPTS: { inboundActivity: (lines: string[]) => lines.join('\n') },
}));
vi.mock('../client.js', () => ({ getGitHubClient: () => ({ downloadWorkflowArtifact: mocks.download }) }));
vi.mock('../../../system/logger.js', () => ({ logger: { error: vi.fn() } }));

import {
  captureWorkflowFeedback,
  handleWorkflowReport,
  importWorkflowReport,
  mountWorkflowFeedback,
  verifyWorkflowIdentity,
} from '../workflow-reports.js';
import {
  grantWorkflowReportData,
  workflowReportStore,
  type WorkflowReportConfig,
} from '../../../agents/workflow-report-data.js';
import { createFilesystemGuardHooks } from '../../../agents/sandbox.js';

const config: WorkflowReportConfig = {
  repository: 'acme/mobile',
  workflow: 'research.yml',
  branch: 'main',
  artifact: 'research-report',
  taskId: 'task-20261109-1502-abc123',
};
const sha = 'a'.repeat(40);
const run = {
  id: 101,
  run_attempt: 1,
  path: '.github/workflows/research.yml',
  head_branch: 'main',
  head_repository: { full_name: config.repository },
  head_sha: sha,
  event: 'schedule',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/acme/mobile/actions/runs/101',
};

function zip(entries: Record<string, string>) {
  return execFileSync(
    'python3',
    [
      '-c',
      `import io, json, sys, zipfile
out = io.BytesIO()
with zipfile.ZipFile(out, 'w') as archive:
    for name, content in json.load(sys.stdin).items(): archive.writestr(name, content)
sys.stdout.buffer.write(out.getvalue())`,
    ],
    { input: JSON.stringify(entries) }
  );
}

function bundle(extra: Record<string, string> = {}) {
  return zip({
    'state/state.json': JSON.stringify({ version: 1, run_id: 101, commit: sha, proposals: [], decisions: [] }),
    'input.json': JSON.stringify({ commit: sha }),
    'proposals.json': '[]',
    'report.md': '# Nothing worth proposing\nCoverage is complete.\n',
    'items/': '',
    'raw/': '',
    ...extra,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.root = await mkdtemp(join(tmpdir(), 'workflow-report-'));
  vi.stubEnv('ARCHIE_WORKFLOW_REPORT', JSON.stringify(config));
  mocks.getTask.mockResolvedValue({
    taskId: config.taskId,
    pmDef: { key: 'pm' },
    sendMessage: mocks.send,
    metadata: { default_channel: 'dm', channels: { dm: { type: 'slack', channel_id: 'D123' } } },
  });
  mocks.append.mockImplementation(async (_task, _repo, event) => event.message);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(mocks.root, { recursive: true, force: true });
});

describe('GitHub workflow identity', () => {
  it('requires GitHub signature, issuer, audience, repository, branch, workflow and allowed event', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test' }] });
    const claims = {
      repository: 'acme/mobile',
      ref: 'refs/heads/main',
      workflow_ref: 'acme/mobile/.github/workflows/research.yml@refs/heads/main',
      event_name: 'schedule',
      run_id: '101',
    };
    const sign = (
      overrides = {},
      issuer = 'https://token.actions.githubusercontent.com',
      audience = 'archie-workflow-feedback'
    ) =>
      new SignJWT({ ...claims, ...overrides })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    expect(await verifyWorkflowIdentity(await sign(), config, keys)).toBe('101');
    for (const overrides of [
      { repository: 'other/mobile' },
      { ref: 'refs/heads/feature' },
      { workflow_ref: 'other.yml' },
      { event_name: 'pull_request' },
      { run_id: '../escape' },
    ])
      await expect(verifyWorkflowIdentity(await sign(overrides), config, keys)).rejects.toThrow();
    await expect(verifyWorkflowIdentity(await sign({}, 'https://other.example'), config, keys)).rejects.toThrow();
    await expect(verifyWorkflowIdentity(await sign({}, undefined, 'other-audience'), config, keys)).rejects.toThrow();
    const foreign = await generateKeyPair('RS256');
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://token.actions.githubusercontent.com')
      .setAudience('archie-workflow-feedback')
      .sign(foreign.privateKey);
    await expect(verifyWorkflowIdentity(forged, config, keys)).rejects.toThrow();
  });

  it('rejects unauthenticated requests and rate-limits repeated attempts before reading feedback', async () => {
    const app = express();
    mountWorkflowFeedback(app);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/webhooks/github/research-feedback`;
    try {
      for (let i = 0; i < 30; i++) expect((await fetch(url)).status).toBe(401);
      const limited = await fetch(url);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
      expect(mocks.getTask).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it('captures feedback once per run, retaining feedback arriving after the capture', async () => {
  const pending = join(mocks.root, 'pending');
  await mkdir(pending);
  const feedback = [{ id: 'idea', decision: 'dismiss', reason: 'Already covered' }];
  await writeFile(join(pending, 'first.json'), JSON.stringify(feedback));
  const first = await captureWorkflowFeedback(mocks.root, '101', 100);
  await writeFile(join(pending, 'later.json'), JSON.stringify([{ id: 'later' }]));
  expect(await captureWorkflowFeedback(mocks.root, '101', 100)).toEqual(first);
  expect(first).toEqual({ base_run_id: 100, files: ['first.json'], feedback });
  expect(await readFile(join(pending, 'first.json'), 'utf8')).toContain('Already covered');
  expect((await captureWorkflowFeedback(mocks.root, '102', 101)).files).toEqual(['first.json', 'later.json']);
});

it('grants only the bound task access, with reports and captured submissions read-only', async () => {
  const base = { cwd: '/workspace', allowReadPaths: ['/workspace'], allowWritePaths: ['/workspace'] };
  expect(await grantWorkflowReportData(base, 'another-task')).toBe(base);
  const granted = await grantWorkflowReportData(base, config.taskId);
  const store = workflowReportStore(config.taskId);
  for (const writable of granted.allowWritePaths ?? []) {
    if (writable.startsWith(store))
      expect(granted.allowReadPaths.some((readOnly) => writable.startsWith(`${readOnly}/`))).toBe(false);
  }
  const hook = createFilesystemGuardHooks(granted)[0].hooks[0] as any;
  const check = (tool: string, file: string) => hook({ tool_name: tool, tool_input: { file_path: join(store, file) } });
  expect(await check('Write', 'pending/new.json')).toEqual({ continue: true });
  expect(await check('Write', 'applied/old.json')).toEqual({ continue: true });
  expect(await check('Read', 'reports/101/state/state.json')).toEqual({ continue: true });
  for (const file of ['reports/101/report.md', 'submissions/101/submission.json', 'receipts/101.json'])
    expect((await check('Write', file)).hookSpecificOutput.permissionDecision).toBe('deny');
});

it('refuses a symlink in pending feedback instead of reading a host file', async () => {
  await mkdir(join(mocks.root, 'pending'));
  await writeFile(join(mocks.root, 'private.json'), '[{"secret":"must-not-be-exported"}]');
  await symlink(join(mocks.root, 'private.json'), join(mocks.root, 'pending/one.json'));
  await expect(captureWorkflowFeedback(mocks.root, '101', 100)).rejects.toThrow();
});

it('publishes one complete capture under concurrent requests', async () => {
  const captures = await Promise.all(Array.from({ length: 4 }, () => captureWorkflowFeedback(mocks.root, '101', 100)));
  for (const capture of captures) expect(capture).toEqual({ base_run_id: 100, files: [], feedback: [] });
});

it('imports a complete quiet report but rejects wrong run identity and escaping archive paths', async () => {
  await importWorkflowReport(join(mocks.root, 'good'), bundle(), 101, sha);
  await expect(importWorkflowReport(join(mocks.root, 'wrong'), bundle(), 102, sha)).rejects.toThrow('mismatched');
  await expect(
    importWorkflowReport(join(mocks.root, 'unsafe'), zip({ '../escaped': 'bad' }), 101, sha)
  ).rejects.toThrow('Unsafe report archive path');
  await expect(readFile(join(mocks.root, 'escaped'))).rejects.toThrow();
});

it('delivers a verified report to the existing DM once without dispatching a new workflow', async () => {
  mocks.download.mockResolvedValue({ run, bytes: bundle() });
  const event = { action: 'completed', repository: { full_name: config.repository }, workflow_run: run };
  expect(await handleWorkflowReport('workflow_run', event)).toBe(true);
  await handleWorkflowReport('workflow_run', event);
  expect(mocks.download).toHaveBeenCalledTimes(1);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0][0]).toContain('without downloading or dispatching');
  expect(mocks.send.mock.calls[0][0]).toContain('STORE=');
});

it('ignores other workflows and branches and refuses a report with a different captured submission', async () => {
  const event = {
    action: 'completed',
    repository: { full_name: config.repository },
    workflow_run: { ...run, head_branch: 'feature' },
  };
  expect(await handleWorkflowReport('workflow_run', event)).toBe(false);
  expect(mocks.getTask).not.toHaveBeenCalled();
  const store = workflowReportStore(config.taskId);
  await captureWorkflowFeedback(store, '101', 100);
  mocks.download.mockResolvedValue({ run, bytes: bundle({ 'submission.json': '{}' }) });
  await handleWorkflowReport('workflow_run', { ...event, workflow_run: run });
  expect(mocks.send.mock.calls[0][0]).toContain('report could not be imported');
  await expect(readFile(join(store, 'receipts/101-1.json'))).rejects.toThrow();
});

it('reports workflow failure without downloading diagnostics as successful research', async () => {
  await handleWorkflowReport('workflow_run', {
    action: 'completed',
    repository: { full_name: config.repository },
    workflow_run: { ...run, conclusion: 'failure' },
  });
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.send.mock.calls[0][0]).toContain('pending feedback remains pending');
});
