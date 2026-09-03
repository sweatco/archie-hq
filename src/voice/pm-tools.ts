/**
 * `join_recall_meeting`/`leave_recall_meeting`: registered via `registerConnectorPmTools` at mount, not
 * the PM's static surface (`src/index.ts`). Distinct from `post_to_user` and the room's spoken `LEAVE:`
 * (`MeetingHost.leaveMeeting`) — no farewell, a PM decision not the room's.
 */
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentName } from '../types/task.js';
import type { Task } from '../tasks/task.js';
import type { Agent } from '../agents/agent.js';
import { logger } from '../system/logger.js';
import type { StartMeetingResult, StopMeetingResult } from './connector.js';

/** What the two tools need from the connector, closed over its own `startMeeting`/`endMeeting` at mount. */
export interface MeetingOps {
  start(taskId: string, meetingUrl: string): Promise<StartMeetingResult>;
  stop(taskId: string): Promise<StopMeetingResult>;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }] });

/** PM-only: `ops.start`'s discriminated result to plain text; never throws. */
function createJoinRecallMeetingTool(agent: Agent, task: Task, ops: MeetingOps) {
  return tool(
    'join_recall_meeting',
    'Have Archie join a live voice meeting (Zoom, Meet or Teams) via Recall and bind it to this task. ' +
    'Returns as soon as the join is under way — it does not wait for the bot to actually land in the call. ' +
    'Once in, Archie listens and speaks for itself; a question it cannot answer on the spot arrives here later as a separate wake-up, answered with `post_to_user` targeted at the channel key that wake-up names.',
    {
      meeting_url: z.string().describe('The meeting link to join, e.g. a Zoom join URL.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Joining voice meeting', args.meeting_url);
      task.touch();
      const result = await ops.start(task.taskId, args.meeting_url);
      if (!result.ok) {
        return err(result.reason);
      }
      return ok(`Joining ${args.meeting_url}. Archie will speak for itself from here.`);
    },
  );
}

/**
 * PM-only counterpart to `join_recall_meeting`, same failure discipline. No args: one task, one live
 * meeting ("One meeting, one task", `docs/architecture/voice.md`). Unlike `join`, awaits full teardown —
 * by "left the meeting," metadata is complete and the channel is marked ended.
 */
function createLeaveRecallMeetingTool(agent: Agent, task: Task, ops: MeetingOps) {
  return tool(
    'leave_recall_meeting',
    'End the live voice meeting (Zoom, Meet or Teams) bound to this task, if there is one. ' +
    'Archie leaves immediately, with no farewell spoken — for a graceful goodbye, answer through `post_to_user` ' +
    'and let the room hear it end the meeting itself. Fails plainly, not a silent no-op, when there is no live meeting on this task.',
    {},
    async () => {
      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Leaving voice meeting', task.taskId);
      task.touch();
      const result = await ops.stop(task.taskId);
      if (!result.ok) {
        return err(result.reason);
      }
      return ok('Left the meeting.');
    },
  );
}

export function createRecallPmToolsServer(agent: Agent, task: Task, ops: MeetingOps) {
  return createSdkMcpServer({
    name: 'recall-tools',
    version: '1.0.0',
    tools: [
      createJoinRecallMeetingTool(agent, task, ops),
      createLeaveRecallMeetingTool(agent, task, ops),
    ],
  });
}
