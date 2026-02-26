/**
 * Triage Agent
 *
 * Lightweight classifier using Haiku model.
 * Slack messages: classifies intent (new_task, existing_task, cancel_task, noop)
 * GitHub PR comments: classifies actionability (existing_task, noop)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import pc from "picocolors";
import type { TriageResult, SlackThread } from "../types/index.js";
import { findTaskByThread } from "../tasks/persistence.js";
import { SESSIONS_DIR } from "./workdir.js";
import { processAgentEventForLogging, logger } from "./logger.js";
import { loadPrompt } from "../utils/prompt-loader.js";

/**
 * Slack triage schema - allows Slack-specific actions
 */
const SlackTriageSchema = z.object({
  action: z.enum([
    "new_task",
    "existing_task",
    "cancel_task",
    "noop",
  ]),
  task_id: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  similar_tasks: z.array(z.string()).optional(),
  reasoning: z.string(),
});

/**
 * Run the triage agent with given input and schema
 */
async function runTriage<T extends z.ZodType>(
  input: string,
  schema: T,
  logLabel: string
): Promise<z.infer<T>> {
  const systemPrompt = await loadPrompt("triage-agent", {});
  const jsonSchema = zodToJsonSchema(schema, { $refStrategy: "none" });
  const sessionsDir = SESSIONS_DIR;

  let result: z.infer<T> | null = null;

  logger.system(`Running triage-agent for ${logLabel}...`);

  for await (const event of query({
    prompt: input,
    options: {
      model: 'haiku',
      systemPrompt,
      cwd: sessionsDir,
      executable: "node",
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || "claude",
      env: {
        NODE_ENV: process.env.NODE_ENV || "development",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        PATH: process.env.PATH,
      },
      allowedTools: ["Glob", "Grep", "Read"],
      outputFormat: {
        type: "json_schema",
        schema: jsonSchema,
      },
    },
  })) {
    processAgentEventForLogging(event, "triage-agent", [sessionsDir]);

    if (event.type === "result") {
      if (event.subtype === "success" && event.structured_output) {
        const parsed = schema.safeParse(event.structured_output);
        if (parsed.success) {
          result = parsed.data;
          const decision = {
            action: parsed.data.action,
            taskId: parsed.data.task_id || "(none)",
            confidence: parsed.data.confidence,
            reasoning: parsed.data.reasoning,
          };
          const label = pc.yellow("[triage-agent]");
          console.log(`${label} ${pc.yellow(`[${logLabel}]`)}:`, decision);
        } else {
          logger.error("triage-agent", "Validation failed", parsed.error);
        }
      } else if (event.subtype === "error_max_structured_output_retries") {
        logger.error(
          "triage-agent",
          "Failed to produce valid structured output after retries"
        );
      } else if (event.subtype === "error_during_execution") {
        logger.error("triage-agent", "Error during execution", event.errors);
      }
    }
  }

  // Return result or default fallback
  if (result) {
    return result;
  }

  // Type-safe default based on schema - parse a minimal valid object
  return schema.parse({
    action: "noop",
    confidence: "low",
    reasoning: "Default fallback",
  });
}

// ============================================================================
// Slack Message Triage
// ============================================================================

/**
 * Build the full triage input from a resolved SlackThread.
 * Looks up existing task by thread ID and constructs the classification prompt.
 */
async function buildTriageInput(thread: SlackThread): Promise<string> {
  const taskId = await findTaskByThread(thread.threadId);

  const context = taskId
    ? `THREAD MATCH: This thread (${thread.threadId}) belongs to task ${taskId}. Classify the user's intent and respond with JSON.`
    : `No thread match found. Use tools if needed to search historical tasks. Classify this message and respond with JSON.`;

  const currentMessage = thread.messages.find((m) => m.ts === thread.currentMessageTs);

  return `
Slack Message:
- Thread ID: ${thread.threadId}
- Channel: ${thread.channel.id}
- User: ${currentMessage?.user.realName ?? 'unknown'}

Thread History:
${thread.messages.map((m) => `[${m.user.realName}]: ${m.text}`).join("\n")}

Current Message:
${currentMessage?.text ?? ''}

${context}`;
}

/**
 * Run the triage agent to classify a Slack thread
 */
export async function triageSlackMessage(
  thread: SlackThread
): Promise<TriageResult> {
  const input = await buildTriageInput(thread);

  const result = await runTriage(input, SlackTriageSchema, "slack");

  return {
    action: result.action,
    task_id: result.task_id,
    confidence: result.confidence,
    similar_tasks: result.similar_tasks,
  };
}

// ============================================================================
// GitHub PR Comment Triage
// ============================================================================

/**
 * GitHub PR comment for triage
 */
export interface GitHubComment {
  id: number;
  user: string;
  body: string;
  createdAt: string;
}

/**
 * GitHub comment triage result - simpler than Slack (only existing_task or noop)
 */
export interface GitHubCommentTriageResult {
  action: "existing_task" | "noop";
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

/**
 * GitHub comment triage schema - only existing_task or noop
 */
const GitHubCommentTriageSchema = z.object({
  action: z.enum(["existing_task", "noop"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
});

/**
 * Run the triage agent to classify a GitHub PR comment
 *
 * Determines if a PR comment requires PM attention or can be ignored.
 * - existing_task: Actionable feedback (change request, bug report, blocker, question)
 * - noop: Conversational (acknowledgment, thanks, simple confirmation)
 */
export async function triageGitHubComment(
  currentComment: GitHubComment,
  commentHistory: GitHubComment[],
  prNumber: number,
  githubRepo: string
): Promise<GitHubCommentTriageResult> {
  const input = `
GitHub PR Comment:
- Repository: ${githubRepo}
- PR Number: #${prNumber}
- Comment Author: ${currentComment.user}

Comment Thread History:
${commentHistory.map((c) => `[${c.user}]: ${c.body}`).join("\n")}

Current Comment:
[${currentComment.user}]: ${currentComment.body}

Classify this PR comment. Use:
- "existing_task" if this comment requires action (change request, bug report, question needing answer, blocker, technical feedback)
- "noop" if this comment is conversational (acknowledgment like "Done", "Thanks", "LGTM", simple confirmations, or resolved discussions)

Respond with JSON only.`;

  logger.system(`GitHub triage input for PR #${prNumber}:\n${input}`);

  const result = await runTriage(
    input,
    GitHubCommentTriageSchema,
    `github-pr-${prNumber}`
  );

  return {
    action: result.action,
    confidence: result.confidence,
    reasoning: result.reasoning,
  };
}
