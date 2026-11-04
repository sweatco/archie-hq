import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Options, SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata } from '../../types/task.js';

const { queryMock, root } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'archie-refusal-'));
  process.env.ARCHIE_WORKDIR = root;
  return { queryMock: vi.fn(), root };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: queryMock,
}));
vi.mock('../../system/logger.js', () => ({
  logger: { agent: vi.fn(), warn: vi.fn(), error: vi.fn(), system: vi.fn(), debug: vi.fn(), agentToSlack: vi.fn() },
  processAgentEventForLogging: vi.fn(),
}));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  resolvePeopleFromTranscript: vi.fn().mockResolvedValue([]),
  postSlackMessage: vi.fn().mockResolvedValue('1750000000.000100'),
}));
vi.mock('../../tasks/persistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../tasks/persistence.js')>()),
  appendUsageRecord: vi.fn().mockResolvedValue(undefined),
  appendMessageToUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../connectors/slack/status.js', () => ({ setSlackThreadStatus: vi.fn().mockResolvedValue(undefined) }));

import { Task, activeTasks, RUNTIME_VERSION } from '../../tasks/task.js';
import { spawnAgent } from '../spawn.js';
import type { Agent } from '../agent.js';
import { findRefusalCheckpoint } from '../refusal-recovery.js';
import { appendCliMessage, getSharedPath, getTaskPath } from '../../tasks/persistence.js';
import { logger } from '../../system/logger.js';
import { postSlackMessage } from '../../connectors/slack/client.js';
import { onEvent, offEvent, type SystemEvent } from '../../system/event-bus.js';

const TaskCtor = Task as unknown as new (id: string, metadata: TaskMetadata, def: AgentDef) => Task;
const PM = { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', visibility: 'global', isPm: true, pluginName: 'core', model: 'opus' } as AgentDef;
type Scenario = (options: Options, prompt: AsyncGenerator<SDKUserMessage>) => AsyncGenerator<SDKMessage>;
let scenario: Scenario;
let task: Task;
let events: SystemEvent[];
let inputs: string[];
let currentInput: SDKUserMessage | undefined;
let cancelledInputs: string[];
const collect = (event: SystemEvent) => events.push(event);

function assistant(parent: string | null = null, details: Partial<NonNullable<SDKAssistantMessage['message']['stop_details']>> | null = { type: 'refusal', category: 'reasoning_extraction', explanation: null }): SDKMessage {
  return {
    type: 'assistant', parent_tool_use_id: parent, uuid: randomUUID(), session_id: 'session-1', request_id: 'request-1',
    user_message_uuid: parent ? undefined : currentInput?.uuid,
    message: { id: 'message-1', model: 'claude-opus-5-5', content: [], stop_reason: 'refusal', stop_details: details },
  } as unknown as SDKMessage;
}

function result(stop = 'refusal', subtype = 'success', queued = 0): SDKMessage {
  return {
    type: 'result', uuid: randomUUID(), session_id: 'session-1', subtype, stop_reason: stop,
    user_message_uuid: currentInput?.uuid,
    num_turns: 1, total_cost_usd: 0, modelUsage: {}, usage: {}, queued_turn_count: queued,
  } as SDKMessage;
}

async function stopHook(options: Options): Promise<void> {
  await options.hooks!.Stop![0]!.hooks[0]!({ hook_event_name: 'Stop', background_tasks: [] } as never, undefined, { signal: new AbortController().signal });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  events = [];
  inputs = [];
  currentInput = undefined;
  cancelledInputs = [];
  onEvent(collect);
  const id = `task-20261011-0000-${randomUUID().slice(0, 6)}`;
  await mkdir(getSharedPath(id), { recursive: true });
  await writeFile(`${getSharedPath(id)}/knowledge.log`, '');
  task = new TaskCtor(id, {
    task_id: id, status: 'in_progress', channels: { 'cli:local': { type: 'cli', id: 'cli:local' } },
    default_channel: 'cli:local', agent_sessions: {}, repositories: [], runtime_version: RUNTIME_VERSION,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), edit_allowed: true,
  }, PM);
  queryMock.mockImplementation(({ options, prompt }: { options: Options; prompt: AsyncGenerator<SDKUserMessage> }) => {
    const stream = (async function* () {
      currentInput = (await prompt.next()).value!;
      inputs.push(String(currentInput!.message.content));
      yield {
        type: 'system', subtype: 'init', session_id: options.forkSession ? 'session-2' : options.resume ?? 'session-1', model: 'claude-opus-5-5',
        plugins: options.plugins?.map((plugin) => ({ name: 'core', path: plugin.path })), mcp_servers: [],
      } as unknown as SDKMessage;
      yield* scenario(options, prompt);
    })();
    return Object.assign(stream, {
      mcpServerStatus: async () => [],
      interrupt: vi.fn(async () => ({ still_queued: [], cancelled: cancelledInputs })),
      close: () => options.abortController!.abort(),
    });
  });
});

afterEach(async () => {
  await task.stop();
  await task.agent?.handle?.running;
  await task.save(true);
  activeTasks.delete(task.taskId);
  offEvent(collect);
  vi.clearAllTimers();
  vi.useRealTimers();
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function run(): Promise<void> {
  await task.sendMessage('Investigate this request.');
  await task.agent!.handle!.running;
}

function useSlackChannel(muted = false): void {
  task.metadata.channels = { 'slack:C1:1.0': { type: 'slack', channel_id: 'C1', thread_id: '1.0', channel_name: 'ops', last_processed_ts: '1.0', muted } };
  task.metadata.default_channel = 'slack:C1:1.0';
  task = new TaskCtor(task.taskId, task.metadata, PM);
}

async function writeSession(parentUuid: string | null, sessionId = 'session-1'): Promise<void> {
  const dir = `${getTaskPath(task.taskId)}/claude/pm/session/projects/fixture`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${sessionId}.jsonl`, [
    { type: 'assistant', uuid: 'kept-assistant', message: { content: [{ type: 'tool_use', id: 'completion' }] } },
    { type: 'user', uuid: 'kept-carrier', parentUuid: 'kept-assistant', message: { content: [{ type: 'tool_result', tool_use_id: 'completion', content: 'done' }] } },
    { type: 'attachment', uuid: 'kept-output', parentUuid: 'kept-carrier', attachment: { type: 'structured_output', output: 'done' } },
    { type: 'user', uuid: currentInput!.uuid, parentUuid, message: currentInput!.message },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
}

describe('model refusal in the production SDK loop', () => {
  it.each(['../outside', '/tmp/outside', 'task-20261014-0000-safe/../../outside'])('rejects unsafe task paths before spawning: %s', async (taskId) => {
    await expect(spawnAgent({ def: PM } as Agent, { taskId } as Task)).rejects.toThrow('Invalid task ID');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it.each([`${root}/outside`, `${root}/sessions-other`, `${root}/sessions/../../outside`])('does not scan checkpoint paths outside the sessions root: %s', async (configDir) => {
    await expect(findRefusalCheckpoint(configDir, 'session-1', 'input-1')).resolves.toBeUndefined();
  });

  it.each(['../session', '/etc/session', 'session/../../outside'])('rejects session IDs containing paths: %s', async (sessionId) => {
    await expect(findRefusalCheckpoint(`${getTaskPath(task.taskId)}/claude/pm/session`, sessionId, 'input-1')).resolves.toBeUndefined();
  });

  it.each(['success', 'error_during_execution'])('pauses a %s result without a Stop hook and preserves the session', async (subtype) => {
    scenario = async function* () {
      await vi.advanceTimersByTimeAsync(800);
      yield assistant();
      yield result('refusal', subtype);
    };
    await run();
    expect(task.metadata.status).toBe('stopped');
    expect(task.metadata.agent_sessions['pm-agent']).toMatchObject({ session_id: 'session-1', active: false });
    expect(events.filter((event) => event.type === 'message')).toHaveLength(1);
    expect(events.find((event) => event.type === 'message')?.data.message).toContain('Reason: reasoning extraction');
    expect(events.find((event) => event.type === 'agent:log')?.data).toMatchObject({ category: 'reasoning_extraction', model: 'claude-opus-5-5', request_id: 'request-1' });
    expect(events.filter((event) => event.type === 'status').at(-1)?.data.status).toBe('');
    await vi.advanceTimersByTimeAsync(5000);
    expect(task.recoveryAttempts).toBe(0);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('handles a result-only refusal and duplicate results once', async () => {
    const refused = result();
    scenario = async function* () { yield refused; yield refused; };
    await run();
    expect(task.metadata.status).toBe('stopped');
    expect(events.filter((event) => event.type === 'message')).toHaveLength(1);
    expect(events.find((event) => event.type === 'agent:log')?.data.category).toBeNull();
    expect(events.find((event) => event.type === 'message')?.data.message).toContain('Reason: No reason was provided.');
  });

  it.each([
    ['  The request asks for private internal reasoning.  ', 'The request asks for private internal reasoning.'],
    ['  ', 'reasoning extraction'],
  ])('shows the provider refusal reason (%j)', async (explanation, reason) => {
    scenario = async function* () {
      yield assistant(null, { type: 'refusal', category: 'reasoning_extraction', explanation });
      yield result();
    };
    await run();
    expect(events.find((event) => event.type === 'message')?.data.message).toBe(
      `The model declined this request. I’ve paused this task.\n\nReason: ${reason}`,
    );
  });

  it('suppresses idle recovery while the result and notification are delayed', async () => {
    useSlackChannel();
    vi.mocked(postSlackMessage).mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      expect(task.recoveryAttempts).toBe(0);
      return undefined;
    });
    scenario = async function* (options) {
      yield assistant(null, null);
      await stopHook(options);
      await vi.advanceTimersByTimeAsync(5000);
      expect(task.recoveryAttempts).toBe(0);
      yield result();
    };
    await run();
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    expect(task.metadata.status).toBe('stopped');
  });

  it('still stops when delivering the notice fails', async () => {
    useSlackChannel();
    vi.mocked(postSlackMessage).mockRejectedValueOnce(new Error('Slack unavailable'));
    scenario = async function* () { yield assistant(); yield result(); };
    await run();
    expect(task.metadata.status).toBe('stopped');
    expect(task.agent!.pendingTeardown).toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('releases incoming delivery after a refusal notice times out', async () => {
    useSlackChannel();
    vi.mocked(postSlackMessage).mockImplementationOnce(() => new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Slack request timed out')), 5000);
    }));
    scenario = async function* () { yield assistant(); yield result(); };
    await task.sendMessage('Investigate this request.');
    const oldHandle = task.agent!.handle!;
    await vi.waitFor(() => expect(postSlackMessage).toHaveBeenCalledTimes(1));
    const reply = task.sendMessage('Please continue.');
    scenario = async function* (options) {
      task.setCompletionIntent();
      await stopHook(options);
      yield result('end_turn');
    };
    await vi.advanceTimersByTimeAsync(5000);
    await oldHandle.running;
    await reply;
    await task.agent!.handle!.running;
    expect(inputs).toEqual(['Investigate this request.', 'Please continue.']);
    expect(task.recoveryAttempts).toBe(0);
    expect(logger.error).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('completed');
  });

  it('pauses and accepts a new wake without waiting for PR-card delivery', async () => {
    useSlackChannel();
    task.metadata.repositories = [{ github: 'acme/app', branch_states: { feature: { pr_number: 42 } } }];
    let releaseCards!: () => void;
    const cards = vi.spyOn(task, 'resurfacePrCards').mockReturnValue(new Promise<void>((resolve) => { releaseCards = resolve; }));
    scenario = async function* () { yield assistant(); yield result(); };
    await task.sendMessage('Investigate this request.');
    const oldHandle = task.agent!.handle!;
    try {
      await vi.waitFor(() => expect(task.metadata.status).toBe('stopped'), { timeout: 1000 });
      expect(cards).not.toHaveBeenCalled();
      await oldHandle.running;
      scenario = async function* () { yield result('end_turn'); };
      await task.sendMessage('Continue despite stalled PR-card delivery.');
      await task.agent!.handle!.running;
      expect(inputs).toEqual(['Investigate this request.', 'Continue despite stalled PR-card delivery.']);
      releaseCards();
      await task.stop();
      expect(cards).toHaveBeenCalledTimes(1);
    } finally {
      releaseCards();
      await oldHandle.running;
      cards.mockRestore();
    }
  });

  it('opens the task-owned failure thread for a trigger without a thread', async () => {
    task.metadata.channels = {};
    task.metadata.default_channel = null;
    task.metadata.home_channel = { channel_id: 'C1', channel_name: 'ops' };
    task = new TaskCtor(task.taskId, task.metadata, PM);
    scenario = async function* () { yield assistant(); yield result(); };
    await run();
    expect(logger.error).not.toHaveBeenCalled();
    expect(task.metadata.default_channel).toBe('slack:C1:1750000000.000100');
    expect(postSlackMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1' }), true);
    expect(task.metadata.status).toBe('stopped');
  });

  it('does not notify a muted thread', async () => {
    useSlackChannel(true);
    scenario = async function* () { yield assistant(); yield result(); };
    await run();
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(task.metadata.status).toBe('stopped');
  });

  it('leaves a worker refusal to the PM', async () => {
    scenario = async function* (options) {
      yield assistant('worker-tool');
      task.setCompletionIntent();
      await stopHook(options);
      yield result('end_turn');
    };
    await run();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('completed');
    expect(events.some((event) => event.type === 'agent:log')).toBe(false);
  });

  it('disables model switching and pauses a refusal with no retry', async () => {
    scenario = async function* (options) {
      expect(options.settings).toMatchObject({ switchModelsOnFlag: false });
      yield assistant(null, { type: 'refusal', category: 'cyber', explanation: null });
      yield result();
    };
    await run();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('stopped');
    expect(events.find((event) => event.type === 'agent:log')?.data).toMatchObject({
      finding: 'Model refused a turn (cyber)', category: 'cyber', model: 'claude-opus-5-5',
    });
    expect(task.recoveryAttempts).toBe(0);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('pauses instead of replaying when the stream fails after a refusal', async () => {
    task.metadata.agent_sessions['pm-agent'] = { session_id: 'session-1', active: false };
    scenario = async function* () { yield assistant(); throw new Error('stream closed'); };
    await run();
    expect(task.metadata.status).toBe('stopped');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('retains a refusal through subsequent API errors', async () => {
    task.metadata.agent_sessions['pm-agent'] = { session_id: 'session-1', active: false };
    scenario = async function* () {
      yield assistant();
      yield { ...assistant(), type: 'assistant', error: 'unknown', message: { id: 'error-2', content: [], stop_reason: null } } as unknown as SDKMessage;
      throw new Error('stream closed');
    };
    await run();
    expect(task.metadata.status).toBe('stopped');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary API errors on the existing recovery path', async () => {
    scenario = async function* (options, prompt) {
      yield result('max_tokens', 'error_during_execution');
      expect((await prompt.next()).value?.message.content).toContain('RECOVERY');
      task.setCompletionIntent();
      await stopHook(options);
      yield result('end_turn');
    };
    await task.sendMessage('Investigate this request.');
    await vi.waitFor(() => expect(task.agent!.session.active).toBe(false));
    await vi.advanceTimersByTimeAsync(3000);
    await task.agent!.handle!.running;
    expect(task.recoveryAttempts).toBe(1);
    expect(events.some((event) => event.type === 'agent:log')).toBe(false);
  });

  it('preserves an approval teardown already pending when the model refuses', async () => {
    const teardown = vi.fn(async () => { await task.stop(); });
    scenario = async function* () {
      task.agent!.deferTeardown(teardown);
      yield assistant();
      yield result();
    };
    await run();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(task.metadata.status).toBe('stopped');
    expect(task.agent!.session.refusal_recovery).toEqual({ prompt_uuid: currentInput!.uuid });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('cancels background work when the task pauses (result received: %s)', async (hasResult) => {
    let signal: AbortSignal;
    scenario = async function* (options) {
      signal = options.abortController!.signal;
      yield { type: 'system', subtype: 'task_started', task_id: 'worker-1', description: 'worker' } as SDKMessage;
      yield assistant();
      if (hasResult) yield result();
    };
    await run();
    expect(signal!.aborted).toBe(true);
    expect(events.find((event) => event.type === 'agent:bg_task' && event.data.action === 'end')?.data.status).toBe('cancelled');
  });

  it.each([0, 1])('preserves a newer wake, whether queued locally or prefetched by the SDK (%s)', async (prefetched) => {
    const oldQueryContinued = vi.fn();
    scenario = async function* (options, prompt) {
      if (queryMock.mock.calls.length === 1) {
        await writeSession('kept-output');
        await task.sendMessage('Continue with this newer request.');
        if (prefetched) cancelledInputs = [(await prompt.next()).value!.uuid!];
        yield assistant();
        yield result('refusal', 'success', prefetched);
        oldQueryContinued();
      } else {
        if (queryMock.mock.calls.length === 2) {
          expect(options).toMatchObject({ resume: 'session-1', resumeSessionAt: 'kept-output', forkSession: true });
          expect(currentInput!.message.content).toBe('Continue with this newer request.');
        }
        task.setCompletionIntent();
        await stopHook(options);
        yield result('end_turn');
      }
    };
    await run();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('completed');
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(oldQueryContinued).not.toHaveBeenCalled();
    expect(queryMock.mock.results[0]!.value.interrupt).toHaveBeenCalledWith({ cancelQueued: true });
    expect(task.agent!.session.refusal_recovery).toBeUndefined();
    expect(inputs).toEqual(['Investigate this request.', 'Continue with this newer request.']);

    await task.sendMessage('Keep the recovered conversation.');
    await task.agent!.handle!.running;
    expect(queryMock.mock.calls[2]![0].options).toMatchObject({ resume: 'session-2' });
    expect(queryMock.mock.calls[2]![0].options.resumeSessionAt).toBeUndefined();
  });

  it('starts cancellation before waiting for the task activation lock', async () => {
    const pause = task.pauseAfterRefusal.bind(task);
    vi.spyOn(task, 'pauseAfterRefusal').mockImplementation(async (...args) => {
      // The SDK can claim the next queued turn while the lifecycle lock waits.
      cancelledInputs = [];
      await pause(...args);
    });
    scenario = async function* (options, prompt) {
      if (queryMock.mock.calls.length === 1) {
        await writeSession('kept-output');
        await task.sendMessage('A queued follow-up.');
        cancelledInputs = [(await prompt.next()).value!.uuid!];
        yield assistant();
        yield result();
      } else {
        expect(options.resumeSessionAt).toBe('kept-output');
        task.setCompletionIntent();
        await stopHook(options);
        yield result('end_turn');
      }
    };
    await run();
    expect(inputs).toEqual(['Investigate this request.', 'A queued follow-up.']);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'error_during_execution'])('preserves input prefetched after a %s refusal result snapshot', async (subtype) => {
    const processFollowUp = vi.fn();
    scenario = async function* (options, prompt) {
      if (queryMock.mock.calls.length === 1) {
        await writeSession('kept-output');
        const snapshot = result('refusal', subtype, 0);
        await task.sendMessage('Follow-up after the result snapshot.');
        cancelledInputs = [(await prompt.next()).value!.uuid!];
        yield assistant();
        yield snapshot;
      } else {
        expect(options.resumeSessionAt).toBe('kept-output');
        processFollowUp(currentInput!.message.content);
        task.setCompletionIntent();
        await stopHook(options);
        yield result('end_turn');
      }
    };
    await run();
    expect(processFollowUp).toHaveBeenCalledExactlyOnceWith('Follow-up after the result snapshot.');
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(task.agent!.session.refusal_recovery).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('completed');
  });

  it.each([false, true])('does not repeat a folded input without another echo or result (stream throws: %s)', async (throws) => {
    const sideEffect = vi.fn();
    scenario = async function* (options, prompt) {
      if (queryMock.mock.calls.length === 1) {
        yield { ...assistant(), message: { id: 'message-1', content: [], stop_reason: null } } as unknown as SDKMessage;
        await task.sendMessage('An input folded into a later tool round.');
        sideEffect((await prompt.next()).value!.message.content);
        yield { ...assistant(), user_message_uuid: undefined } as SDKMessage;
        if (throws) throw new Error('stream closed');
      } else {
        sideEffect(currentInput!.message.content);
        task.setCompletionIntent();
        await stopHook(options);
        yield result('end_turn');
      }
    };
    await run();
    expect(sideEffect).toHaveBeenCalledExactlyOnceWith('An input folded into a later tool round.');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(task.metadata.status).toBe('stopped');
  });

  it.each([false, true])('preserves a locally queued follow-up without a result (stream throws: %s)', async (throws) => {
    scenario = async function* (options, prompt) {
      if (queryMock.mock.calls.length === 1) {
        await task.sendMessage('Continue with this newer request.');
        // Only the first response block carries the input correlation.
        yield { ...assistant(), message: { id: 'message-1', content: [], stop_reason: null } } as unknown as SDKMessage;
        yield { ...assistant(), user_message_uuid: undefined } as SDKMessage;
        if (throws) throw new Error('stream closed');
      } else {
        task.setCompletionIntent();
        await stopHook(options);
        yield result('end_turn');
      }
    };
    await run();
    expect(inputs).toEqual(['Investigate this request.', 'Continue with this newer request.']);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1]![0].options.resume).toBeUndefined();
    expect(events.filter((event) => event.type === 'message').map((event) => event.data.message)).toEqual([
      'The model declined this request. I’ll continue with the next message.\n\nReason: reasoning extraction',
    ]);
    expect(task.recoveryAttempts).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('completed');
  });

  it('pauses ambiguous inputs after an earlier completed turn and retains their audit record', async () => {
    scenario = async function* (options, prompt) {
      if (queryMock.mock.calls.length === 1) {
        yield result('end_turn');
        await task.sendMessage('This turn will refuse.');
        const refused = (await prompt.next()).value!;
        await appendCliMessage(task.taskId, 'This follow-up must survive.');
        await task.sendMessage('This follow-up must survive.');
        await prompt.next();
        yield { ...assistant(), user_message_uuid: refused.uuid } as SDKMessage;
        throw new Error('stream closed');
      } else {
        task.setCompletionIntent();
        await stopHook(options);
        yield result('end_turn');
      }
    };
    await run();
    expect(inputs).toEqual(['Investigate this request.']);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(task.metadata.status).toBe('stopped');
    expect(task.metadata.agent_sessions['pm-agent']).toMatchObject({ session_id: 'session-1', active: false });
    expect(await readFile(`${getSharedPath(task.taskId)}/knowledge.log`, 'utf8')).toContain('This follow-up must survive.');
  });

  it('recovers confirmed cancelled input when the stream closes without a result', async () => {
    scenario = async function* (options, prompt) {
      if (queryMock.mock.calls.length === 1) {
        await writeSession('kept-output');
        await task.sendMessage('A confirmed unexecuted follow-up.');
        cancelledInputs = [(await prompt.next()).value!.uuid!];
        yield assistant();
        throw new Error('Stream closed');
      } else {
        expect(options.resumeSessionAt).toBe('kept-output');
        task.setCompletionIntent();
        await stopHook(options);
        yield result('end_turn');
      }
    };
    await run();
    expect(inputs).toEqual(['Investigate this request.', 'A confirmed unexecuted follow-up.']);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(task.agent!.session.refusal_recovery).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('completed');
  });

  it('recognizes inputs folded into the final result as consumed', async () => {
    scenario = async function* (_options, prompt) {
      await task.sendMessage('An input folded into the refused turn.');
      const folded = (await prompt.next()).value!;
      yield assistant();
      yield { ...result(), user_message_uuids: [currentInput!.uuid!, folded.uuid!] } as SDKMessage;
    };
    await run();
    expect(task.metadata.status).toBe('stopped');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('does not replay prefetched input without cancellation confirmation (request fails: %s)', async (fails) => {
    scenario = async function* (_options, prompt) {
      await task.sendMessage('An unconfirmed prefetched request.');
      await prompt.next();
      const sdk = queryMock.mock.results[0]!.value;
      if (fails) sdk.interrupt.mockRejectedValueOnce(new Error('Control channel closed'));
      else sdk.interrupt.mockResolvedValueOnce(undefined);
      yield assistant();
      yield result('refusal', 'success', 1);
    };
    await run();
    expect(task.metadata.status).toBe('stopped');
    expect(inputs).toEqual(['Investigate this request.']);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled cancellation request before pausing', async () => {
    let rejectInterrupt: (error: Error) => void;
    scenario = async function* (options) {
      const sdk = queryMock.mock.results[0]!.value;
      sdk.interrupt.mockImplementationOnce(() => new Promise((_, reject) => { rejectInterrupt = reject; }));
      sdk.close = () => {
        options.abortController!.abort();
        rejectInterrupt(new Error('Query closed'));
      };
      yield assistant();
      yield result();
    };
    await task.sendMessage('Investigate this request.');
    await vi.waitFor(() => expect(queryMock.mock.results[0]!.value.interrupt).toHaveBeenCalledWith({ cancelQueued: true }));
    await vi.advanceTimersByTimeAsync(5000);
    await task.agent!.handle!.running;
    expect(task.metadata.status).toBe('stopped');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not replay inputs folded into the refused turn', async () => {
    scenario = async function* (_options, prompt) {
      await task.sendMessage('A message the SDK folded into the same turn.');
      const folded = (await prompt.next()).value!;
      yield { ...assistant(), user_message_uuid: folded.uuid, user_message_uuids: [currentInput!.uuid!, folded.uuid!] } as SDKMessage;
      throw new Error('stream closed');
    };
    await run();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(task.metadata.status).toBe('stopped');
    expect(events.filter((event) => event.type === 'message')).toHaveLength(1);
  });

  it.each([false, true])('reopens after teardown without losing a concurrent reply (separate caller: %s)', async (separateCaller) => {
    useSlackChannel();
    let reply: Promise<void> | undefined;
    vi.mocked(postSlackMessage).mockImplementationOnce(async () => {
      const caller = separateCaller ? new TaskCtor(task.taskId, { ...task.metadata }, PM) : task;
      reply = caller.sendMessage('Please continue.');
      return '1750000000.000100';
    });
    scenario = async function* () { yield assistant(); yield result(); };
    await task.sendMessage('Investigate this request.');
    const oldHandle = task.agent!.handle!;
    await oldHandle.running;
    scenario = async function* (options, prompt) {
      await vi.advanceTimersByTimeAsync(800);
      expect(events.filter((event) => event.type === 'status').at(-1)?.data.status).toBe('is working on this…');
      task.setCompletionIntent();
      await stopHook(options);
      yield result('end_turn');
    };
    await reply;
    await task.agent!.handle!.running;
    expect(task.agent!.handle).not.toBe(oldHandle);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1]![0].options.resume).toBeUndefined();
    expect(inputs).toEqual(['Investigate this request.', 'Please continue.']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('completed');
  });

  it('recovers a first-turn refusal after a server restart without resubmitting its context', async () => {
    scenario = async function* () { yield assistant(); yield result(); };
    await run();
    const metadata = JSON.parse(await readFile(`${getSharedPath(task.taskId)}/metadata.json`, 'utf8')) as TaskMetadata;
    expect(metadata.status).toBe('stopped');
    task = new TaskCtor(task.taskId, metadata, PM);
    scenario = async function* (options) {
      task.setCompletionIntent();
      await stopHook(options);
      yield result('end_turn');
    };
    await run();
    expect(queryMock.mock.calls[1]![0].options.resume).toBeUndefined();
    expect(queryMock.mock.calls[1]![0].options.systemPrompt).toContain('Do not retry it or reload it');
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('completed');
  });

  it.each([false, true])('preserves completed tool output when reopening after refusal (guard rejects: %s)', async (rejects) => {
    let refusedUuid: string;
    scenario = async function* (options, prompt) {
      const attempt = queryMock.mock.calls.length;
      if (attempt === 1) {
        yield result('end_turn');
        await task.sendMessage('A request that will refuse.');
        currentInput = (await prompt.next()).value!;
        refusedUuid = currentInput!.uuid!;
        await writeSession('kept-output');
        yield assistant();
        yield result();
      } else if (attempt === 2 && rejects) {
        options.abortController!.abort();
        yield { ...result('end_turn', 'error_during_execution'), errors: ['Resume rejected by --resume-drops-turn: another user input was recorded'] } as SDKMessage;
      } else {
        task.setCompletionIntent();
        await stopHook(options);
        yield result('end_turn');
      }
    };
    await run();
    expect(task.agent!.session.refusal_recovery).toEqual({ prompt_uuid: refusedUuid! });
    await task.sendMessage('Continue with this safe request.');
    await task.agent!.handle!.running;
    expect(queryMock.mock.calls[1]![0].options).toMatchObject({
      resume: 'session-1', resumeSessionAt: 'kept-output', resumeDropsTurn: refusedUuid!, forkSession: true,
    });
    if (rejects) {
      expect(queryMock.mock.calls[2]![0].options.resume).toBeUndefined();
      expect(queryMock.mock.calls[2]![0].options.resumeSessionAt).toBeUndefined();
      expect(queryMock.mock.calls[2]![0].options.abortController.signal.aborted).toBe(false);
      expect(inputs.at(-1)).toContain('Continue with this safe request.');
      expect(inputs.at(-1)).not.toContain('A request that will refuse.');
      expect(inputs.at(-1)).not.toContain('read_thread');
    }
    expect(task.agent!.session.refusal_recovery).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('completed');
  });

  it.each([false, true])('keeps the latest checkpoint after consecutive refusals (assistant frame: %s)', async (hasAssistant) => {
    let firstUuid!: string;
    let secondUuid!: string;
    let markerAfterAssistant: Agent['session']['refusal_recovery'];
    scenario = async function* (options) {
      const attempt = queryMock.mock.calls.length;
      if (attempt === 1) {
        firstUuid = currentInput!.uuid!;
        await writeSession('kept-output');
        yield assistant();
        yield result();
      } else if (attempt === 2) {
        expect(options.resumeDropsTurn).toBe(firstUuid);
        secondUuid = currentInput!.uuid!;
        await writeSession('kept-output', 'session-2');
        if (hasAssistant) {
          yield assistant();
          markerAfterAssistant = task.agent!.session.refusal_recovery;
        }
        yield result();
      } else {
        expect(options).toMatchObject({ resume: 'session-2', resumeSessionAt: 'kept-output', resumeDropsTurn: secondUuid, forkSession: true });
        task.setCompletionIntent();
        await stopHook(options);
        yield result('end_turn');
      }
    };
    await run();
    await task.sendMessage('A second request that also refuses.');
    await task.agent!.handle!.running;
    expect(task.agent!.session.refusal_recovery).toEqual({ prompt_uuid: secondUuid });
    if (hasAssistant) expect(task.agent!.session.refusal_recovery).toBe(markerAfterAssistant);
    await task.save(true);
    const metadata = JSON.parse(await readFile(`${getSharedPath(task.taskId)}/metadata.json`, 'utf8')) as TaskMetadata;
    task = new TaskCtor(task.taskId, metadata, PM);
    await task.sendMessage('Continue with a safe request.');
    await task.agent!.handle!.running;
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(task.agent!.session.refusal_recovery).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task.metadata.status).toBe('completed');
  });
});
