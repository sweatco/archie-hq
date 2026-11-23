/**
 * Plays one eval case on a running instance over the HTTP API. The first turn
 * creates a task and each later turn is a message to it; after every turn the
 * driver follows the task's events until it settles, answering the approvals
 * the case specifies for that turn.
 *
 * Task state comes from the same wait logic the scripted E2E scenarios use
 * (tools/debug-mcp/wait-for-task.ts). The driver needs no agent session and no
 * MCP server: `ArchieClient` satisfies `DriverClient`, and tests pass a fake.
 */

import { z } from 'zod';
import { waitForTask, type TaskClient, type WaitDeps } from '../debug-mcp/wait-for-task.js';

/**
 * A `merge` approval is left out: resolving one needs the pull request's
 * identity, which a case cannot know before the run.
 */
const approvalAnswerSchema = z.object({
  type: z.enum(['edit_mode', 'research_budget', 'trigger', 'tool_call', 'max_mode']),
  approve: z.boolean(),
});

const caseTurnSchema = z.object({
  message: z.string().trim().min(1),
  /** Answers to the approvals this turn is expected to raise, each used once. */
  approvals: z.array(approvalAnswerSchema).default([]),
});

/** A case as a promptfoo test writes it in `vars`. */
export const evalCaseSchema = z.object({
  caseId: z.string().trim().min(1),
  turns: z.array(caseTurnSchema).min(1),
});

export type CaseTurn = z.infer<typeof caseTurnSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;

export interface DriverClient extends TaskClient {
  createTask(message: string): Promise<string>;
  sendMessage(taskId: string, message: string): Promise<void>;
  approve(
    taskId: string,
    type: string,
    approve: boolean,
    item?: { ref?: string },
  ): Promise<{ stale: boolean }>;
}

export interface PlayOptions {
  /** How long one turn, approvals included, may take to settle. */
  turnTimeoutSeconds: number;
  /** How long a task is followed after a turn timed out, to learn whether it stopped running. */
  timedOutHoldSeconds: number;
  wait?: Pick<WaitDeps, 'now' | 'sleep' | 'pollIntervalMs'>;
}

/**
 * `settled`: every turn was played and the task completed or stopped.
 * `awaiting_approval`: a turn raised an approval the case does not answer.
 * `timed_out`: a turn did not settle in time. No later turn or approval is
 * played; `stillRunning` says whether the task was still going when the hold
 * ran out.
 */
export type PlayEnd =
  { end: 'settled' } | { end: 'awaiting_approval' } | { end: 'timed_out'; stillRunning: boolean };

export type PlayOutcome = PlayEnd & {
  taskId: string;
  /** Turns sent, including one that did not settle. */
  turnsPlayed: number;
  approvalsAnswered: number;
};

export async function playCase(
  client: DriverClient,
  turns: CaseTurn[],
  options: PlayOptions,
): Promise<PlayOutcome> {
  const [firstTurn, ...laterTurns] = turns;
  if (!firstTurn) throw new Error('a case needs at least one turn');

  const taskId = await client.createTask(firstTurn.message);

  let turn = await followTurn(client, taskId, firstTurn, undefined, options);
  let turnsPlayed = 1;
  let approvalsAnswered = turn.approvalsAnswered;
  for (const laterTurn of laterTurns) {
    if (turn.result.end !== 'settled') break;
    await client.sendMessage(taskId, laterTurn.message);
    turn = await followTurn(client, taskId, laterTurn, turn.cursor, options);
    turnsPlayed += 1;
    approvalsAnswered += turn.approvalsAnswered;
  }
  return { ...turn.result, taskId, turnsPlayed, approvalsAnswered };
}

interface TurnEnd {
  result: PlayEnd;
  /** Where the next turn resumes reading events. */
  cursor: number | undefined;
  approvalsAnswered: number;
}

async function followTurn(
  client: DriverClient,
  taskId: string,
  turn: CaseTurn,
  startCursor: number | undefined,
  options: PlayOptions,
): Promise<TurnEnd> {
  const now = options.wait?.now ?? Date.now;
  const deadline = now() + options.turnTimeoutSeconds * 1000;
  const unusedAnswers = [...turn.approvals];
  let cursor = startCursor;
  let approvalsAnswered = 0;

  for (;;) {
    const remainingSeconds = Math.max(0, (deadline - now()) / 1000);
    const wait = await waitForTask(
      client,
      { taskId, cursor, timeoutSeconds: remainingSeconds },
      { ...options.wait, capSeconds: remainingSeconds },
    );
    cursor = wait.cursor;

    if (wait.state === 'completed' || wait.state === 'stopped') {
      return { result: { end: 'settled' }, cursor, approvalsAnswered };
    }
    if (wait.state !== 'approval_requested') {
      const result = await holdTimedOutTask(client, taskId, cursor, options);
      return { result, cursor, approvalsAnswered };
    }

    const answerIndex = unusedAnswers.findIndex((answer) => answer.type === wait.approval_type);
    const answer = unusedAnswers[answerIndex];
    if (!answer) return { result: { end: 'awaiting_approval' }, cursor, approvalsAnswered };
    unusedAnswers.splice(answerIndex, 1);

    const { stale } = await client.approve(taskId, answer.type, answer.approve, {
      ref: wait.approval_ref,
    });
    if (stale) {
      throw new Error(`the ${answer.type} approval on ${taskId} was no longer pending`);
    }
    approvalsAnswered += 1;
  }
}

/**
 * A turn timed out, but its task may go on running and the API has no way to
 * stop it. Keep following it, answering nothing, so the caller can hold the
 * task's place on the instance until it settles or the hold runs out.
 */
async function holdTimedOutTask(
  client: DriverClient,
  taskId: string,
  cursor: number | undefined,
  options: PlayOptions,
): Promise<PlayEnd> {
  const held = await waitForTask(
    client,
    { taskId, cursor, timeoutSeconds: options.timedOutHoldSeconds },
    { ...options.wait, capSeconds: options.timedOutHoldSeconds },
  );
  // Completed, stopped or asking for an approval: the task has finished its work, or will once the turn that asked ends.
  return { end: 'timed_out', stillRunning: held.state === 'pending' };
}
