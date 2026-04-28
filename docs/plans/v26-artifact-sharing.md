# Artifact Sharing Between Agents and to User

## Context

Currently, when agents collaborate on documents (e.g. backend agent drafts a plan, mobile reviews, backend revises, sends to PM, PM relays to user), the full document body is inlined in every `send_message_to_agent` and `post_to_user` call. The shared `knowledge.log` accumulates many copies of the same evolving document, bloating context and burning tokens.

We add an **artifact** primitive: agents copy a file into the task's shared folder under a content-versioned name and pass only the path in messages. Recipients read the file directly. Knowledge log records each share as a one-line audit entry, not a full document body.

Additionally, PM (and only PM, since `post_to_user` is PM-only) can attach files when posting to Slack, allowing it to deliver dev plans, research outputs, or other artifacts to the user as Slack file uploads instead of inline text.

## Design Summary

- **Artifact storage**: `<task>/shared/artifacts/` — flat directory, no per-agent subfolders.
- **Filename**: `<basename>.<8-char-uuid>.<ext>` (e.g. `plan.a1b2c3d4.md`). UUID assigned per share call.
- **Content dedup**: if the source file's content (sha256) matches an existing artifact in the dir with the same basename+ext, return the existing path instead of writing a new copy. This preserves "same file shared twice → single artifact" while still creating new versions when content changes.
- **Sandbox**: tool runs in-process (Node), bypasses sandbox. `shared/artifacts/` stays in `denyWritePaths` for agent shells. Read access to `sharedPath` already granted to all tracks — recipients read artifacts via their normal `Read` tool.
- **Knowledge log + events**: single new log entry per share. Also a system event so live CLI/UI observers see it.
  - Internal share: log line `[ts] [agent] [artifact] <relative-path> — <description>`; event type `agent:log` with `data: { finding: 'shared artifact: <path> — <description>', type: 'artifact' }` so existing CLI rendering at [TaskDetail.tsx:100](src/cli/components/TaskDetail.tsx#L100) shows it without changes. Add `'artifact'` to `FindingType` union.
  - Outbound to user: extend existing `[Attachments: …]` suffix on the message log entry (mirrors inbound path at [persistence.ts:215-221](src/tasks/persistence.ts#L215)). The `message` event already emitted by `logOutgoingMessage` carries the rendered message; including the attachments suffix in the rendered string is enough — CLI shows it via existing `case 'message'` branch at [TaskDetail.tsx:95](src/cli/components/TaskDetail.tsx#L95). No new event type needed.
- **Path validation**: source path must resolve (after symlink resolution) under the agent's `allowReadPaths` set. Reuses sandbox path config from `spawn.ts`.

## Files to Modify

### 1. New: `src/agents/artifacts.ts`

Core helpers:

- `validatePathInSandbox(absPath, allowReadPaths): Promise<string>` — resolve symlinks via `realpath`, return canonical path, throw if outside allowed roots. Used by both `share_artifact` and `post_to_user` artifact validation.
- `copyArtifactToShared(taskId, sourcePath, agentId): Promise<{ artifactPath: string; reused: boolean }>` — compute sha256 of source; check existing files in `shared/artifacts/` matching `<basename>.*.<ext>` for same hash; if hit, return existing absolute path with `reused=true`; else generate `<basename>.<uuid8>.<ext>`, copy, return new absolute path.
- `getArtifactsDir(taskId): string` — `join(getSharedPath(taskId), 'artifacts')`. Mirrors `getResearchesDir` pattern.

### 2. `src/tasks/persistence.ts`

- Add `getArtifactsPath(taskId)` near `getAttachmentsPath` (line 91).
- Add `appendArtifactShared(taskId, agentId, artifactPath, description)` — writes log entry: `[ts] [agentId] [artifact] <relative-path> — <description>` and emits `emitEvent('agent:log', taskId, { finding: 'shared artifact: <relPath> — <description>', type: 'artifact' }, agentId)`. Mirrors `appendAgentFinding` shape.
- Extend `renderMessageForContext` (or the outbound-message rendering path used by `logOutgoingMessage` in [task.ts:359](src/tasks/task.ts#L359)) to accept optional `artifacts: { name: string; path: string }[]` and append `[Attachments: a.md (path), b.md (path)]` suffix when present. The same string is logged AND placed in the `message` event payload, so CLI/SSE observers see attachments without extra event types.
- Add `'artifact'` to `FindingType` in [src/types/task.ts](src/types/task.ts) (union currently: `'discovery' | 'decision' | 'completion' | 'blocker'`).

### 3. `src/agents/tools.ts`

- Add `createShareArtifactTool(agent, task)` (after `createLogFindingTool`):
  - Inputs: `path: string` (absolute), `description: string`.
  - Resolves agent's `allowReadPaths` from spawn-time sandbox config (need to thread this through — see "Sandbox path access" below).
  - Calls `copyArtifactToShared`, then `appendArtifactShared`.
  - Returns: `Shared as <abs-path>. Logged to knowledge log.` (or raw error string on failure).
  - On `reused=true`, returned text notes existing version: `Already shared at <abs-path> (identical content). Logged.`
- Add tool to **both** `createBaseAgentMcpServer` (line 1103, used by repo + plugin tracks) and `createPMAgentMcpServer` (line 1042).
- Extend `createPostToUserTool` (line 159):
  - New optional input: `artifact_paths: string[]`.
  - Each path validated against PM's `allowReadPaths`.
  - Pass list to `task.postToUser`, which forwards to a new Slack helper.

### 4. `src/connectors/slack/client.ts`

- Add `postSlackMessageWithFiles(args: { channel, text, threadTs?, filePaths: string[] }): Promise<string | undefined>` using `client.files.uploadV2({ channel_id, thread_ts, initial_comment, file_uploads: [{ file: localPath, filename }, …] })`. Slack SDK v6 `uploadV2` returns when files are visible.
- In dry-run, log `[DRY RUN] postSlackMessageWithFiles ${channel}:${threadTs} — N files: a.md, b.md`.
- For consistency, when `text.length > SLACK_MARKDOWN_LIMIT` and there are no files, route through existing `postSlackMessage` (preserves limit error path); when `text` itself is short and files attached, use uploadV2.

### 5. `src/tasks/task.ts` — `postToUser`

- Accept new optional `artifactPaths: string[]` param.
- Each branch (existing-DM reply, new-DM, new-thread, target.channel, default) selects between `postSlackMessage` (no attachments) and `postSlackMessageWithFiles` (with attachments).
- `logOutgoingMessage` extended (or sibling helper added) to render attachments suffix `[Attachments: a.md (path), b.md (path)]` mirroring `renderMessageForContext` (line 215).

### 6. Sandbox path access for tool

Tool handler needs to know each agent's `allowReadPaths` to validate. Two options:

- **Option A (preferred)**: stash sandbox config on the `Agent` object at spawn time (`agent.allowReadPaths: string[]`). Tool reads `agent.allowReadPaths` directly. One-line addition in `spawn.ts` after each `sandboxOpts` block (3 places — pm/repo/plugin tracks).
- **Option B**: rebuild allow-paths in tool from task + agent. Duplicates spawn.ts logic. Avoid.

Plan uses **Option A**.

### 7. Prompt updates

Core mental model to instill: agents send two kinds of things — **messages/updates** (status, questions, decisions → `send_message_to_agent` / `post_to_user` / `log_finding`) and **documents** (plans, reports, diffs, longer outputs → `share_artifact`, then send the path). Don't paste document bodies into messages.

- `prompts/agent-core.md` (repo + plugin agents) — add short subsection under "Core Communication Tools":

  **Messages vs. Documents**

  Use `send_message_to_agent` and `log_finding` for short text: status, questions, decisions, completion reports. Use `share_artifact(path, description)` when you have a document — a plan, report, diff, or any longer output another agent will read or revise. It writes the file into the task's shared folder and returns an absolute path; pass that path in your message instead of pasting the body. Read incoming artifacts with the standard `Read` tool on the path the sender gave you. When you revise a document you previously shared, edit your local copy and call `share_artifact` again — each share is content-versioned, so previous versions remain available.

  Then add bullet under the tool list: `share_artifact(path, description)`: publish a document to the shared artifacts folder. Returns an absolute path other agents can `Read`.

- `prompts/pm-agent.md` — add the same short "Messages vs. Documents" subsection (PM does not load `agent-core.md`), and:
  - Add `share_artifact` bullet under Action Tools.
  - Extend `post_to_user` entry: "Optionally pass `artifact_paths: [path, …]` to attach files to the Slack message. When the user asked for a document (dev plan, research report, design proposal), attach it as an artifact rather than pasting the full body — keeps the thread skim-friendly and lets the user download the file."

Tool descriptions carry operational detail (path validation, dedup, return shape); prompts cover when and why to reach for the tool.

### 8. `src/agents/agent.ts`

- Add `allowReadPaths: string[]` field on `Agent`. Populated by spawn.ts.

## Critical Files Referenced

- `src/agents/tools.ts` — tool definitions ([tools.ts:119-155](src/agents/tools.ts#L119-L155) base tool pattern; [tools.ts:1042-1112](src/agents/tools.ts#L1042-L1112) MCP servers)
- `src/agents/spawn.ts` — sandbox config per track ([spawn.ts:248-265](src/agents/spawn.ts#L248) PM, [spawn.ts:266+](src/agents/spawn.ts#L266) repo, [spawn.ts:430-489](src/agents/spawn.ts#L430) plugin)
- `src/tasks/persistence.ts` — log helpers ([persistence.ts:170](src/tasks/persistence.ts#L170) format, [persistence.ts:215-221](src/tasks/persistence.ts#L215) attachment rendering precedent)
- `src/tasks/task.ts` — `postToUser` ([task.ts:287-356](src/tasks/task.ts#L287))
- `src/connectors/slack/client.ts` — Slack send ([client.ts:166-187](src/connectors/slack/client.ts#L166))
- `src/mcp/research-tools.ts` — research artifact precedent ([research-tools.ts:327-341](src/mcp/research-tools.ts#L327))
- `prompts/agent-core.md`, `prompts/pm-agent.md` — prompt updates

## Verification

1. **Build**: `npm run build` and `npm run typecheck` clean.
2. **Internal share unit-style check**:
   - Create a fake task dir under `workdir/sessions/test-artifact/`.
   - Write a file in `agents/backend/out.md`.
   - Call `copyArtifactToShared` directly via a small node script (or REPL-style).
   - Verify `shared/artifacts/out.<8hex>.md` exists; second call with identical bytes returns same path; second call with mutated bytes creates new file.
   - Verify knowledge.log entry written.
3. **End-to-end multi-agent**: in a dev task, instruct backend agent to write a plan to `out/plan.md`, share it, then send the path to mobile. Confirm:
   - Mobile can `Read` the shared path.
   - knowledge.log shows one `[artifact]` line, no inlined plan body.
   - Repeat share with edits → new artifact file.
4. **PM Slack upload**: trigger PM to call `post_to_user(message, artifact_paths=[shared/artifacts/plan.<hash>.md])`. Verify file appears in Slack thread, knowledge.log entry includes `[Attachments: plan.<hash>.md (path)]`.
5. **CLI live view**: while running an end-to-end task, watch the CLI (`src/cli`) to confirm `[artifact]` lines render in the task detail view (via existing `agent:log` event branch) and outbound `[Attachments: …]` shows up on the user-message line.
6. **Path rejection**: attempt to share `/etc/hosts` or a path outside agent's read scope — confirm tool returns clear error and no file copied.
7. **Symlink escape**: create a symlink in agent workspace pointing to `/etc/passwd`, attempt share — confirm `realpath` resolution rejects.
8. **Slack file size**: attempt to upload a large file that exceeds Slack limit — confirm tool surfaces Slack's error to the agent (not swallowed).
