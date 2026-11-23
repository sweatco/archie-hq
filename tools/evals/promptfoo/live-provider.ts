/**
 * promptfoo provider that runs a case on a live eval instance. `config.instance`
 * names one of the instances given to run.ts with `--instance`; the test's vars
 * hold the case (`caseId` and `turns`, see ../live-driver.ts). Each call plays
 * one trial over the HTTP API, then builds the session record from the task
 * folder in the instance's checkout and returns it in the replay provider's
 * response shape, so the same assertions grade both.
 *
 * Two providers in one config are the two arms of a paired run, and promptfoo's
 * repeats are the trials. The providers of a run share one spend budget and one
 * task limit per instance, both held in this module: promptfoo loads it once
 * per run.
 */

import { z } from 'zod';
import { evalCaseSchema, playCase, type EvalCase, type PlayOutcome } from '../live-driver.js';
import { buildSessionRecord, type BuiltRecord } from '../session-record.js';
import { LiveInstance } from './live-instance.js';
import { readLiveSettings } from './live-settings.js';
import {
  buildRecordResponse,
  type RecordMetadata,
  type RecordResponse,
} from './record-response.js';
import { SpendBudget } from './spend-budget.js';

const configSchema = z.object({
  instance: z.string().min(1),
  /**
   * Tasks run at once on the instance. Six is the most that has been run on
   * one instance (2026-11-18); raise the default only with a measured run.
   */
  maxConcurrency: z.number().int().positive().default(6),
  /** What one trial is assumed to cost before any has been measured. */
  trialReserveUsd: z.number().positive().default(0.5),
  turnTimeoutSeconds: z.number().positive().default(600),
  /**
   * How long a task whose turn timed out keeps its place on the instance while
   * it is still running. The API cannot stop a task, so freeing the place at
   * once would put more than `maxConcurrency` tasks on the instance.
   */
  timedOutHoldSeconds: z.number().nonnegative().default(900),
  /**
   * How long to wait, once a trial has ended, for the usage of the PM's last
   * turn. The engine writes it when the SDK reports the turn's result, which
   * can trail the event that settled the task.
   */
  recordSettleSeconds: z.number().nonnegative().default(60),
  /** Pause between reads while waiting on a task: its events over the API, then its folder. */
  pollIntervalMs: z.number().nonnegative().default(2000),
  /** How long a created task's folder may take to appear in the checkout. */
  taskFolderWaitSeconds: z.number().nonnegative().default(5),
});

type LiveConfig = z.infer<typeof configSchema>;

interface ProviderOptions {
  config?: unknown;
}

interface CallApiContext {
  vars?: Record<string, unknown>;
  /** promptfoo's zero-based repeat number. */
  repeatIndex?: number;
}

export interface LiveMetadata extends RecordMetadata {
  live: {
    instance: string;
    ref: string;
    sdkVersion: string;
    end: PlayOutcome['end'];
    /** True when a timed-out task had not stopped by the end of its hold. */
    stillRunning: boolean;
    turnsPlayed: number;
    approvalsAnswered: number;
    /** False when the usage of the PM's last turn never arrived, so the recorded cost is too low. */
    costComplete: boolean;
    spend: {
      /** The cost the task recorded. */
      trialUsd: number | null;
      /** What the budget counted: at least the reservation when the recorded cost is only a lower bound. */
      countedUsd: number;
      runSpentUsd: number;
      capUsd: number;
    };
  };
}

type Limiter = <T>(run: () => Promise<T>) => Promise<T>;

let runBudget: SpendBudget | undefined;
const instanceLimiters = new Map<string, Limiter>();

export default class LiveProvider {
  private readonly config: LiveConfig;
  private readonly instance: LiveInstance;
  private readonly budget: SpendBudget;
  private readonly limit: Limiter;
  private spentUsd = 0;
  private trials = 0;

  constructor(options: ProviderOptions = {}) {
    this.config = configSchema.parse(options.config);
    const settings = readLiveSettings(process.env);
    const instance =
      settings && Object.hasOwn(settings.instances, this.config.instance)
        ? settings.instances[this.config.instance]
        : undefined;
    if (!settings || !instance) {
      throw new Error(
        `no eval instance "${this.config.instance}" in this run: start it through ` +
          `tools/evals/promptfoo/run.ts with --instance ${this.config.instance}=<url>,<checkout> and --spend-cap-usd`,
      );
    }
    this.instance = new LiveInstance(instance, this.config.taskFolderWaitSeconds * 1000);
    runBudget ??= new SpendBudget(settings.spendCapUsd);
    this.budget = runBudget;

    const limiter = instanceLimiters.get(instance.url) ?? createLimiter(this.config.maxConcurrency);
    instanceLimiters.set(instance.url, limiter);
    this.limit = limiter;
  }

  id(): string {
    return `archie-live:${this.config.instance}`;
  }

  async callApi(_prompt: string, context?: CallApiContext): Promise<RecordResponse<LiveMetadata>> {
    const parsed = evalCaseSchema.safeParse(context?.vars);
    if (!parsed.success) {
      return { error: `the test's vars are not a case: ${z.prettifyError(parsed.error)}` };
    }
    const trial = context?.repeatIndex ?? 0;
    // The slot is held until the trial's task has stopped running or its hold has run out.
    return this.limit(() => this.runTrial(parsed.data, trial));
  }

  /** promptfoo calls this once the run is over. */
  cleanup(): void {
    const run = this.budget.summary();
    console.error(
      `live[${this.config.instance}]: ${this.trials} trial(s), $${this.spentUsd.toFixed(2)}; ` +
        `run total $${run.spentUsd.toFixed(2)} of the $${run.capUsd.toFixed(2)} cap` +
        (run.refusedTrials > 0 ? `, ${run.refusedTrials} trial(s) not started` : '') +
        (run.unmeasuredTrials > 0 ? `, ${run.unmeasuredTrials} counted at their reservation` : ''),
    );
  }

  private async runTrial(evalCase: EvalCase, trial: number): Promise<RecordResponse<LiveMetadata>> {
    const facts = await this.instance.describe();

    const reservation = await this.budget.reserve(this.config.trialReserveUsd);
    if (!reservation.ok) return { error: reservation.reason };
    const { reservedUsd } = reservation;

    let taskId: string | undefined;
    let outcome: PlayOutcome;
    let stillRunning: boolean;
    let built: BuiltRecord;
    try {
      const client = this.instance.clientForTrial((created) => (taskId = created));
      outcome = await playCase(client, evalCase.turns, {
        turnTimeoutSeconds: this.config.turnTimeoutSeconds,
        timedOutHoldSeconds: this.config.timedOutHoldSeconds,
        wait: { pollIntervalMs: this.config.pollIntervalMs },
      });
      stillRunning = outcome.end === 'timed_out' && outcome.stillRunning;
      built = await readSettledRecord(this.instance.taskDir(outcome.taskId), {
        // A task that is still running has no last turn to wait for.
        waitMs: stillRunning ? 0 : this.config.recordSettleSeconds * 1000,
        intervalMs: this.config.pollIntervalMs,
      });
    } catch (error) {
      if (taskId === undefined) {
        this.budget.release(reservedUsd);
      } else {
        // The task exists and may run on, so what it has recorded is at best a lower bound.
        const recordedUsd = await recordedCost(this.instance.taskDir(taskId));
        this.settle(reservedUsd, atLeast(reservedUsd, recordedUsd));
      }
      throw error;
    }

    // After a timeout, or without the last turn's usage, the recorded cost is only a lower bound.
    const trialUsd = built.record.usage.costUsd;
    const costIsWhole = outcome.end !== 'timed_out' && built.costComplete;
    const countedUsd = this.settle(
      reservedUsd,
      costIsWhole ? trialUsd : atLeast(reservedUsd, trialUsd),
    );
    built.record.eval = { caseId: evalCase.caseId, ref: facts.ref, trial };

    const run = this.budget.summary();
    const recorded = trialUsd === null ? 'no cost recorded' : `$${trialUsd.toFixed(2)}`;
    console.error(
      `live[${this.config.instance}]: ${evalCase.caseId} trial ${trial} ended ${built.record.terminalState} ` +
        `(${recorded}${costIsWhole ? '' : `, counted as $${countedUsd.toFixed(2)}`}); ` +
        `run spend $${run.spentUsd.toFixed(2)} of $${run.capUsd.toFixed(2)}`,
    );

    const response = buildRecordResponse(built);
    const metadata: LiveMetadata = {
      ...response.metadata,
      live: {
        instance: this.config.instance,
        ref: facts.ref,
        sdkVersion: facts.sdkVersion,
        end: outcome.end,
        stillRunning,
        turnsPlayed: outcome.turnsPlayed,
        approvalsAnswered: outcome.approvalsAnswered,
        costComplete: built.costComplete,
        spend: { trialUsd, countedUsd, runSpentUsd: run.spentUsd, capUsd: run.capUsd },
      },
    };
    return { ...response, metadata };
  }

  /** Settle a trial with the budget and return what it counted; `null` counts the reservation. */
  private settle(reservedUsd: number, costUsd: number | null): number {
    this.budget.settle(reservedUsd, costUsd);
    const countedUsd = costUsd ?? reservedUsd;
    this.trials += 1;
    this.spentUsd += countedUsd;
    return countedUsd;
  }
}

/** A cost that may be understated counts as the reservation or what was recorded, whichever is more. */
function atLeast(reservedUsd: number, recordedUsd: number | null): number | null {
  return recordedUsd === null ? null : Math.max(recordedUsd, reservedUsd);
}

/** Runs at most `limit` calls at once; the rest wait in arrival order. */
function createLimiter(limit: number): Limiter {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (run) => {
    if (running < limit) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await run();
    } finally {
      // A finished call hands its slot straight to the next waiter, so a new arrival cannot take it first.
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/**
 * Read the task's record once the usage of the PM's last turn is in it, or
 * when the wait runs out; `costComplete` on the result says which.
 */
async function readSettledRecord(
  taskDir: string,
  wait: { waitMs: number; intervalMs: number },
): Promise<BuiltRecord> {
  const deadline = Date.now() + wait.waitMs;
  for (;;) {
    const built = await buildSessionRecord(taskDir, 'eval');
    if (built.costComplete || Date.now() >= deadline) return built;
    await new Promise((resolve) => setTimeout(resolve, wait.intervalMs));
  }
}

/** What a task whose trial failed is known to have cost; null when that cannot be read. */
async function recordedCost(taskDir: string): Promise<number | null> {
  try {
    return (await buildSessionRecord(taskDir, 'eval')).record.usage.costUsd;
  } catch {
    return null;
  }
}
