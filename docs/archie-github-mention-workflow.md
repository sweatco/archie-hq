# ARCHIE GitHub @mention Workflow

## Overview

ARCHIE can be mentioned in GitHub PR comments to assist with work. The @mention creates a new task (or resumes existing one), spawns the appropriate repo agent, and maintains full context in the shared knowledge log for seamless continuation across GitHub and Slack.

## Core Rules

✅ **Only PR creator can @mention ARCHIE**
- Prevents others from interfering with PR author's work
- GitHub API verifies: `comment.user == pr.author`

✅ **PR ownership stays with creator**
- ARCHIE assists as contributor
- Pushes commits but never merges
- Human retains control

✅ **Task pauses when agent turn completes**
- Agent finishes work, replies in PR
- Task state: paused/completed
- Can be resumed by:
  - New @mention in same PR
  - Slack message referencing task
  - New PR review/comment

✅ **All work logged to shared knowledge**
- GitHub interactions logged same as Slack interactions
- Task can be resumed from any trigger with full context
- Cross-reference between GitHub PR and Slack thread possible

## Workflows

### Unattached PR (New Task)

```
Someone: "@archie add input validation to this endpoint"
    (on PR not created by ARCHIE, no task association)
                          ↓
            System receives webhook
                          ↓
            System checks: PR attached to task?
                - No task found
                          ↓
            System creates new task
            Task metadata: pr_id, repo, requester
                          ↓
            System spawns repo agent as task owner
                          ↓
            Agent reads:
                - PR context (files changed, description)
                - Comment that mentioned it
                - Full conversation thread
                          ↓
            Agent decides what to do:
                - Simple request? Handle it directly
                - Vague/complex? Ask clarifying questions in PR comment
                - Out of scope? Reply explaining limitations
                          ↓
            Agent works, pushes commits to PR
            Agent replies in PR comment thread
            Logs to shared knowledge
                          ↓
            Task pauses (completed turn)
```

### Attached PR (Resume Task)

```
Someone: "@archie the retry logic isn't working"
    (on PR created by ARCHIE from existing task-123)
                          ↓
            System checks: PR attached to task-123
                          ↓
            System adds comment to task-123 shared log
                          ↓
            System spawns repo agent in task-123 session
                          ↓
            Agent sees: This is continuation of original work
            Agent handles request
            Agent replies in PR
            Logs to shared knowledge
                          ↓
            Task pauses when turn complete
```

## Example Scenarios

### Example 1: Simple Request on Human PR

```
Human creates PR in backend repo
Human comments: "@archie add input validation on line 45"
                          ↓
System creates task-456
System spawns Backend agent as owner
                          ↓
Backend agent:
  - Reads PR context
  - Logs to knowledge: "Request: add input validation line 45"
  - Makes changes, pushes commit
  - Logs: "completion: Added validation in commit abc123"
  - Replies in PR: "Added input validation in abc123"
                          ↓
Task pauses (completed turn)
                          ↓
Later, human: "@archie also add tests for this"
                          ↓
System resumes task-456
Backend agent continues work with full context
```

### Example 2: Cross-Repo Coordination

```
Human creates PR in backend repo
Human: "@archie this will break mobile deep links, can you coordinate fix?"
                          ↓
System creates task-789
Backend agent spawned
                          ↓
Backend agent:
  - Logs: "Request: coordinate mobile deep link fix"
  - Analyzes changes
  - Backend → Mobile direct message: "These API changes affect deep links"
  - Logs: "Coordinating with mobile-agent"
                          ↓
Mobile agent:
  - Investigates deep link impact
  - Creates PR in mobile repo
  - Links to backend PR: "Fixes deep links for backend#123"
  - Logs: "completion: Mobile fix in PR mobile#456"
  - Mobile → Backend: "Created mobile#456 with fixes"
                          ↓
Backend agent:
  - Logs: "Mobile coordination complete, PR mobile#456 created"
  - Replies in backend PR: "I've coordinated with mobile. Created mobile#456 
    to handle deep link changes. When you merge this PR, mobile#456 will 
    auto-merge if approved."
                          ↓
Task pauses
                          ↓
Backend PR merged by human
                          ↓
Orchestrator detects: backend#123 merged, mobile#456 linked and approved
Orchestrator auto-merges mobile#456
```

### Example 3: Resuming from Slack

```
Task-456 created from GitHub @mention, now paused
                          ↓
User in Slack: "@ai-engineer what's the status on that validation PR?"
                          ↓
PM agent spawned
PM reads shared knowledge log:
  - Task started from GitHub PR
  - Backend added validation
  - Task paused waiting for feedback
                          ↓
PM replies in Slack: "Backend added input validation in commit abc123 
    on PR backend#789. Ready for your review."
                          ↓
User: "@ai-engineer actually can you also add rate limiting?"
                          ↓
PM spawns Backend agent in task-456 (resume)
Backend sees full context from log
Backend adds rate limiting, updates PR
Backend → PM: "Added rate limiting"
PM → Slack: "Rate limiting added in commit def456"
```

### Example 4: Vague Request Needs Clarification

```
Human: "@archie fix the bug"
                          ↓
Backend agent:
  - Reads PR, tries to identify "the bug"
  - Unclear what's being requested
  - Logs: "Unclear request, asking for clarification"
  - Replies in PR: "I see this PR changes authentication. Which specific 
    bug should I fix? Can you point me to the issue or describe it?"
                          ↓
Task pauses (waiting for response)
                          ↓
Human replies: "The token refresh race condition on line 234"
                          ↓
Backend agent resumes:
  - Logs: "Clarification received: token refresh race condition"
  - Fixes issue
  - Replies in PR: "Fixed race condition in commit abc123"
                          ↓
Task pauses
```

## Shared Knowledge Log Format

```
sessions/task-789/shared-knowledge.log:

[2025-01-15 10:23:45] [system] Task created from GitHub PR backend#123
[2025-01-15 10:23:45] [system] Request from @username: "fix deep links"
[2025-01-15 10:24:12] [backend-agent] discovery: API changes affect mobile deep linking
[2025-01-15 10:24:30] [backend-agent] action: Coordinating with mobile-agent
[2025-01-15 10:26:15] [mobile-agent] discovery: Deep link format needs update
[2025-01-15 10:28:45] [mobile-agent] completion: Created PR mobile#456
[2025-01-15 10:29:10] [backend-agent] completion: Replied in GitHub PR, linked mobile#456
[2025-01-15 10:29:10] [system] Task paused
[2025-01-15 14:32:18] [system] Task resumed from Slack message
[2025-01-15 14:32:45] [pm-agent] Provided status update in Slack
```

## Task Metadata

```json
{
  "task_id": "task-789",
  "created_from": "github",
  "github_pr": {
    "repo": "backend",
    "number": 123,
    "author": "username",
    "url": "https://github.com/org/backend/pull/123"
  },
  "linked_prs": [
    {
      "repo": "mobile",
      "number": 456,
      "url": "https://github.com/org/mobile/pull/456"
    }
  ],
  "slack_thread_id": null,  // Can be added if discussed in Slack later
  "thread_owner": "backend-agent",
  "participants": ["backend-agent", "mobile-agent"],
  "status": "paused",
  "last_activity": "2025-01-15T14:32:45Z"
}
```

## Integration Points

### GitHub → Task
- @mention creates task (if new PR)
- @mention resumes task (if existing PR)
- PR reviews/comments resume task
- PR merge triggers linked PR merge

### Task → GitHub
- Agent pushes commits
- Agent replies in comments
- Agent links related PRs
- Agent requests reviews when done

### Task → Slack
- User can ask about task in Slack
- PM provides status from knowledge log
- User can give additional instructions
- PM translates GitHub activity to human-friendly updates

### Slack → Task
- User can reference GitHub task from Slack
- PM resumes task with new context
- Agent continues work with full history
- Seamless context across platforms

## Permission Model

**Who can @mention ARCHIE:**
- Only the PR creator/author
- Verified via GitHub API: `comment.user == pr.author`
- Prevents interference from other team members

**What ARCHIE can do:**
- Read PR files and context
- Push commits to PR branch
- Reply to comments
- Create linked PRs in other repos
- Request reviews
- **Cannot merge PRs** (human retains control)

## Agent Behavior Principles

✅ **Human-like interaction**
- Asks clarifying questions when request is vague
- Explains what it's doing
- Coordinates with other agents when needed
- Admits limitations

✅ **Context-aware**
- Reads full PR context before acting
- Reviews conversation history
- Maintains continuity across pauses/resumes

✅ **Transparent**
- Logs all actions to shared knowledge
- Replies in PR to confirm completion
- Links related work explicitly

✅ **Adaptive**
- Handles simple requests directly
- Coordinates cross-repo work when needed
- Escalates complex/out-of-scope requests
- Works within existing PR ownership model

## Summary

✅ Only PR creator can @mention ARCHIE
✅ ARCHIE assists but doesn't merge (PR stays owned by creator)
✅ Agent behaves like human engineer (asks questions, coordinates, explains)
✅ Task pauses after agent completes turn
✅ Cross-repo coordination creates linked PRs with auto-merge on primary merge
✅ All actions logged to shared knowledge for seamless context across triggers
✅ Tasks can be triggered/resumed from GitHub or Slack interchangeably
