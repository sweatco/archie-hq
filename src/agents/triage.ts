/**
 * Triage Agent
 *
 * Lightweight event classifier using Haiku model.
 * Handles Slack messages and GitHub PR comments.
 * Other GitHub events use deterministic routing.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { join } from "path";
import pc from "picocolors";
import type { TriageResult, SlackMessage } from "../types/index.js";
import { findTaskIdByThread } from "../system/task-runtime.js";
import { processAgentEventForLogging, logger } from "../system/logger.js";
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
  const sessionsDir = join(process.cwd(), "sessions");

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
 * Build context for Slack message triage
 */
function buildSlackContext(threadId: string): string {
  const existingTaskId = findTaskIdByThread(threadId);
  if (existingTaskId) {
    return `THREAD MATCH: This thread (${threadId}) belongs to task ${existingTaskId}`;
  }
  return "No thread match found in active tasks. Use tools if needed to search historical tasks.";
}

/**
 * Run the triage agent to classify a Slack message
 */
export async function triageSlackMessage(
  message: SlackMessage,
  threadHistory: SlackMessage[]
): Promise<TriageResult> {
  const threadId = message.thread_ts || message.ts;
  const context = buildSlackContext(threadId);

  const input = `
Slack Message:
- Thread ID: ${threadId}
- Channel: ${message.channel}
- User: ${message.user}

Thread History:
${threadHistory.map((m) => `[${m.user}]: ${m.text}`).join("\n")}

Current Message:
${message.text}

${context}

Classify this Slack message and respond with JSON only.`;

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
