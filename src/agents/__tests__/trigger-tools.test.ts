/**
 * Handler-level tests for managing a trigger proposal the user has NOT approved
 * yet (`status: 'pending'`).
 *
 * Regression context: pending proposals used to be filtered out of
 * `list_triggers` and rejected by `update_trigger` with "No trigger <id> found."
 * A user who neither approved nor denied a proposal and then asked for a change
 * left the agent boxed in — the revision target was invisible and, when named
 * directly, reported as nonexistent — so its only move was to propose a SECOND
 * trigger and abandon the first as an unreachable orphan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Trigger } from '../../types/trigger.js';

// Heavy deps tools.ts pulls in — mock to import-safe stubs (same as explore-tools.test.ts).
vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../connectors/github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  setupSharedClone: vi.fn().mockResolvedValue({ clone_path: '/wt', branch: 'feat/x', base_branch: 'main' }),
  cloneExists: vi.fn().mockResolvedValue(false),
  isWorktree: vi.fn().mockResolvedValue(false),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  getReposPath: vi.fn().mockReturnValue('/sessions/task-1/repos'),
}));
vi.mock('../../system/logger.js', () => ({
  logger: { agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(), system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../system/event-bus.js', () => ({ emitEvent: vi.fn() }));

// The store is the unit under test's collaborator — fully stubbed so nothing hits disk.
const { loadTrigger, saveTrigger, listTriggers, deleteTrigger, countActiveTriggers } = vi.hoisted(() => ({
  loadTrigger: vi.fn(),
  saveTrigger: vi.fn(),
  listTriggers: vi.fn(),
  deleteTrigger: vi.fn(),
  countActiveTriggers: vi.fn(),
}));
vi.mock('../../system/trigger-store.js', () => ({
  loadTrigger, saveTrigger, listTriggers, deleteTrigger, countActiveTriggers,
  generateTriggerId: vi.fn().mockReturnValue('trg-20260729-1200-newone'),
}));

// Keep the real describe/what/when/where + planStatusChange; stub the I/O ones.
const { announceTriggerChange, indexTrigger, deindexTrigger } = vi.hoisted(() => ({
  announceTriggerChange: vi.fn().mockResolvedValue(undefined),
  indexTrigger: vi.fn(),
  deindexTrigger: vi.fn(),
}));
vi.mock('../../system/trigger-scheduler.js', async (importActual) => {
  const actual = await importActual<typeof import('../../system/trigger-scheduler.js')>();
  return { ...actual, announceTriggerChange, indexTrigger, deindexTrigger, triggersEnabled: () => true };
});

// Origin resolution + privacy: talk to Slack. Force a public-channel origin so
// visibility is never the thing under test here.
vi.mock('../../connectors/slack/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../../connectors/slack/client.js')>();
  return {
    ...actual,
    getChannelInfo: vi.fn().mockResolvedValue({ isIm: false, name: 'growth-operations' }),
    listWorkspaceChannels: vi.fn().mockResolvedValue([{ id: 'C1', isPrivate: false }]),
    getUserInfo: vi.fn().mockResolvedValue({ tz: 'Europe/London' }),
  };
});

import { createOrchestrationMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';

const postInteractiveToUser = vi.fn().mockResolvedValue(undefined);

function makeAgent(): Agent {
  return {
    def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true },
    queue: {} as never,
    session: { active: false },
  } as unknown as Agent;
}

function makeTask(): Task {
  const key = 'slack:C1:1.0';
  return {
    taskId: 'task-1',
    metadata: {
      channels: { [key]: { type: 'slack', channel_id: 'C1', thread_id: '1.0', channel_name: 'growth-operations' } },
      default_channel: key,
    },
    postInteractiveToUser,
    touch: vi.fn(),
    debouncedSave: vi.fn(),
  } as unknown as Task;
}

/** Build the orchestration server and pull a tool's invokable handler out of the registry. */
function getHandler(name: string): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const server = createOrchestrationMcpServer(makeAgent(), makeTask());
  const inst = server.instance as unknown as { _registeredTools?: Record<string, unknown>; _tools?: Iterable<[string, unknown]> };
  const raw = inst._registeredTools ?? Object.fromEntries(inst._tools ?? []);
  const entry = raw[name] as { callback?: unknown; handler?: unknown; cb?: unknown };
  const fn = (entry.callback ?? entry.handler ?? entry.cb) as (a: unknown, b: unknown) => Promise<{ content: { text: string }[] }>;
  return (args) => fn(args, {});
}

const text = (r: { content: { text: string }[] }) => r.content[0].text;

function pendingTrigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trg-20260729-1056-pending',
    status: 'pending',
    created_by: 'U1',
    created_at: '2026-07-29T10:56:00.000Z',
    proposed_in_task: 'task-1',
    binding: { type: 'channel', channel_id: 'C1', channel_name: 'growth-operations' },
    conditions: [{ type: 'schedule', tz: 'Europe/London', next_run_at: '2026-07-30T08:00:00.000Z', cron: '0 9 * * *' }],
    action: { prompt: 'original instruction' },
    summary: 'Original watch',
    ...over,
  } as Trigger;
}

function enabledTrigger(over: Partial<Trigger> = {}): Trigger {
  return pendingTrigger({ id: 'trg-20260723-1401-live', status: 'enabled', summary: 'Live watch', ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  announceTriggerChange.mockResolvedValue(undefined);
  postInteractiveToUser.mockResolvedValue(undefined);
});

describe('list_triggers — pending proposals are visible', () => {
  it('lists a pending proposal, flagged as awaiting approval and not running', async () => {
    listTriggers.mockResolvedValue([pendingTrigger()]);

    const out = text(await getHandler('list_triggers')({}));

    expect(out).toContain('trg-20260729-1056-pending');
    expect(out).toMatch(/awaiting approval/i);
    expect(out).toMatch(/not running/i);
  });

  it('still lists enabled triggers without the awaiting-approval label', async () => {
    listTriggers.mockResolvedValue([enabledTrigger()]);

    const out = text(await getHandler('list_triggers')({}));

    expect(out).toContain('(enabled)');
    expect(out).not.toMatch(/awaiting approval/i);
  });
});

describe('update_trigger — a pending proposal is editable', () => {
  it('edits the proposal instead of reporting it as nonexistent', async () => {
    loadTrigger.mockResolvedValue(pendingTrigger());

    const out = text(await getHandler('update_trigger')({
      id: 'trg-20260729-1056-pending',
      summary: 'Revised watch',
      action_prompt: 'revised instruction',
    }));

    // The regression: this used to be "No trigger ... found."
    expect(out).not.toMatch(/no trigger .* found/i);
    expect(saveTrigger).toHaveBeenCalledOnce();
    const saved = saveTrigger.mock.calls[0][0] as Trigger;
    expect(saved.summary).toBe('Revised watch');
    expect(saved.action.prompt).toBe('revised instruction');
  });

  it('keeps the edited proposal pending and out of the scheduler', async () => {
    loadTrigger.mockResolvedValue(pendingTrigger());

    const out = text(await getHandler('update_trigger')({ id: 'trg-20260729-1056-pending', summary: 'Revised watch' }));

    const saved = saveTrigger.mock.calls[0][0] as Trigger;
    expect(saved.status).toBe('pending');
    expect(indexTrigger).not.toHaveBeenCalled();
    expect(out).toMatch(/not running until the user approves/i);
  });

  it('re-posts an approval card so the user decides on the CURRENT details', async () => {
    loadTrigger.mockResolvedValue(pendingTrigger());

    await getHandler('update_trigger')({ id: 'trg-20260729-1056-pending', summary: 'Revised watch' });

    expect(postInteractiveToUser).toHaveBeenCalledOnce();
    const [cardText, , approvalType, , , ref] = postInteractiveToUser.mock.calls[0];
    expect(cardText).toContain('Revised watch');
    expect(approvalType).toBe('trigger');
    expect(ref).toBe('trg-20260729-1056-pending'); // same id — the old card can't enable a superseded version
  });

  it('does not announce a pending edit to the bound channel — nothing is running yet', async () => {
    loadTrigger.mockResolvedValue(pendingTrigger());

    await getHandler('update_trigger')({ id: 'trg-20260729-1056-pending', summary: 'Revised watch' });

    // Positive assertion first: without it this test passes on ANY path that
    // rejects the update outright (it did — under the pre-fix "No trigger found"
    // bail, and in the DM+private-channel case), so the negative proved nothing.
    expect(saveTrigger).toHaveBeenCalledOnce();
    expect((saveTrigger.mock.calls[0][0] as Trigger).summary).toBe('Revised watch');
    expect(announceTriggerChange).not.toHaveBeenCalled();
  });

  it('refuses to enable a pending proposal — only the user\'s approval can do that', async () => {
    loadTrigger.mockResolvedValue(pendingTrigger());

    const out = text(await getHandler('update_trigger')({ id: 'trg-20260729-1056-pending', status: 'enabled' }));

    expect(out).toMatch(/awaiting the user's approval/i);
    expect(saveTrigger).not.toHaveBeenCalled();
    expect(indexTrigger).not.toHaveBeenCalled();
  });

  it('rejects a pending update that carries no actual edit', async () => {
    loadTrigger.mockResolvedValue(pendingTrigger());

    const out = text(await getHandler('update_trigger')({ id: 'trg-20260729-1056-pending' }));

    expect(out).toMatch(/nothing to update/i);
    expect(saveTrigger).not.toHaveBeenCalled();
  });

  it('still reports a genuinely missing trigger as not found', async () => {
    loadTrigger.mockResolvedValue(null);

    const out = text(await getHandler('update_trigger')({ id: 'trg-20260729-9999-absent', summary: 'x' }));

    expect(out).toMatch(/no trigger .* found/i);
  });

  it('leaves the enabled path intact — edits announce and re-index', async () => {
    loadTrigger.mockResolvedValue(enabledTrigger());
    countActiveTriggers.mockResolvedValue(0);

    const out = text(await getHandler('update_trigger')({ id: 'trg-20260723-1401-live', summary: 'Renamed' }));

    expect(saveTrigger).toHaveBeenCalledOnce();
    expect(indexTrigger).toHaveBeenCalledOnce();
    expect(announceTriggerChange).toHaveBeenCalledOnce();
    expect(out).toMatch(/updated/i);
  });
});

describe('delete_trigger — withdrawing an unapproved proposal', () => {
  it('withdraws the pending file without announcing, and says the card is now inert', async () => {
    loadTrigger.mockResolvedValue(pendingTrigger());

    const out = text(await getHandler('delete_trigger')({ id: 'trg-20260729-1056-pending' }));

    expect(deleteTrigger).toHaveBeenCalledWith('trg-20260729-1056-pending');
    expect(announceTriggerChange).not.toHaveBeenCalled();
    expect(out).toMatch(/withdrawn/i);
    // The card is NOT retracted, so the reply must not claim the button is gone.
    expect(out).toMatch(/inert/i);
    expect(out).not.toMatch(/disables the Approve button/i);
  });

  it('announces when deleting a live trigger', async () => {
    loadTrigger.mockResolvedValue(enabledTrigger());

    await getHandler('delete_trigger')({ id: 'trg-20260723-1401-live' });

    expect(deleteTrigger).toHaveBeenCalledWith('trg-20260723-1401-live');
    expect(announceTriggerChange).toHaveBeenCalledOnce();
  });
});

describe('pending proposals are scoped to the task that proposed them', () => {
  it('a proposal from another task is neither listed nor editable', async () => {
    const foreign = pendingTrigger({ id: 'trg-20260729-1100-foreign', proposed_in_task: 'task-999' });
    listTriggers.mockResolvedValue([foreign]);
    loadTrigger.mockResolvedValue(foreign);

    const listed = text(await getHandler('list_triggers')({}));
    const edited = text(await getHandler('update_trigger')({ id: 'trg-20260729-1100-foreign', summary: 'hijacked' }));

    // Before ownership scoping a PUBLIC-bound pending proposal was visible from
    // every origin, so another conversation could rewrite its action prompt and
    // approve it while created_by still named the original requester.
    expect(listed).not.toContain('trg-20260729-1100-foreign');
    expect(edited).toMatch(/another conversation/i);
    expect(saveTrigger).not.toHaveBeenCalled();
  });

  it('a proposal bound to a PRIVATE channel is still manageable from the DM that made it', async () => {
    // The dead zone's likeliest case: propose_trigger applies no visibility check,
    // so a DM can bind a proposal to a private channel — which binding visibility
    // then hides from that same DM, leaving the agent unable to revise it.
    const priv = pendingTrigger({
      binding: { type: 'channel', channel_id: 'C-PRIVATE', channel_name: 'secret-ops' },
    });
    listTriggers.mockResolvedValue([priv]);
    loadTrigger.mockResolvedValue(priv);

    const listed = text(await getHandler('list_triggers')({}));
    const edited = text(await getHandler('update_trigger')({ id: 'trg-20260729-1056-pending', summary: 'Revised' }));

    expect(listed).toContain('trg-20260729-1056-pending');
    expect(edited).toMatch(/updated and re-posted/i);
    expect(saveTrigger).toHaveBeenCalledOnce();
  });

  it('withdrawal is scoped the same way', async () => {
    const foreign = pendingTrigger({ id: 'trg-20260729-1100-foreign', proposed_in_task: 'task-999' });
    loadTrigger.mockResolvedValue(foreign);

    const out = text(await getHandler('delete_trigger')({ id: 'trg-20260729-1100-foreign' }));

    expect(out).toMatch(/another conversation/i);
    expect(deleteTrigger).not.toHaveBeenCalled();
  });

  it('a legacy proposal with no recorded owner falls back to binding visibility', async () => {
    // Proposals created before proposed_in_task existed must not become
    // unmanageable; their public binding is visible from this origin.
    const legacy = pendingTrigger({ id: 'trg-20260701-0900-legacy', proposed_in_task: undefined });
    listTriggers.mockResolvedValue([legacy]);
    loadTrigger.mockResolvedValue(legacy);

    const listed = text(await getHandler('list_triggers')({}));
    const edited = text(await getHandler('update_trigger')({ id: 'trg-20260701-0900-legacy', summary: 'Revised' }));

    expect(listed).toContain('trg-20260701-0900-legacy');
    expect(edited).toMatch(/updated and re-posted/i);
  });
});

describe('editing a pending proposal is safe against a concurrent approval', () => {
  it('applies the edit to the RE-READ object, so a concurrent content change is not lost', async () => {
    // Re-checking only the status still loses data: the handler would save the copy
    // it read BEFORE the concurrent write. Load #2 carries someone else's prompt
    // change; our summary edit must land on top of it, not erase it.
    loadTrigger
      .mockResolvedValueOnce(pendingTrigger({ action: { prompt: 'FIRST-LOAD' } }))
      .mockResolvedValueOnce(pendingTrigger({ action: { prompt: 'CONCURRENT-WRITE' } }));

    await getHandler('update_trigger')({ id: 'trg-20260729-1056-pending', summary: 'Revised watch' });

    const saved = saveTrigger.mock.calls[0][0] as Trigger;
    expect(saved.action.prompt).toBe('CONCURRENT-WRITE'); // not clobbered back to FIRST-LOAD
    expect(saved.summary).toBe('Revised watch');          // our edit still applied
  });

  it('abandons the edit when the user approves mid-flight, rather than reverting the trigger to pending', async () => {
    // loadTrigger is called twice: once up front, once as the pre-write re-check.
    // Between them the user's Approve lands and flips the file to enabled.
    loadTrigger
      .mockResolvedValueOnce(pendingTrigger())
      .mockResolvedValueOnce(pendingTrigger({ status: 'enabled' }));

    const out = text(await getHandler('update_trigger')({ id: 'trg-20260729-1056-pending', summary: 'Revised watch' }));

    expect(saveTrigger).not.toHaveBeenCalled(); // must not stamp status back to pending
    expect(out).toMatch(/while this edit was in flight/i);
    expect(out).toMatch(/enabled/);
  });

  it('reports a withdrawal that lands mid-flight', async () => {
    loadTrigger
      .mockResolvedValueOnce(pendingTrigger())
      .mockResolvedValueOnce(null);

    const out = text(await getHandler('update_trigger')({ id: 'trg-20260729-1056-pending', summary: 'Revised watch' }));

    expect(saveTrigger).not.toHaveBeenCalled();
    expect(out).toMatch(/withdrawn while this edit was in flight/i);
  });

  it('stamps updated_at so the 24h pending reaper measures from the edit', async () => {
    loadTrigger.mockResolvedValue(pendingTrigger());

    await getHandler('update_trigger')({ id: 'trg-20260729-1056-pending', summary: 'Revised watch' });

    const saved = saveTrigger.mock.calls[0][0] as Trigger;
    expect(saved.updated_at).toBeDefined();
    expect(new Date(saved.updated_at!).getTime()).toBeGreaterThan(new Date(saved.created_at).getTime());
  });
});

describe('propose_trigger records the proposing task', () => {
  it('stamps proposed_in_task so the proposal stays manageable from here', async () => {
    listTriggers.mockResolvedValue([]);
    countActiveTriggers.mockResolvedValue(0);

    await getHandler('propose_trigger')({
      binding: { type: 'channel', channel_id: 'C1', channel_name: 'growth-operations' },
      conditions: [{ type: 'schedule', cron: '0 9 * * *', tz: 'Europe/London' }],
      action_prompt: 'do the thing',
      summary: 'Daily thing',
    });

    expect(saveTrigger).toHaveBeenCalledOnce();
    const saved = saveTrigger.mock.calls[0][0] as Trigger;
    expect(saved.proposed_in_task).toBe('task-1');
    expect(saved.status).toBe('pending');
  });
});
