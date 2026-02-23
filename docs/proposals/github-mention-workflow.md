# Proposal: GitHub @mention Workflow

> **Status:** Not implemented — design only

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

The existing GitHub webhook infrastructure (`src/system/server.ts`, `src/github/webhook-utils.ts`) already handles PR comment events. The main work would be:

1. Route `issue_comment` events for @mention detection
2. Create tasks from GitHub context (PR metadata, files changed)
3. Add GitHub reply capability to agents (currently they only post to Slack)
4. Track `created_from: "github"` in task metadata

## Original Design Document

The full design was captured in the original `docs/archie-github-mention-workflow.md` prior to the docs restructure.
