/**
 * Agent Logging Utilities
 *
 * Centralized logging for agent tool calls with path trimming
 */

import { relative } from 'path';

// Project root path to trim from all file paths
const PROJECT_ROOT = process.cwd();

/**
 * Trim a file path to be relative to one of the provided directories
 * Returns the shortest relative path found, or the original path if none match
 */
function trimFilePath(filePath: string, cwds: string[]): string {
  let shortest = filePath;
  let shortestLength = filePath.length;

  // Try each cwd in order
  for (const cwd of cwds) {
    if (filePath.startsWith(cwd)) {
      const rel = relative(cwd, filePath);
      // Only use if it doesn't start with .. (going outside the directory)
      if (!rel.startsWith('..') && rel.length < shortestLength) {
        shortest = rel;
        shortestLength = rel.length;
      }
    }
  }

  // If no match found, try project root as fallback
  if (shortest === filePath && filePath.startsWith(PROJECT_ROOT)) {
    const rel = relative(PROJECT_ROOT, filePath);
    if (!rel.startsWith('..')) {
      shortest = rel;
    }
  }

  return shortest;
}

/**
 * Log a tool call from an agent with formatted output
 */
export function logAgentToolCall(
  agentName: string,
  toolName: string,
  input: any,
  cwds: string[]
): void {
  if (toolName === 'Read') {
    const displayPath = trimFilePath(input.file_path, cwds);
    console.log(`[${agentName}] Reading: ${displayPath}`);
  } else if (toolName === 'Write') {
    const displayPath = trimFilePath(input.file_path, cwds);
    console.log(`[${agentName}] Writing: ${displayPath}`);
  } else if (toolName === 'Edit') {
    const displayPath = trimFilePath(input.file_path, cwds);
    console.log(`[${agentName}] Editing: ${displayPath}`);
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
 * Filters out MCP tools and only logs Read, Write, Edit, Grep, Glob operations
 */
export function processAgentEventForLogging(
  event: any,
  agentName: string,
  cwds: string[]
): void {
  if (event.type === 'assistant') {
    const content = event.message.content;
    if (typeof content !== 'string') {
      for (const block of content) {
        if (block.type === 'tool_use') {
          const toolName = block.name;
          const input = block.input as any;

          // Only log file operation tools (not MCP tools)
          if (['Read', 'Write', 'Edit', 'Grep', 'Glob'].includes(toolName)) {
            logAgentToolCall(agentName, toolName, input, cwds);
          }
        }
      }
    }
  }
}
