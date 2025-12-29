/**
 * Agent Logging Utilities
 *
 * Centralized logging for agent tool calls with path trimming
 */

import { relative } from 'path';

// Project root path to trim from all file paths
const PROJECT_ROOT = process.cwd();

/**
 * Trim a file path to be relative to cwd first, then relative to project root
 */
function trimFilePath(filePath: string, cwd: string): string {
  // First try relative to cwd
  if (filePath.startsWith(cwd)) {
    return relative(cwd, filePath);
  }

  // Then try relative to project root
  if (filePath.startsWith(PROJECT_ROOT)) {
    return relative(PROJECT_ROOT, filePath);
  }

  // Otherwise return as-is
  return filePath;
}

/**
 * Log a tool call from an agent with formatted output
 */
export function logAgentToolCall(
  agentName: string,
  toolName: string,
  input: any,
  cwd: string
): void {
  if (toolName === 'Read') {
    const displayPath = trimFilePath(input.file_path, cwd);
    console.log(`[${agentName}] Reading: ${displayPath}`);
  } else if (toolName === 'Grep') {
    console.log(`[${agentName}] Searching: "${input.pattern}"`);
  } else if (toolName === 'Glob') {
    console.log(`[${agentName}] Globbing: ${input.pattern}`);
  } else {
    // Generic fallback for any other tools
    console.log(`[${agentName}] Tool: ${toolName}`);
  }
}

/**
 * Process agent events and log file operation tool calls
 * Filters out MCP tools and only logs Read, Grep, Glob operations
 */
export function processAgentEventForLogging(
  event: any,
  agentName: string,
  cwd: string
): void {
  if (event.type === 'assistant') {
    const content = event.message.content;
    if (typeof content !== 'string') {
      for (const block of content) {
        if (block.type === 'tool_use') {
          const toolName = block.name;
          const input = block.input as any;

          // Only log file operation tools (not MCP tools)
          if (['Read', 'Grep', 'Glob'].includes(toolName)) {
            logAgentToolCall(agentName, toolName, input, cwd);
          }
        }
      }
    }
  }
}
