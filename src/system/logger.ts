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
   * Log an agent tool call (Read, Write, Edit, Grep, Glob, Bash)
   */
  agentTool(
    agentName: string,
    toolName: string,
    input: any,
    opts?: { editMode?: boolean; cwds?: string[]; subagentLabel?: string }
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
    } else if (toolName === 'Bash') {
      // Show command, truncated if too long
      const cmd = input.command || '';
      const displayCmd = cmd.length > 80 ? cmd.substring(0, 77) + '...' : cmd;
      console.log(`${label} ${c.dim('Bash:')} ${displayCmd}`);
    } else if (toolName === 'Skill') {
      console.log(`${label} ${c.dim('Skill:')} ${input.skill || 'unknown'}`);
    } else if (toolName === 'Task') {
      const desc = input.description || input.prompt?.substring(0, 60) || 'subagent';
      const subLabel = opts?.subagentLabel ? ` ${c.cyan(`[${opts.subagentLabel}]`)}` : '';
      console.log(`${label} ${c.dim('Spawning:')}${subLabel} ${desc}`);
      // Log the full prompt sent to the subagent
      if (input.prompt) {
        const promptLines = input.prompt.split('\n');
        console.log(`${label} ${c.dim('  Prompt:')}`);
        for (const line of promptLines) {
          console.log(`${label} ${c.dim('  │')} ${line}`);
        }
      }
    } else if (toolName === 'WebSearch') {
      const searchQuery = input.query || '';
      const displayQuery = searchQuery.length > 80 ? searchQuery.substring(0, 77) + '...' : searchQuery;
      console.log(`${label} ${c.dim('WebSearch:')} "${displayQuery}"`);
    } else if (toolName === 'WebFetch') {
      const url = input.url || '';
      const displayUrl = url.length > 80 ? url.substring(0, 77) + '...' : url;
      console.log(`${label} ${c.dim('WebFetch:')} ${displayUrl}`);
    } else if (toolName === 'ToolSearch') {
      const query = input.query || '';
      const displayQuery = query.length > 80 ? query.substring(0, 77) + '...' : query;
      console.log(`${label} ${c.dim('ToolSearch:')} "${displayQuery}"`);
    } else if (toolName.startsWith('mcp__')) {
      // MCP tool: mcp__server__tool → "server: tool(params)"
      const parts = toolName.split('__');
      const server = parts[1] || '';
      const tool = parts.slice(2).join('__') || '';
      // Show key params inline, truncated
      const params = Object.entries(input || {})
        .map(([k, v]) => {
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${s.length > 60 ? s.substring(0, 57) + '...' : s}`;
        })
        .join(', ');
      const display = params ? ` ${c.dim(params)}` : '';
      console.log(`${label} ${c.dim(`${server}:`)} ${tool}${display}`);
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

  /**
   * Log a debug message with an object (logged as-is for console inspection)
   */
  debug(prefix: string, message: string, data?: any): void {
    if (data !== undefined) {
      console.log(`${c.dim('[' + prefix + ']')} ${message}`, data);
    } else {
      console.log(`${c.dim('[' + prefix + ']')} ${message}`);
    }
  }
}

/**
 * Tracks subagent Task tool calls so we can label events from subagents.
 * Maps tool_use_id → short label derived from the Task description/subagent_type.
 */
const subagentLabels = new Map<string, string>();

/** Counts how many times each base label has been used, for numbering duplicates. */
const subagentLabelCounts = new Map<string, number>();

/**
 * Extract a short label from a Task tool call for subagent identification.
 * Numbers duplicates: researcher#1, researcher#2, etc.
 */
function extractSubagentLabel(input: any): string {
  // Prefer subagent_type (e.g. "researcher", "report-writer") or name
  let base: string;
  if (input.subagent_type) {
    base = input.subagent_type;
  } else if (input.name) {
    base = input.name;
  } else if (input.description) {
    base = input.description.length > 20
      ? input.description.substring(0, 20).trim()
      : input.description;
  } else {
    base = 'subagent';
  }

  // Number duplicates: researcher#1, researcher#2, ...
  const count = (subagentLabelCounts.get(base) || 0) + 1;
  subagentLabelCounts.set(base, count);
  return `${base}#${count}`;
}

/**
 * Process agent events and log SDK tool calls
 * Filters out MCP tools and only logs Read, Write, Edit, Grep, Glob, Bash operations.
 * Tracks parent_tool_use_id to label events from subagents.
 */
export function processAgentEventForLogging(
  event: any,
  agentName: string,
  cwds: string[],
  editMode?: boolean
): void {
  if (event.type === 'assistant') {
    const content = event.message.content;
    const parentId: string | null = event.parent_tool_use_id ?? null;

    // Determine display name: append subagent label if this is a subagent event
    let displayName = agentName;
    if (parentId && subagentLabels.has(parentId)) {
      displayName = `${agentName}/${subagentLabels.get(parentId)}`;
    }

    if (typeof content !== 'string') {
      for (const block of content) {
        if (block.type === 'tool_use') {
          const toolName = block.name;
          const input = block.input as any;

          // Track Task tool calls for subagent labeling
          let subagentLabel: string | undefined;
          if (toolName === 'Task') {
            subagentLabel = extractSubagentLabel(input);
            subagentLabels.set(block.id, subagentLabel);
          }

          logger.agentTool(displayName, toolName, input, { editMode, cwds, subagentLabel });
        }
      }
    }
  }
}

/**
 * Global logger instance
 */
export const logger = new Logger();
