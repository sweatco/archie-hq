# Proposal: Analytics Plugin — Gap Analysis & Roadmap

> **Status:** MVP implemented — gaps documented for future iterations

## Summary

The analytics plugin (3-agent system: analyst orchestrator, context-analyst, data-researcher) is inspired by the standalone sweat-researcher repo. This document captures the gaps between sweat-researcher's capabilities and Archie's current infrastructure, along with proposed solutions discussed during MVP design.

## Reference

- **Inspiration repo:** sweat-researcher (Python Slack bot + Claude Code agents)
- **Plugin location:** `archie-plugins/analytics/`
- **Core change:** `src/agents/spawn.ts` — pluginPath added to additionalDirectories for all plugin agents

---

## Implemented in MVP

### Plugin context files access
**Problem:** Plugin agents had no way to read static reference files bundled with their plugin (dbt docs, business context, event catalogs).

**Solution:** Added `def.pluginPath` to `additionalDirectories` for all plugin agents in `spawn.ts`. Agents can now read any file in their plugin directory. The `agents/*.md` files in that directory are not picked up as sub-agents since they're not in a `.claude/agents/` path.

### MCP server configuration
**Problem:** Analytics agents need BigQuery and Lightdash access.

**Solution:** Added `bigquery` and `lightdash` entries to root `.mcp.json` with `${MCP_*}` env var placeholders. Agents reference servers via frontmatter `mcpServers: [bigquery, lightdash]`.

### Plugin-defined hooks
**Problem:** sweat-researcher uses Claude Code hooks (e.g., `stop_assess.py` that decides whether to run quality assessment before finishing). Archie had no mechanism for plugins to define agent hooks.

**Solution:** Plugins can now define hooks in `hooks/hooks.json`. The plugin loader resolves `${CLAUDE_PLUGIN_ROOT}` paths at scan time, the registry propagates hooks to AgentDefs, and the spawner writes them to `.claude/settings.json` in each agent's workspace. The SDK picks them up via `settingSources: ["project"]`.

### Clear agent role separation
**Problem:** In sweat-researcher, the context-analyst and data-researcher have overlapping responsibilities — both search dbt docs, both do data discovery. The orchestrator's CLAUDE.md tells data-researcher to "search dbt_full_context.md before writing any SQL" which duplicates context-analyst's purpose.

**Solution:** Clean separation — context-analyst owns "what to query and where" (searches dbt docs, outputs data map to knowledge.log), data-researcher owns "how to query" (reads data map, executes queries). Data-researcher does NOT do its own context discovery. If the data map is wrong, it reports back rather than diving into dbt docs.

---

## Parked Gaps (sorted by priority)

### 1. Cross-task persistent memory — Priority: HIGH

**Gap:** sweat-researcher has `memory/findings/` that persists across sessions — accumulated research findings, data corrections, known gotchas. Archie sessions are ephemeral (`sessions/task-{id}/`), so every task starts from scratch.

**Impact:** Without memory, agents will re-discover the same data quirks, re-learn table locations, and repeat prior research. This is the single highest-value gap.

**Proposed solution:** Implement a memory layer at the Archie level (not per-plugin). Options:
- Plugin-level `memory/` directory that agents read/write across tasks
- New `save_finding(topic, content)` tool scoped to plugin memory directory
- Archie-wide memory system that all agents can query

**Decision:** Build memory for the whole system, not per-agent. Design TBD.

### 2. BigQuery cost safety (dry-run validation) — Priority: HIGH

**Gap:** sweat-researcher has a custom BigQuery MCP server with built-in safety: dry-run validation before execution, 100GB cost limit, read-only enforcement, row limits. The generic `@anthropic-ai/bigquery-mcp` package may not have these guards.

**Impact:** Without cost limits, a poorly-constructed query could scan terabytes of data and incur significant costs.

**Proposed solution options:**
1. Use the sweat-researcher's custom Python BigQuery MCP server (port it or reference it)
2. Build a wrapper MCP server that adds dry-run + cost limits on top of the generic one
3. Rely on BigQuery project-level quotas as a backstop and add cost awareness to agent prompts

**Decision:** Deferred. MVP uses the generic MCP server. Evaluate after initial testing whether prompt-level cost awareness is sufficient or if a custom server is needed.

### 3. File generation and script execution — Priority: MEDIUM

**Gap:** sweat-researcher agents can write Python scripts to `workspace/`, execute them via Bash, and generate CSV exports, PDFs, and HTML dashboards. Archie plugin agents are read-only with no Bash access.

**Impact:** Needed for data processing, chart generation, and advanced analysis. Not critical for basic Q&A research.

**Proposed solution:** Allow plugin agents to opt into `Write` and `Bash` tools via frontmatter. Agents would write and execute scripts in their workspace directory. Sandbox scoping (preventing escape from working directories) to be implemented separately.

**Open question:** How to scope Bash access — allowlist specific commands? Restrict to workspace directory? The sweat-researcher approach (full Bash) is flexible but risky for a multi-tenant system.

### 4. dbt context auto-refresh — Priority: MEDIUM

**Gap:** sweat-researcher regenerates `dbt_full_context.md` daily via GitHub Actions (`dbt docs generate` against production). The analytics plugin's `context/dbt_full_context.md` is a static file that will go stale.

**Impact:** Stale dbt context means agents work with outdated table/column information, leading to failed queries or wrong answers.

**Proposed solution options:**
1. Manual refresh — user runs a script or skill to regenerate (like sweat-researcher's `/update-dbt-context` skill)
2. External cron — GitHub Actions job regenerates and commits updated context to archie-plugins repo
3. Git submodule — reference a repo that auto-generates dbt docs

**Decision:** Deferred. The user will manually provide and update context files for now.

### 5. Multiple instances of the same agent — Priority: MEDIUM

**Gap:** sweat-researcher's orchestrator can spawn multiple data-researcher sub-agents in parallel (e.g., one for DAU trends, one for retention cohorts, one for revenue). Archie can only have one instance of each agent per task.

**Impact:** Limits parallelism within a single research task. The orchestrator must serialize work through a single data-researcher.

**Proposed solution:** Accept as a limitation for now. The orchestrator can still parallelize by sending work to context-analyst and data-researcher simultaneously. For deeper parallelism, consider allowing agent instance multiplexing in the future (e.g., `data-researcher-agent:1`, `data-researcher-agent:2`).

### 6. Scheduled monitoring / anomaly detection — Priority: LOW-MEDIUM

**Gap:** sweat-researcher has a `monitor.md` agent that runs daily on a cron schedule, scans Lightdash dashboards for anomalies, and reports HIGH-severity issues to Slack. Archie has no scheduling capability.

**Impact:** Low for MVP, high for mature usage. Proactive anomaly detection is a differentiating feature but not needed for interactive research.

**Proposed solution options:**
1. External cron (GitHub Actions) creates a task via Archie's API
2. Slack scheduled message triggers triage → PM → analyst
3. New `CronTask` capability in Archie core

**Decision:** Parked. Revisit when the interactive flow is proven.

### 7. Slack file uploads from agents — Priority: LOW

**Gap:** sweat-researcher agents can upload files (CSV, PDF) directly to Slack threads via a custom Slack MCP server. Archie's PM posts text to Slack but can't upload files.

**Impact:** Text answers are sufficient initially. File uploads become important when generating reports or exporting data.

**Proposed solution:** Add file upload capability to PM's `post_to_slack` tool or add a dedicated `upload_file` tool. The file would come from the agent's workspace directory.

### 8. Output formats (PDF, HTML dashboards) — Priority: LOW

**Gap:** sweat-researcher generates polished PDFs (both quick markdown-to-PDF and academic ArXiv-style) and interactive HTML dashboards with Chart.js. Archie agents currently just report text via Slack.

**Impact:** Text responses via Slack are sufficient for initial research. Polished output becomes important when research is shared more broadly.

**Proposed solution:** Depends on gap #3 (file generation). Once agents can write and execute scripts, PDF/HTML generation follows naturally. The sweat-researcher's `arxiv_pdf.py` and `html_dashboard.py` libraries could be bundled in the plugin's `scripts/` directory.

### 9. Deep research (multi-LLM web search) — Priority: LOW

**Gap:** sweat-researcher has a custom `deep_research.py` script that calls Gemini, ChatGPT, and Claude APIs in parallel with web search grounding for comprehensive market research.

**Impact:** Archie already has `web_research` tool for plugin agents. For deeper research, a Perplexity MCP server can be added to `.mcp.json` as a drop-in replacement.

**Proposed solution:** Add Perplexity (or similar) as an MCP server when needed. No custom scripts required.

---

## Architecture Comparison

| Aspect | sweat-researcher | Archie analytics plugin |
|---|---|---|
| **Agent framework** | Claude Code CLI (standalone) | Claude Agent SDK (integrated) |
| **Orchestration** | CLAUDE.md + orchestrator agent | analyst.md agent prompt |
| **Communication** | Direct Slack MCP | PM mediates all Slack comms |
| **Data access** | Custom BigQuery MCP + Lightdash + GrowthBook | Generic BigQuery MCP + Lightdash |
| **Context files** | Bundled in repo, auto-refreshed daily | Bundled in plugin, manually maintained |
| **Memory** | Persistent `memory/findings/` | None (ephemeral per task) |
| **Output** | PDF, HTML dashboards, Slack | Text via Slack (through PM) |
| **Parallelism** | Multiple agent instances | One instance per agent type |
| **Hooks** | Custom stop hook (stop_assess.py) | Plugin-defined hooks via hooks/hooks.json |
| **Scheduling** | Daily monitor cron | None |
| **Cross-domain** | Isolated (analytics only) | Can coordinate with engineering, marketing plugins |

## Key Advantage of Archie's Approach

The plugin architecture gives us cross-domain coordination for free. An analytics question that reveals a bug can seamlessly escalate to the engineering plugin. A marketing campaign analysis can pull data from analytics and copy from marketing — all within one task, coordinated by PM. sweat-researcher is a silo; Archie is a platform.
