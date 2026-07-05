/**
 * Thin typed wrapper over child_process for the archie-e2e harness CLIs
 * (docker compose invocations). Cores take ExecFn as an injected dependency,
 * so they stay fake-able in tests; only CLI mains call makeExec.
 *
 * ExecFn never rejects: spawn failures (e.g. docker not installed) surface as
 * a non-zero code with the error message in stderr, so orchestration cores
 * handle exactly one failure shape.
 */

import { spawn } from 'child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface ExecOptions {
  cwd?: string;
  /** Mirror the child's output to this process's stderr as it streams (useful for long docker builds). */
  echo?: boolean;
}

export function makeExec(options: ExecOptions = {}): ExecFn {
  return (cmd, args) =>
    new Promise<ExecResult>((resolve) => {
      const child = spawn(cmd, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (options.echo) process.stderr.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (options.echo) process.stderr.write(chunk);
      });
      child.on('error', (err) => {
        resolve({ code: 127, stdout, stderr: `${stderr}${stderr ? '\n' : ''}failed to spawn ${cmd}: ${err.message}` });
      });
      child.on('close', (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}
