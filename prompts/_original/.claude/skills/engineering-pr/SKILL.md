---
name: engineering-pr
description: Pull request lifecycle management. Use when you need to create a PR, handle PR reviews, resolve merge conflicts, or manage the PR-to-merge workflow. Extends the engineering skill with GitHub-specific tools and decision framework.
---

You are managing pull requests for an engineering task. Use these tools and workflows to handle the PR lifecycle.

### GitHub PR Management Tools

These tools are available when edit mode is approved:

- `push_branch(repo_key)`: Push commits from worktree to origin
- `create_pull_request(repo_key, title, body)`: Create PR and register it in task
- `get_pr_status(repo_key, pr_number)`: Check PR state and mergeability
- `get_pr_reviews(repo_key, pr_number)`: Fetch reviews and comments
- `update_pr_description(repo_key, pr_number, body)`: Edit PR description
- `add_pr_comment(repo_key, pr_number, comment)`: Add general PR comment
- `add_review_comment(repo_key, pr_number, path, line, comment)`: Comment on specific code line
- `resolve_review_thread(repo_key, pr_number, thread_id)`: Mark thread resolved
- `request_re_review(repo_key, pr_number)`: Request reviewers to re-review
- `trigger_merge_check()`: Check all linked PRs and merge if ready (approved + CI passing)

### Creating PRs

1. After team reports "ready for PR" → `push_branch(repo_key)`
2. `create_pull_request(repo_key, title, body)` with clear description
3. `post_to_slack` notifying user: "I've created a PR with the fix: repo#123"
4. `report_completion` (this is a user-facing milestone)

### Managing Reviews

1. Receive review feedback → `get_pr_reviews` to see details
2. Instruct team what to fix via `send_message_to_agent`
3. After team fixes and commits → `push_branch` → `resolve_review_thread` → `request_re_review`
4. `add_pr_comment` explaining what was changed (for the GitHub reviewer)
5. No Slack update needed (this is PR technical discussion, not a milestone)

### Handling Conflicts

1. If `get_pr_status` shows `mergeable: false` with `mergeableState: dirty` → conflicts exist
2. Instruct team via `send_message_to_agent`: "PR has conflicts with main. Please run `git merge origin/main` and resolve."
3. After resolution → `push_branch`
4. No Slack update unless this becomes a blocker

### Merging

- Do NOT merge PRs yourself - system handles auto-merge when approved
- When you receive merge notification → `post_to_slack` to confirm completion → `report_completion`

### Multi-Repo PRs

- Create PRs for each repo and mention related PRs in descriptions
- System waits for all linked PRs before merging any

### PR Decision Framework

**PR review received:**

- `get_pr_reviews` for details
- Instruct agent on fixes
- Wait for agent

**Agent reports fixes complete:**

- `push_branch` → `resolve_review_thread` → `request_re_review` → `add_pr_comment`
- No Slack update (this is PR technical work, not a user milestone)

**PR merged (system event):**

- `post_to_slack` confirming completion → `report_completion(message)`
