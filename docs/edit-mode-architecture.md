# Architectural Decisions - AI Software Engineer System

## Overview
This document captures the key architectural decisions made for the multi-agent AI software engineer system that integrates with Slack and manages multiple repositories.

---

## 1. Two-Mode Agent System

**Decision:** Agents operate in two distinct modes based on task requirements.

- **Light Mode (Readonly)**: 
  - Exploration, questions, investigation
  - No git modifications allowed
  - Uses worktrees but with readonly MCP tools only
  
- **Heavy Mode (Edit)**: 
  - Actual code changes, commits, PRs
  - Full git operations enabled
  - Write MCP tools available

**Rationale:** 
- Cost efficient (no unnecessary clones for simple questions)
- Fast investigations without setup overhead
- Clear separation between exploration and implementation

---

## 2. Human-in-Loop Approval

**Decision:** System-level approval gate enforced outside of LLM control.

- MCP tool `request_edit_mode()` blocks until user approves
- Once approved per task, approval persists for all follow-ups
- Approval state managed by system code, never LLM-writable

**Rationale:**
- Security: LLMs cannot bypass approval through metadata manipulation
- User control: Explicit gate before any code modifications
- Workflow efficiency: Single approval per task, not per change

---

## 3. Git Worktrees for Everything

**Decision:** Use git worktrees for both readonly and edit modes.

- One base repository per codebase (backend, mobile, website)
- Ephemeral worktrees created per agent turn
- Both modes use same mechanism, differ only in tool availability
- Setup time: 1-2 seconds

**Rationale:**
- Fast: Much faster than cloning (1-2s vs 30-60s)
- Storage efficient: Shared .git directory across worktrees
- Consistent: Same approach for both modes
- Isolated: Each task gets separate worktree

---

## 4. Worktree Lifecycle = Agent Turn

**Decision:** Worktrees are ephemeral, existing only during agent execution.

- Created at turn start
- Deleted at turn end
- No persistent local storage per task
- Fresh state on each interaction

**Rationale:**
- Zero local storage waste
- No stale file issues
- Clean separation between turns
- Simple cleanup logic

---

## 5. Task-Level Mode Transition

**Decision:** Mode is a property of the task, with one-way transition.

- All tasks start in readonly mode
- Transition to edit mode after user approval
- Once in edit mode, task permanently stays in edit mode
- Future agent spawns respect task's current mode

**Rationale:**
- Once changes begin, agent needs consistent context
- Working branch exists after first edit
- Simpler than per-interaction mode switching
- Matches mental model of task progression

---

## 6. Branch Strategy

**Decision:** Feature branch per task, persisted remotely.

- Branch naming: `feature/task-{id}`
- Branch persists remotely after local worktree cleanup
- Follow-up work checks out existing branch
- PRs update automatically with new commits

**Rationale:**
- Standard git workflow
- Human-reviewable via PRs
- Resumable for follow-up changes
- No local state required

---

## 7. Cross-Agent Isolation

**Decision:** Complete isolation through separate repositories.

- Backend agent → backend repo worktrees
- Mobile agent → mobile repo worktrees
- Website agent → website repo worktrees
- Each works on own feature branches

**Rationale:**
- No shared .git conflicts
- No branch checkout collisions
- Parallel execution safe
- Simple reasoning about state

---

## 8. Metadata as State Store

**Decision:** File-based metadata tracks all persistent task state.

**What's stored:**
- Task mode (readonly/edit)
- Approval status
- Git branch name
- PR number and URL
- Agent participants
- Shared knowledge log
- Direct message threads

**What's ephemeral:**
- Worktree directories
- Agent working memory

**Rationale:**
- Single source of truth
- Survives system restarts
- Enables task resumption
- Clear separation: metadata persists, worktrees don't

---

## Summary

The architecture achieves:
- ✅ Space efficiency (ephemeral worktrees)
- ✅ Speed (1-2s worktree setup)
- ✅ Security (system-enforced approval)
- ✅ Isolation (separate repos, separate branches)
- ✅ Simplicity (consistent worktree approach)
- ✅ Human control (approval gate, reviewable PRs)

All while maintaining a clean separation between exploration (readonly) and implementation (edit) phases.
