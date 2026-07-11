# Proposal: GitHub @mention Workflow

> **Status:** Superseded — implemented (with a broader design: issue + PR mentions, repo-write authorization, readonly v1) by the `github-mention-trigger` change (`openspec/changes/github-mention-trigger/`). Current behavior is documented in `docs/architecture/github-integration.md` → "Mention Trigger (GitHub-born tasks)". Kept for historical context only.

## Summary

Allow users to @mention Archie directly in GitHub PR comments. This would enable task creation and resumption from GitHub alongside the existing Slack interface.

## Motivation

Currently, all user interaction flows through Slack. GitHub is only used for webhook events (PR reviews, CI status). Adding @mention support in GitHub would:

- Let developers interact with Archie without leaving their PR
- Enable quick fixes directly from code review context
- Support seamless cross-platform task continuity (GitHub + Slack)

## Design

### Core Rules

- Only PR creator can @mention Archie (prevents interference)
- PR ownership stays with creator — Archie assists but never merges
- Task pauses when agent turn completes, resumes on next @mention
- All work logged to shared knowledge log for cross-platform context

### Workflows

**New task from PR:** User @mentions Archie on a PR not linked to any task → system creates task, spawns repo agent, agent reads PR context and acts.

**Resume task from PR:** User @mentions Archie on a PR already linked to a task → system resumes existing task session with full context.

**Cross-repo coordination:** Agent can coordinate with other repo agents and create linked PRs, same as Slack-initiated tasks.

**Cross-platform continuity:** A task started from GitHub can be continued from Slack (and vice versa). The shared knowledge log provides full context regardless of trigger source.

### Permission Model

- Verify `comment.user == pr.author` via GitHub API
- Archie can: read PR, push commits, reply to comments, create linked PRs, request reviews
- Archie cannot: merge PRs (human retains control)

## Implementation Notes

The existing GitHub webhook infrastructure (`src/connectors/github/events.ts`, `src/connectors/github/webhooks.ts`) already handles PR comment events — `issue_comment` events on PRs are already routed to the existing-task handler (`handleExistingTaskDirect`) when a task is linked via the branch name pattern or PR number. Repo agents also already have GitHub reply tools: `add_pr_comment`, `add_review_comment`, and `reply_to_review_comment` (see `src/agents/tools.ts`). The remaining work would be:

1. Detect @mentions inside `issue_comment` bodies (currently the comment body is logged but not scanned for bot mentions, and routing only fires for PRs already linked to a task)
2. Create new tasks from GitHub context when an @mention lands on an unlinked PR (PR metadata, files changed)
3. Verify `comment.user == pr.author` before acting
4. Track `created_from: "github"` in task metadata

> **Status note (2026-05):** Items 1–4 above are not implemented. The webhook plumbing, PR-to-task linkage, and agent-side GitHub reply tools listed as prerequisites already exist.

## Original Design Document

The full design was captured in the original `docs/archie-github-mention-workflow.md` prior to the docs restructure.
