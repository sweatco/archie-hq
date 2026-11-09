import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKDIR } from '../system/workdir.js';
import type { SandboxOptions } from './sandbox.js';

const configSchema = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  workflow: z.string().regex(/^[\w.-]+\.ya?ml$/),
  branch: z.string().min(1),
  artifact: z.string().min(1),
  taskId: z.string().regex(/^task-\d{8}-\d{4}-[a-z0-9]+$/),
});
export type WorkflowReportConfig = z.infer<typeof configSchema>;

export function workflowReportConfig(): WorkflowReportConfig | undefined {
  return process.env.ARCHIE_WORKFLOW_REPORT
    ? configSchema.parse(JSON.parse(process.env.ARCHIE_WORKFLOW_REPORT))
    : undefined;
}

export const workflowReportStore = (taskId: string) => join(WORKDIR, 'workflow-reports', taskId);

export async function grantWorkflowReportData(opts: SandboxOptions, taskId: string): Promise<SandboxOptions> {
  if (workflowReportConfig()?.taskId !== taskId) return opts;
  const store = workflowReportStore(taskId);
  const writable = ['pending', 'applied'].map((name) => join(store, name));
  const readOnly = ['reports', 'submissions', 'receipts'].map((name) => join(store, name));
  await Promise.all([...readOnly, ...writable].map((path) => mkdir(path, { recursive: true })));
  // A read-only ancestor hides the CLI's writable feedback mounts, so mount sibling directories.
  return {
    ...opts,
    allowReadPaths: [...opts.allowReadPaths, ...readOnly],
    allowWritePaths: [...(opts.allowWritePaths ?? []), ...writable],
  };
}
