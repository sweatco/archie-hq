/**
 * MCP Tools Implementation
 *
 * Custom tools that agents can call to communicate with each other,
 * log findings, and post to Slack.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentName, FindingType } from '../types/index.js';
import { getAllRepoAgentIds } from '../agents/repo-configs.js';

/**
 * Callback types for tool implementations
 * These are injected by the TaskRuntime when creating agent tools
 */
export interface ToolCallbacks {
  onSendMessage: (target: AgentName, message: string) => Promise<string>;
  onLogFinding: (entry: string, type: FindingType) => Promise<void>;
  onPostToSlack: (message: string) => Promise<void>;
  onReportCompletion: () => Promise<void>;
  onAssignTaskOwner: (agent: AgentName) => Promise<void>;
  onRequestEditMode: (reason: string) => Promise<void>;
}

/**
 * Create the send_message_to_agent tool
 *
 * This tool allows agents to send messages to other agents.
 * The sending agent pauses until a response is received.
 */
export function createSendMessageTool(callbacks: ToolCallbacks) {
  // Build dynamic list of all agents
  const allAgents = ['pm-agent', ...getAllRepoAgentIds()] as [string, ...string[]];

  return tool(
    'send_message_to_agent',
    'Send a message to another agent and wait for their response. Use this to coordinate with peer agents.',
    {
      target: z
        .enum(allAgents)
        .describe('The agent to send the message to'),
      message: z.string().describe('The message content to send'),
    },
    async (args) => {
      const response = await callbacks.onSendMessage(args.target as AgentName, args.message);
      return {
        content: [
          {
            type: 'text' as const,
            text: response,
          },
        ],
      };
    }
  );
}

/**
 * Create the log_finding tool
 *
 * This tool allows agents to write discoveries, decisions, and completions
 * to the shared knowledge log. The agent continues working (no pause).
 */
export function createLogFindingTool(callbacks: ToolCallbacks) {
  return tool(
    'log_finding',
    'Write an entry to the shared knowledge log. Use for discoveries, decisions, completions, or blockers.',
    {
      entry: z.string().describe('The finding or decision to log'),
      type: z
        .enum(['discovery', 'decision', 'completion', 'blocker'])
        .describe('The type of entry'),
    },
    async (args) => {
      await callbacks.onLogFinding(args.entry, args.type as FindingType);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Logged ${args.type}: ${args.entry}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the post_to_slack tool
 *
 * This tool allows the PM agent to post messages to Slack threads.
 */
export function createPostToSlackTool(callbacks: ToolCallbacks) {
  return tool(
    'post_to_slack',
    'Post a message to the Slack thread(s) associated with this task. Write naturally, like a human PM.',
    {
      message: z.string().describe('The message to post to Slack'),
    },
    async (args) => {
      await callbacks.onPostToSlack(args.message);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Posted to Slack: ${args.message}`,
          },
        ],
      };
    }
  );
}


/**
 * Create the assign_task_owner tool
 *
 * This tool allows the PM agent to assign a task owner.
 * The task owner is responsible for leading the investigation.
 */
export function createAssignTaskOwnerTool(callbacks: ToolCallbacks) {
  // Only repo agents can be task owners
  const repoAgents = getAllRepoAgentIds() as [string, ...string[]];

  return tool(
    'assign_task_owner',
    'Assign a task owner who will lead the investigation. Call this before sending the initial assignment message.',
    {
      agent: z
        .enum(repoAgents)
        .describe('The agent to assign as task owner'),
    },
    async (args) => {
      await callbacks.onAssignTaskOwner(args.agent as AgentName);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Assigned ${args.agent} as task owner.`,
          },
        ],
      };
    }
  );
}

/**
 * Create the request_edit_mode tool
 *
 * This tool allows PM to request task-level edit mode approval from the user.
 * When called, it:
 * 1. Logs the request to shared-knowledge.log
 * 2. Posts a Slack message with Approve/Deny buttons
 * 3. Stops the task runtime (pauses all agents)
 *
 * PM should explain findings to user via Slack BEFORE calling this tool.
 */
export function createRequestEditModeTool(callbacks: ToolCallbacks) {
  return tool(
    'request_edit_mode',
    'Request permission to make code changes. Call this AFTER explaining to the user what changes are needed and why. Task will pause until user approves or denies.',
    {
      reason: z.string().describe('Brief summary of what changes need to be made (shown in approval buttons)'),
    },
    async (args) => {
      await callbacks.onRequestEditMode(args.reason);
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Edit mode request sent. Task paused pending user approval.',
          },
        ],
      };
    }
  );
}

/**
 * Create the report_completion tool
 *
 * This tool allows PM to send a final message to the user and complete the task.
 * The message will be posted to Slack and the task will be marked as complete.
 */
export function createReportCompletionTool(callbacks: ToolCallbacks) {
  return tool(
    'report_completion',
    'Send your final message to the user and complete the task. This posts to Slack and closes the task.',
    {
      message: z.string().describe('The final message to send to the user via Slack'),
    },
    async (args) => {
      // Post the message to Slack
      await callbacks.onPostToSlack(args.message);

      // Signal completion (no message needed, already posted above)
      await callbacks.onReportCompletion();

      return {
        content: [
          {
            type: 'text' as const,
            text: 'Posted final message to Slack and marked task as complete.',
          },
        ],
      };
    }
  );
}

/**
 * Create an MCP server with PM agent tools
 */
export function createPMAgentMcpServer(callbacks: ToolCallbacks) {
  return createSdkMcpServer({
    name: 'pm-agent-tools',
    version: '1.0.0',
    tools: [
      createSendMessageTool(callbacks),
      createPostToSlackTool(callbacks),
      createAssignTaskOwnerTool(callbacks),
      createReportCompletionTool(callbacks),
      createRequestEditModeTool(callbacks),
    ],
  });
}

/**
 * Create an MCP server with repo agent tools (Backend, Mobile)
 */
export function createRepoAgentMcpServer(callbacks: ToolCallbacks) {
  return createSdkMcpServer({
    name: 'repo-agent-tools',
    version: '1.0.0',
    tools: [
      createSendMessageTool(callbacks),
      createLogFindingTool(callbacks),
    ],
  });
}

