---
name: engineering
description: Engineering task workflow. Use when the task involves code investigation, code changes, bug fixes, feature implementation, or any software engineering work. Provides the engineering task lifecycle, edit mode workflow, and decision framework for coordinating engineering agents.
---

You are managing an engineering task. Use this workflow to coordinate your engineering team (listed in your system prompt).

### Engineering Task Lifecycle

Engineering tasks typically flow through these phases, though not every task follows the complete cycle:

1. **Research** → Investigate in read-only mode
2. **Propose** → Report findings, explain needed changes, request edit mode
3. **Implement** → Make changes and commit locally
4. **PR** → Push branch, create pull request, notify user
5. **Review** → Address feedback, resolve threads, request re-review
6. **Conflicts** → Merge main and resolve conflicts if needed
7. **Merge** → System auto-merges when approved, notify user

This is a mental model, not a rigid sequence. Simple questions may complete at step 1. Some fixes may skip review iterations. Use this to orient yourself, not as a checklist.

### The Edit Mode Workflow

When code changes are needed, follow this sequence:

1. Use `post_to_slack` to explain what you found and what changes are needed
2. Call `request_edit_mode` with a brief reason
3. STOP immediately - the user will see Approve/Deny buttons
4. When you receive approval/denial, you can act accordingly

Never request edit mode without first explaining why through Slack.

### Engineering Decision Framework

**New engineering task from Slack:**

- Acknowledge in Slack ("Looking into this...")
- Assign the appropriate engineering agent based on expertise
- Send task with delegation protocol, wait for agent

**New task from GitHub (e.g., review comment):**

- No acknowledgment needed (GitHub is not a chat platform)
- Evaluate what's needed
- If needs agent work: delegate and wait for agent
- If needs GitHub response: use GitHub tools, no Slack update unless it's a milestone

**Agent reports findings:**

- If needs code changes: `post_to_slack` explaining → `request_edit_mode` → STOP
- If just informational: `report_completion(message)` with the info
- If incomplete: ask follow-ups and wait for agent

**Edit mode approved:**

- `post_to_slack` acknowledging ("Starting on the changes now...")
- Instruct the engineering agent to implement changes
- Wait for agent work

**Agent reports "ready for PR":**

- `push_branch` → `create_pull_request` → `post_to_slack` with link → `report_completion(message)`

### GitHub Communication

**GitHub PRs** are where code reviewers live - often different people than your Slack requester. This channel is for:

- Responding to review feedback and questions
- Explaining changes you've made to address reviews
- Technical discussions about the code

**The key insight**: GitHub is not a chat platform. Don't acknowledge GitHub comments like you would Slack messages. When you receive GitHub input (reviews, comments), respond through GitHub tools when appropriate, but save milestone announcements for Slack.

**Additional Channel Decision Logic for Engineering:**

- PR technical discussions: Always GitHub tools
- PR created / PR merged: Always announce in Slack
- Review feedback received: Use GitHub tools for responses, no Slack unless it's a blocker
