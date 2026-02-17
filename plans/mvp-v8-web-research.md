# MVP v8 — Web Research MCP Tool

## Goal

Add a `web_research` MCP tool available to all agents. When called, it internally spawns a multi-agent research pipeline (lead agent → parallel researchers → report writer) using Claude Agent SDK, and returns synthesized findings as markdown.

## Reference

Based on `claude-agent-sdk-demos-main/research-agent/` — same architecture, stripped of PDF generation, data-analyst subagent, and slash commands.

## Architecture

```
Any Agent (PM, Repo, Plugin)
  │
  ├─ calls MCP tool: web_research(topic, context?)
  │
  └─ Internally spawns SDK query():
       │
       Lead Agent (Haiku, tools: [Task])
         │
         ├─ Spawns 2-4 Researcher subagents (parallel)
         │   ├─ Researcher 1 (Haiku, tools: [WebSearch, Write])
         │   ├─ Researcher 2 (Haiku, tools: [WebSearch, Write])
         │   └─ Researcher N ...
         │   │
         │   └─ Each writes to: notes/<subtopic>.md
         │
         └─ Spawns 1 Report Writer subagent
             ├─ (Haiku, tools: [Glob, Read, Write])
             ├─ Reads all notes from notes/
             └─ Writes: report.md
       │
       └─ Returns report.md content to calling agent
```

### Key Design Decisions

- **Adaptive depth** — the lead agent infers research scope from topic + context (no explicit `depth` parameter). Narrow/factual queries → 1 researcher; standard topics → 2-3; broad/strategic → 3-4. The prompt guides this decision
- **Haiku for all research subagents** — fast and cheap, good enough for web search + synthesis
- **File-based coordination** — researchers write notes, writer reads them (same as demo)
- **Isolated per-call storage** — each `web_research` call gets its own directory at `<task>/researches/<research-id>/` with `notes/` and `report.md` inside. The pipeline's cwd is set to this directory, fully isolated from other research sessions and the shared folder
- **No session recovery** — research is a one-shot operation, no need for resume/retry
- **Console logging** — use the existing `logger` and `processAgentEventForLogging` to log research pipeline events to the console, same as how PM/repo/plugin agents log. The research lead agent logs as `research:<id>` so you can follow the pipeline in real time. **Note:** `processAgentEventForLogging` currently only logs `Read, Write, Edit, Grep, Glob, Bash, Skill` — it skips `Task` and `WebSearch`. Add `Task` and `WebSearch` to the tool allowlist in `logger.ts` so the research pipeline output is visible (lead agent spawning researchers, researchers running web searches)
- **Single MCP server** — `createResearchMcpServer()` added to all agent spawners

## Implementation Plan

### Step 1: Create Research Prompts

**Files:**
- `prompts/research/lead-agent.md`
- `prompts/research/researcher.md`
- `prompts/research/report-writer.md`

Adapted from the demo prompts with these changes:

**lead-agent.md** (adapted from `lead_agent.txt`):
- Remove Step 4 (data-analyst) entirely
- Change Step 5 (report-writer) to write markdown instead of PDF
- Remove all data-analyst references from delegation rules and task tool usage
- Report writer outputs to `report.md` in cwd (not `files/reports/`)
- Researchers output to `notes/` in cwd (not `files/research_notes/`)
- Add adaptive scope assessment before spawning researchers:
  ```
  **STEP 0: ASSESS RESEARCH SCOPE**
  Before spawning researchers, assess the scope from the topic and context:

  - Narrow/factual (API docs, specific feature check, single-source lookup):
    Spawn 1 researcher with a focused, specific query.
    Example: "Does React 19 support server components?" → 1 researcher

  - Standard (exploring a topic, comparing options, understanding a domain):
    Spawn 2-3 researchers with distinct subtopics.
    Example: "Research best practices for caching in Node.js" → 2-3 researchers

  - Broad/strategic (market analysis, competitive landscape, multi-faceted investigation):
    Spawn 3-4 researchers with comprehensive, overlapping coverage.
    Example: "Research brand positioning strategies in the fitness industry" → 3-4 researchers

  Match the effort to the ask. Don't over-research simple questions.
  ```

**researcher.md** (adapted from `researcher.txt`):
- Keep as-is, just change output path from `files/research_notes/` to `notes/`
- Keep the data-focused approach (10-15 stats minimum, 5-10 WebSearch calls)
- Keep quality standards and output format

**report-writer.md** (adapted from `report_writer.txt`):
- Remove all PDF/reportlab references
- Remove chart/data-analyst references
- Output is markdown to `report.md` in cwd (not PDF)
- Remove Skill and Bash from available tools (no reportlab needed)
- Keep: Glob, Read, Write
- Keep synthesis workflow: read all notes → executive summary → key findings → sources

### Step 2: Create Research MCP Server

**File:** `src/mcp/research-tools.ts`

```typescript
import crypto from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadPrompt } from '../utils/prompt-loader.js';
import { processAgentEventForLogging, logger } from '../system/logger.js';

export interface ResearchToolCallbacks {
  getResearchesDir: () => string;  // returns <task>/researches
  getCallerAgentId: () => string;  // which agent invoked the tool
}

export function createWebResearchTool(callbacks: ResearchToolCallbacks) {
  return tool(
    'web_research',
    'Research a topic using web search. Spawns parallel researchers to gather data, then synthesizes findings into a structured report. Returns the report as markdown. Use for any task requiring up-to-date information from the internet.',
    {
      topic: z.string().describe('The topic to research'),
      context: z.string().optional().describe('Optional context about why this research is needed and what to focus on'),
    },
    async (args) => {
      // Implementation in step 3
    }
  );
}

export function createResearchMcpServer(callbacks: ResearchToolCallbacks) {
  // Note: callbacks.getResearchesDir() returns <task>/researches
  // Each tool call creates <task>/researches/<research-id>/ with notes/ and report.md
  return createSdkMcpServer({
    name: 'research-tools',
    version: '1.0.0',
    tools: [createWebResearchTool(callbacks)],
  });
}
```

### Step 3: Implement Research Pipeline

Inside the `web_research` tool handler:

```typescript
async (args) => {
  // Generate UUID for this research session
  const researchId = crypto.randomUUID();
  const researchDir = join(callbacks.getResearchesDir(), researchId);

  // Ensure research directories exist
  await mkdir(join(researchDir, 'notes'), { recursive: true });

  // Write request manifest for traceability
  const request = {
    id: researchId,
    topic: args.topic,
    context: args.context || null,
    caller: callbacks.getCallerAgentId(),
    created_at: new Date().toISOString(),
  };
  await writeFile(join(researchDir, 'request.json'), JSON.stringify(request, null, 2));

  // Load prompts
  const leadPrompt = await loadPrompt('research/lead-agent', {});
  const researcherPrompt = await loadPrompt('research/researcher', {});
  const reportWriterPrompt = await loadPrompt('research/report-writer', {});

  // Build the research query with context
  const userPrompt = args.context
    ? `Research topic: ${args.topic}\n\nContext: ${args.context}`
    : `Research topic: ${args.topic}`;

  // Define subagents (same pattern as demo's agent.py)
  const agents = {
    researcher: {
      description: 'Web search researcher that gathers data-rich findings on specific subtopics.',
      tools: ['WebSearch', 'Write'],
      prompt: researcherPrompt,
      model: 'haiku',
    },
    'report-writer': {
      description: 'Synthesizes research notes into a structured markdown report.',
      tools: ['Glob', 'Read', 'Write'],
      prompt: reportWriterPrompt,
      model: 'haiku',
    },
  };

  const agentName = `research:${researchId.slice(0, 8)}`;
  logger.agent(agentName, `Starting research: "${args.topic}"`);

  // Run pipeline with error handling — return partial results on failure
  try {
    // Spawn lead agent via SDK query()
    const agentQuery = query({
      prompt: userPrompt,
      options: {
        model: 'haiku',
        systemPrompt: leadPrompt,
        cwd: researchDir,
        permissionMode: 'bypassPermissions',
        allowedTools: ['Task'],
        agents,
        maxTurns: 50,
        executable: 'node',
        pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude',
        env: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          PATH: process.env.PATH,
        },
      },
    });

    // Consume events — log to console same as other agents
    for await (const event of agentQuery) {
      processAgentEventForLogging(event, agentName, [researchDir]);
    }

    logger.agent(agentName, 'Research pipeline complete');
  } catch (error) {
    logger.error(agentName, 'Research pipeline failed', error);
    // Fall through to return whatever partial results exist
  }

  // Read the final report
  const reportPath = join(researchDir, 'report.md');
  if (existsSync(reportPath)) {
    const report = await readFile(reportPath, 'utf-8');
    return {
      content: [{ type: 'text', text: report }],
    };
  }

  // No report — try to return raw notes as fallback
  const notesDir = join(researchDir, 'notes');
  if (existsSync(notesDir)) {
    const noteFiles = await readdir(notesDir);
    if (noteFiles.length > 0) {
      const notes: string[] = [];
      for (const file of noteFiles) {
        const content = await readFile(join(notesDir, file), 'utf-8');
        notes.push(`## ${file.replace('.md', '')}\n\n${content}`);
      }
      return {
        content: [{ type: 'text', text: `# Research Notes (raw — report generation failed)\n\nResearch ID: ${researchId}\n\n${notes.join('\n\n---\n\n')}` }],
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Research failed to produce results. Research ID: ${researchId} (check researches/${researchId}/ for diagnostics)` }],
  };
}
```

### Step 4: Wire Into All Agent Spawners

Add `research-tools` MCP server to all three agent types.

**`src/agents/pm.ts`** — Add to `mcpServers` and `allowedTools`:
```typescript
mcpServers: {
  'pm-agent-tools': mcpServer,
  'research-tools': createResearchMcpServer({
    getResearchesDir: () => join(getTaskPath(metadata.task_id), 'researches'),
    getCallerAgentId: () => 'pm-agent',
  }),
},
allowedTools: [
  // ... existing tools ...
  'mcp__research-tools__web_research',
],
```

**`src/agents/repo-agent.ts`** — Add to `mcpServers` and `allowedTools`:
```typescript
mcpServers: {
  'repo-agent-tools': mcpServer,
  'research-tools': createResearchMcpServer({
    getResearchesDir: () => join(getTaskPath(metadata.task_id), 'researches'),
    getCallerAgentId: () => config.agentId,
  }),
},
allowedTools: [
  // ... existing tools ...
  'mcp__research-tools__web_research',
],
```

**`src/agents/plugin-agent.ts`** — Add to `mcpServers` and `allowedTools`:
```typescript
mcpServers: {
  'repo-agent-tools': mcpServer,
  'research-tools': createResearchMcpServer({
    getResearchesDir: () => join(getTaskPath(metadata.task_id), 'researches'),
    getCallerAgentId: () => config.agentId,
  }),
},
allowedTools: [
  // ... existing tools ...
  'mcp__research-tools__web_research',
],
```

### Step 5: Update Logger Tool Allowlist

**File:** `src/system/logger.ts`

The `processAgentEventForLogging` function currently only logs `Read, Write, Edit, Grep, Glob, Bash, Skill`. Research pipeline agents use `Task` (lead agent) and `WebSearch` (researchers), which are silently skipped.

Add `Task` and `WebSearch` to the tool allowlist and add display handlers:

```typescript
// In processAgentEventForLogging, update the tool filter:
if (['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'Skill', 'Task', 'WebSearch'].includes(toolName)) {

// In agentTool, add handlers for new tools:
} else if (toolName === 'Task') {
  const desc = input.description || input.prompt?.substring(0, 60) || 'subagent';
  console.log(`${label} ${c.dim('Spawning:')} ${desc}`);
} else if (toolName === 'WebSearch') {
  const query = input.query || '';
  const displayQuery = query.length > 80 ? query.substring(0, 77) + '...' : query;
  console.log(`${label} ${c.dim('WebSearch:')} "${displayQuery}"`);
}
```

**Note:** The prompt loader (`loadPrompt`) already supports subdirectories — `loadPrompt('research/lead-agent', {})` resolves to `prompts/research/lead-agent.md` via `join()`. No changes needed there.

## File Changes Summary

| File | Change |
|------|--------|
| `prompts/research/lead-agent.md` | **New** — Lead agent prompt (adapted from demo) |
| `prompts/research/researcher.md` | **New** — Researcher prompt (adapted from demo) |
| `prompts/research/report-writer.md` | **New** — Report writer prompt (adapted from demo, markdown not PDF) |
| `src/mcp/research-tools.ts` | **New** — Research MCP server + web_research tool + pipeline logic |
| `src/agents/pm.ts` | **Modified** — Add research-tools MCP server + allowedTools |
| `src/agents/repo-agent.ts` | **Modified** — Add research-tools MCP server + allowedTools |
| `src/agents/plugin-agent.ts` | **Modified** — Add research-tools MCP server + allowedTools |
| `src/system/logger.ts` | **Modified** — Add `Task` and `WebSearch` to tool allowlist + display handlers |

## Task Folder Structure (after two research calls)

```
sessions/<task-id>/
├── shared/
│   ├── knowledge.log
│   ├── metadata.json
│   └── .claude/skills/
├── researches/
│   ├── a1b2c3d4-e5f6-7890-abcd-ef1234567890/
│   │   ├── request.json          ← {id, topic, context, caller, created_at}
│   │   ├── notes/
│   │   │   ├── subtopic-1.md
│   │   │   └── subtopic-2.md
│   │   └── report.md
│   └── f9e8d7c6-b5a4-3210-fedc-ba0987654321/
│       ├── request.json
│       ├── notes/
│       │   ├── subtopic-a.md
│       │   └── subtopic-b.md
│       └── report.md
└── repos/
```

## Notes

- **Multiple research calls**: Each call gets its own `researches/<research-id>/` directory, so multiple research sessions are fully isolated from each other. No cross-contamination of notes or reports.
- **Cost**: Adaptive — narrow queries cost ~3 Haiku calls (lead + 1 researcher + writer), standard ~4-5, broad ~5-7. The lead agent scales effort to match the ask.
- **Timeout**: The `query()` call for the lead agent should have a reasonable `maxTurns` (50) to prevent runaway research. The whole pipeline typically completes in 1-3 minutes.
- **Error handling**: The pipeline is wrapped in try/catch. If it fails partway, the tool returns whatever partial results exist: report.md if available, raw notes as fallback, or an error message with the research ID for diagnostics. The pipeline never throws back to the calling agent.
