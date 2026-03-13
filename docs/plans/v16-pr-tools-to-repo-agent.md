# Plan: Move PR Tools from PM Agent to Repo Agent

## Context

Currently all GitHub PR operations (push, create PR, get status, reviews, update, comment, resolve thread, re-review, merge check) live in the PM agent's MCP server. The PM should be a pure manager — it coordinates, communicates, and delegates. All hands-on work including PR lifecycle should belong to repo agents in edit mode.

This moves the PR tools to repo agents and adds a missing `close_pull_request` tool.

## Changes

### 1. `src/connectors/github/client.ts`

Add `closePullRequest(githubRepo, prNumber)` method:
```ts
async closePullRequest(githubRepo: string, prNumber: number): Promise<void> {
  const octokit = await this.getOctokit();
  const { owner, repo } = this.parseRepo(githubRepo);
  await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner, repo, pull_number: prNumber, state: 'closed',
  });
  logger.system(`GitHub: Closed PR #${prNumber}`);
}
```

### 2. `src/agents/tools.ts`

**Add** `createClosePRTool` alongside the other PR tool functions. Since repo agents know their own repo (no `repo_key` parameter needed), add a new repo-scoped PR server:

- The existing PM tool functions used `repo_key` + `getAgentDef()` to look up `def.repo.githubRepo`. Repo agents already have `def.repo`, so the new server derives the repo directly from `agent.def.repo`.

**New server function** `createRepoPRMcpServer(agent: Agent, task: Task)`:
- All tools use `agent.def.repo!.githubRepo` directly (no `repo_key` param)
- Tools: `push_branch`, `create_pull_request`, `get_pr_status`, `get_pr_reviews`, `update_pr`, `add_pr_comment`, `add_review_comment`, `resolve_review_thread`, `request_re_review`, `trigger_merge_check`, `close_pull_request`
- Server name: `'pr-tools'`

**Remove** PR tools from `createPMAgentMcpServer` — keep only: `send_message_to_agent`, `post_to_slack`, `assign_task_owner`, `report_completion`, `request_edit_mode`, `get_agents_status`, `log_finding`

### 3. `src/agents/spawn.ts`

**PM track** — remove all PR tool entries from `allowedTools` (the `edit_allowed` block becomes empty and can be removed entirely).

**Repo track** — add `'pr-tools': createRepoPRMcpServer(agent, task)` to `mcpServers`, add PR tools to the `editAllowed` block:
```
'mcp__pr-tools__push_branch',
'mcp__pr-tools__create_pull_request',
'mcp__pr-tools__get_pr_status',
'mcp__pr-tools__get_pr_reviews',
'mcp__pr-tools__update_pr',
'mcp__pr-tools__add_pr_comment',
'mcp__pr-tools__add_review_comment',
'mcp__pr-tools__resolve_review_thread',
'mcp__pr-tools__request_re_review',
'mcp__pr-tools__trigger_merge_check',
'mcp__pr-tools__close_pull_request',
```

### 4. `prompts/repo-agent.md`

- Remove the line "pm-agent handles user communication, PR creation, and pushing to remote."
- In the Git Workflow section, remove `git push` from the "What NOT to Do" list and instead note: "Use the `push_branch` tool (not `git push` directly) — it handles authentication."
- Update step 4 of Making Changes: "Report to pm-agent: 'Changes committed, ready for PR'" → "Use `push_branch` tool to push, then `create_pull_request` to open the PR."

### 5. Plugin skills — `archie-plugins` repo

**`engineering/pm-skills/pr/SKILL.md`** — delete (PM no longer has PR tools).

Create **`engineering/repo-skills/pr/SKILL.md`** with PR workflow for repo agents:
- No `repo_key` param (tools operate on the agent's own repo)
- Explicitly states: use `push_branch` tool — do NOT use `git push` directly (the tool handles authentication)
- Covers: push → create PR → notify PM → handle reviews → resolve threads → re-request → close if needed

**`engineering/pm-skills/workflow/SKILL.md`** — update: remove "Agent reports 'ready for PR'" step (since PM no longer pushes/creates PRs). PM's role ends when agent reports completion; the repo agent does the PR work autonomously.

## File Summary

| File | Change |
|------|--------|
| `src/connectors/github/client.ts` | Add `closePullRequest()` |
| `src/agents/tools.ts` | Add `createRepoPRMcpServer()` + `createClosePRTool()`; remove PR tools from PM server |
| `src/agents/spawn.ts` | Add `'pr-tools'` MCP server to repo track; remove PR tools from PM track |
| `prompts/repo-agent.md` | Update to reflect repo agent handles its own PRs |
| `archie-plugins/engineering/pm-skills/pr/SKILL.md` | Delete |
| `archie-plugins/engineering/pm-skills/workflow/SKILL.md` | Remove "Agent reports ready for PR" step |
| `archie-plugins/engineering/repo-skills/pr/SKILL.md` | Create new — PR workflow for repo agent, emphasizes push_branch tool over git push |

## Verification

- `npm run typecheck` — ensures no broken references
- Check spawn.ts allowed tools list matches actual tool names in the new MCP server
- Confirm PM agent no longer has any PR tool entries in allowedTools
