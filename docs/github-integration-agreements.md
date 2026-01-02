# Complete System Agreement - Final

## Core Philosophy

✅ **System behaves like human engineering team**
- Agents adapt based on context, not rigid modes
- Natural communication patterns
- Respond to events, not proactive monitoring
- Read shared context to understand situation

## PR Creation & Linking

✅ **Multi-repo tasks create linked PRs**
- Each repo agent creates PR in their own repo
- PRs linked via description using `repo#123` format (simple, human-readable, GitHub renders as links)
- Links are bidirectional and visible to humans
- Task metadata tracks all PRs for a task
- Cross-repo linking works natively in GitHub

## PR Review Handling

✅ **Reviews feed into original task session**
- System receives GitHub webhook
- System adds review feedback to shared knowledge log
- System spawns repo agent directly (no PM routing)
- Repo agent addresses feedback in same task session
- Agent makes fixes, pushes commits, replies to comments, requests re-review
- Logs work to shared knowledge log
- **Does NOT ping PM or update user in Slack** (unless needs user input)

✅ **Multi-PR reviews handled in parallel**
- Each repo agent works on their own PR's feedback independently
- Coordinate via direct messages if review feedback creates cross-repo dependencies
- All happening within same original task session

✅ **Thread ownership stays with original task owner**
- No automatic re-assignment for review feedback
- Original thread owner maintains responsibility for overall task completion
- PM can reassign task owner during execution if needed
- Agents adapt to ownership changes

## Merge Strategy - Hybrid Approach

✅ **Simple merge logic:**
```
All linked PRs either merged OR mergeable → merge remaining PRs
```

✅ **GitHub config handles all rules:**
- Required approvals count
- Code owner requirements
- CI/status check blocking
- Branch protection rules
- Merge method (squash/merge/rebase)
- Orchestrator just checks `mergeable` and `mergeable_state == "clean"`

✅ **Agent involvement only for blockers:**
- Merge conflicts
- CI failures
- Review feedback requiring code changes
- Agents investigate and fix, orchestrator retries merge

✅ **Human manual merges handled gracefully:**
- If human merges one PR, orchestrator waits for others to become mergeable
- Once all are resolved (merged or mergeable), merge remaining
- No blocking or prevention mechanisms needed

## PM Agent Role - Event-Driven

✅ **PM is translator between user and repo agents**
- User ↔ Technical translation layer
- Spawned on events, not monitoring
- Translates technical details to human-friendly language
- Translates vague user requests to clear technical tasks

✅ **PM spawns when:**
- User sends Slack message
- Repo agent sends direct message to PM (needs user input, reports completion, etc.)
- System detects task timeout (no activity for 30+ min)

✅ **PM does NOT:**
- Continuously monitor shared logs
- Route PR review feedback (goes direct to repo agent)
- Micromanage agent coordination
- Get involved in normal agent-to-agent work
- Get updates about individual PR review cycles

✅ **PM always reads shared log first:**
- On every spawn/interaction
- Understands context before responding
- Part of PM agent instructions

## Agent Adaptive Behavior

✅ **Agents adapt based on context, not rigid modes**
- Always read shared knowledge log first to understand current state
- Determine responsibility level (task owner, participant, PR maintenance)
- Know who to report to (PM if owner, requesting agent if helping, GitHub if PR work)
- Adapt if context changes (ownership reassignment, new feedback, coordination needs)
- Escalate to PM when need user input

✅ **Agent responsibilities based on role:**
- **Task owner:** Coordinate overall completion, report to PM when done
- **Participant:** Help other agents, reply to them when done
- **PR maintenance:** Fix issues, update GitHub, no reports unless need help
- **Multiple roles simultaneously:** Agent handles all contexts in same session

✅ **Agents can transition between roles:**
- PM can reassign task ownership during execution
- Agent adapts behavior accordingly
- Continues work with new responsibility level

## Communication Model

✅ **All agent-to-agent communication uses direct messages (uniform)**
- Repo agent → Repo agent: coordination
- Repo agent → PM: escalation, completion reports, user input needed
- System spawns target agent when direct message sent
- Target agent always reads shared log first, then processes message

✅ **Shared knowledge log for progress visibility**
- All agents append discoveries, decisions, completions
- PM reads on every spawn
- Agents read to understand current context
- Creates paper trail and shared context

## Routing Philosophy

✅ **Slack messages → Through PM**
- User language might be vague
- PM interprets, routes to right agent
- PM translates technical responses to human-friendly

✅ **GitHub reviews → Direct to repo agent**
- Technical ↔ Technical communication
- No translation needed
- Repo agent handles directly, escalates to PM only if user input needed
- No Slack updates for routine PR feedback cycles

✅ **Agent completions → Direct message to PM**
- Task owner messages PM with technical summary when task fully complete
- PM translates to human-friendly Slack message

## What We Rejected

❌ Custom status checks to prevent early merging
❌ Draft PR prevention
❌ Orchestrator as merge bottleneck
❌ Separate task sessions for reviews
❌ Automatic re-assignment of thread ownership for reviews
❌ PM monitoring/polling shared logs
❌ PM routing every PR review
❌ Special "escalation" tags or detection systems
❌ Rigid operating "modes" - agents adapt instead
❌ Slack updates for individual PR review cycles

## Key Design Principles

✅ **Human-like behavior** - agents respond naturally, adapt to context
✅ **Event-driven** - react to webhooks and messages, not continuous monitoring
✅ **Context-aware** - read shared log to understand situation before acting
✅ **Decentralized coordination** - agents communicate directly, PM only for user interface
✅ **Simple over complex** - rely on GitHub's native features, minimal custom logic
✅ **Flexible responsibility** - agents handle multiple roles in same session
