/**
 * One eval instance as a live provider drives it: the HTTP client, what the
 * instance and its checkout say about themselves, and the rule that ties the
 * two together. A task created over the URL must show up as a folder in the
 * checkout, since the session record is read from there.
 *
 * Nothing links a URL to a checkout before a task exists: two worktrees of one
 * commit attest the same ref. So the first tasks are created one at a time
 * until one is seen in the checkout. With a URL paired to the wrong checkout
 * that costs one task, not a run of trials whose records can never be read.
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { ArchieClient } from '../../debug-mcp/archie-client.js';
import { EVAL_DIR } from '../../e2e/eval-profile.js';
import type { DriverClient } from '../live-driver.js';
import type { EvalInstance } from './live-settings.js';

export interface InstanceFacts {
  /** The commit the instance attests on `/health`, with `-dirty` when its checkout had changes. */
  ref: string;
  /** Claude Agent SDK version in the checkout's lockfile, which the instance image is built from. */
  sdkVersion: string;
}

const SDK_PACKAGE = 'node_modules/@anthropic-ai/claude-agent-sdk';
const UNKNOWN = 'unknown';
const TASK_FOLDER_POLL_MS = 100;

const healthSchema = z.object({ git_sha: z.string().nullish() });
const lockfileSchema = z.object({
  packages: z.record(z.string(), z.object({ version: z.string().optional() })),
});

export class LiveInstance {
  private readonly api: ArchieClient;
  private readonly sessionsDir: string;
  private facts: Promise<InstanceFacts> | undefined;
  private checkoutConfirmed = false;
  private checkoutMismatch: Error | undefined;
  /** The creation that is confirming the checkout, while one is under way. */
  private confirming: Promise<string> | undefined;

  /** `taskFolderWaitMs`: how long a created task's folder may take to appear in the checkout. */
  constructor(
    private readonly instance: EvalInstance,
    private readonly taskFolderWaitMs: number,
  ) {
    this.api = new ArchieClient(instance.url);
    this.sessionsDir = join(instance.checkout, EVAL_DIR, 'workdir', 'sessions');
  }

  describe(): Promise<InstanceFacts> {
    this.facts ??= readInstanceFacts(this.instance);
    return this.facts;
  }

  taskDir(taskId: string): string {
    return join(this.sessionsDir, taskId);
  }

  /**
   * The client one trial drives. `noteCreated` hears of the trial's task as
   * soon as the instance has it, even when the checkout check then fails: the
   * task is running and has to be paid for either way.
   */
  clientForTrial(noteCreated: (taskId: string) => void): DriverClient {
    return {
      listTasks: () => this.api.listTasks(),
      getEvents: (taskId, after) => this.api.getEvents(taskId, after),
      sendMessage: (taskId, message) => this.api.sendMessage(taskId, message),
      approve: (taskId, type, approve, item) => this.api.approve(taskId, type, approve, item),
      createTask: (message) => this.createTask(message, noteCreated),
    };
  }

  private async createTask(
    message: string,
    noteCreated: (taskId: string) => void,
  ): Promise<string> {
    // Other creations wait for the one confirming the checkout. If it fails
    // before making a task, the first of them takes over.
    while (!this.checkoutConfirmed && this.confirming) {
      await this.confirming.catch(() => undefined);
    }
    if (this.checkoutMismatch) throw this.checkoutMismatch;

    const create = async (): Promise<string> => {
      const taskId = await this.api.createTask(message);
      noteCreated(taskId);
      if (!this.checkoutConfirmed) await this.confirmInCheckout(taskId);
      return taskId;
    };
    if (this.checkoutConfirmed) return create();

    const confirming = create();
    this.confirming = confirming;
    try {
      return await confirming;
    } finally {
      this.confirming = undefined;
    }
  }

  /** The engine makes a task's folder before it answers, so only a slow bind mount needs the wait. */
  private async confirmInCheckout(taskId: string): Promise<void> {
    const taskDir = this.taskDir(taskId);
    const deadline = Date.now() + this.taskFolderWaitMs;
    while (!existsSync(taskDir)) {
      if (Date.now() >= deadline) {
        const { url, checkout } = this.instance;
        this.checkoutMismatch = new Error(
          `${url} created ${taskId}, but ${taskDir} does not exist: the instance at that URL ` +
            `was not booted from ${checkout}. Give each --instance the URL its own checkout's boot printed.`,
        );
        throw this.checkoutMismatch;
      }
      await new Promise((resolve) => setTimeout(resolve, TASK_FOLDER_POLL_MS));
    }
    this.checkoutConfirmed = true;
  }
}

async function readInstanceFacts(instance: EvalInstance): Promise<InstanceFacts> {
  if (!existsSync(join(instance.checkout, EVAL_DIR, 'workdir'))) {
    throw new Error(
      `${instance.checkout} has no ${EVAL_DIR}/workdir: boot it with \`npx tsx tools/e2e/boot.ts --profile eval\``,
    );
  }
  const health = await fetch(`${instance.url}/health`);
  if (!health.ok) throw new Error(`${instance.url}/health answered ${health.status}`);
  const { git_sha: ref } = healthSchema.parse(await health.json());

  return { ref: ref ?? UNKNOWN, sdkVersion: await readSdkVersion(instance.checkout) };
}

async function readSdkVersion(checkout: string): Promise<string> {
  const lockfilePath = join(checkout, 'package-lock.json');
  if (!existsSync(lockfilePath)) return UNKNOWN;
  const lockfile = lockfileSchema.parse(JSON.parse(await readFile(lockfilePath, 'utf8')));
  return lockfile.packages[SDK_PACKAGE]?.version ?? UNKNOWN;
}
