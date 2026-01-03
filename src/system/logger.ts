/**
 * Unified Logging System
 *
 * Centralized, color-coded logging for the entire system.
 * Handles system events, agent operations, Slack integration, and errors.
 */

import { relative } from 'path';
import pc from 'picocolors';
import type { AgentName } from '../types/index.js';

// Project root path to trim from all file paths
const PROJECT_ROOT = process.cwd();

// Check if colors should be disabled (CI environments, piped output, etc.)
const COLORS_ENABLED = !process.env.NO_COLOR && process.stdout.isTTY;

// Color helper that respects NO_COLOR
const c = COLORS_ENABLED ? pc : {
  blue: (s: string) => s,
  green: (s: string) => s,
  cyan: (s: string) => s,
  magenta: (s: string) => s,
  yellow: (s: string) => s,
  red: (s: string) => s,
  dim: (s: string) => s,
  bold: (s: string) => s,
  gray: (s: string) => s,
};

/**
 * Agent name to color mapping
 */
const AGENT_COLORS: Record<string, (s: string) => string> = {
  'pm-agent': pc.magenta,
  'backend-agent': pc.green,
  'mobile-agent': pc.cyan,
  'triage-agent': pc.yellow,
};


/**
 * Get color for an agent name
 */
function getAgentColor(agentName: string): (s: string) => string {
  return AGENT_COLORS[agentName] || pc.green; // Default to green for unknown agents
}

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
 * Format an agent label with mode suffix
 */
function formatAgentLabel(agentName: string, editMode?: boolean): string {
  const colorFn = getAgentColor(agentName);

  if (editMode === undefined) {
    return colorFn(`[${agentName}]`);
  }

  const mode = editMode ? ':rw' : ':ro';
  const modeColor = editMode ? c.red : colorFn;
  return colorFn('[') + colorFn(agentName) + modeColor(mode) + colorFn(']');
}

/**
 * Unified Logger class
 */
export class Logger {
  /**
   * Log a system event
   */
  system(message: string): void {
    console.log(`${c.dim('[System]')} ${message}`);
  }

  /**
   * Log a Slack event
   */
  slack(message: string): void {
    console.log(`${c.cyan('[Slack]')} ${message}`);
  }

  /**
   * Log a worktree manager event
   */
  worktree(message: string): void {
    console.log(`${c.dim('[worktree-manager]')} ${message}`);
  }

  /**
   * Log a server event
   */
  server(message: string): void {
    console.log(`${c.dim('[Server]')} ${message}`);
  }

  /**
   * Log a generic agent message
   */
  agent(agentName: string, message: string, opts?: { editMode?: boolean }): void {
    const label = formatAgentLabel(agentName, opts?.editMode);
    console.log(`${label} ${message}`);
  }

  /**
   * Log an agent tool call (Read, Write, Edit, Grep, Glob)
   */
  agentTool(
    agentName: string,
    toolName: string,
    input: any,
    opts?: { editMode?: boolean; cwds?: string[] }
  ): void {
    const label = formatAgentLabel(agentName, opts?.editMode);
    const cwds = opts?.cwds || [];

    if (toolName === 'Read') {
      const displayPath = trimFilePath(input.file_path, cwds);
      console.log(`${label} ${c.dim('Reading:')} ${displayPath}`);
    } else if (toolName === 'Write') {
      const displayPath = trimFilePath(input.file_path, cwds);
      console.log(`${label} ${c.dim('Writing:')} ${displayPath}`);
    } else if (toolName === 'Edit') {
      const displayPath = trimFilePath(input.file_path, cwds);
      console.log(`${label} ${c.dim('Editing:')} ${displayPath}`);
    } else if (toolName === 'Grep') {
      console.log(`${label} ${c.dim('Searching:')} "${input.pattern}"`);
    } else if (toolName === 'Glob') {
      console.log(`${label} ${c.dim('Globbing:')} ${input.pattern}`);
    } else {
      // Generic fallback for any other tools
      console.log(`${label} ${c.dim('Tool:')} ${toolName}`);
    }
  }

  /**
   * Log an inter-agent message
   */
  agentMessage(
    fromAgent: string,
    toAgent: string,
    message: string,
    opts?: { editMode?: boolean; truncate?: number }
  ): void {
    const fromLabel = formatAgentLabel(fromAgent, opts?.editMode);
    const toLabel = formatAgentLabel(toAgent);

    const displayMessage = opts?.truncate
      ? message.substring(0, opts.truncate) + '...'
      : message;

    console.log(`${fromLabel} ${c.dim('→')} ${toLabel}: ${displayMessage}`);
  }

  /**
   * Log an agent finding with type indicator
   */
  agentFinding(
    agentName: string,
    type: string,
    entry: string,
    opts?: { editMode?: boolean; truncate?: number }
  ): void {
    const label = formatAgentLabel(agentName, opts?.editMode);
    const displayEntry = opts?.truncate
      ? entry.substring(0, opts.truncate) + '...'
      : entry;

    console.log(`${label} ${c.yellow('[' + type + ']')}: ${displayEntry}`);
  }

  /**
   * Log an agent action (like "Requesting edit mode", "Assigning task owner", etc.)
   */
  agentAction(
    agentName: string,
    action: string,
    details: string,
    opts?: { editMode?: boolean }
  ): void {
    const label = formatAgentLabel(agentName, opts?.editMode);
    if (details) {
      console.log(`${label} ${c.dim(action + ':')} ${details}`);
    } else {
      console.log(`${label} ${c.dim(action)}`);
    }
  }

  /**
   * Log an agent posting to Slack
   */
  agentToSlack(agentName: string, message: string, opts?: { editMode?: boolean }): void {
    const label = formatAgentLabel(agentName, opts?.editMode);
    console.log(`${label} ${c.dim('→')} ${c.cyan('[Slack]')}: ${message}`);
  }

  /**
   * Log an error
   */
  error(prefix: string, message: string, error?: any): void {
    if (error) {
      console.error(`${c.red('[' + prefix + ']')} ${message}`, error);
    } else {
      console.error(`${c.red('[' + prefix + ']')} ${message}`);
    }
  }

  /**
   * Log a warning
   */
  warn(prefix: string, message: string, error?: any): void {
    if (error) {
      console.warn(`${c.yellow('[' + prefix + ']')} ${message}`, error);
    } else {
      console.warn(`${c.yellow('[' + prefix + ']')} ${message}`);
    }
  }

  /**
   * Log a plain message (no prefix, no color - for startup messages, etc.)
   */
  plain(message: string): void {
    console.log(message);
  }
}

/**
 * Process agent events and log file operation tool calls
 * Filters out MCP tools and only logs Read, Write, Edit, Grep, Glob operations
 */
export function processAgentEventForLogging(
  event: any,
  agentName: string,
  cwds: string[],
  editMode?: boolean
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
            logger.agentTool(agentName, toolName, input, { editMode, cwds });
          }
        }
      }
    }
  }
}

/**
 * Global logger instance
 */
export const logger = new Logger();
