# Security Architecture

Defense-in-depth for a single-agent-per-task runtime: OS-level sandboxing, application-level hooks, tool denylists, and human gates.

## What the flat model gave up

**Name this before reading anything else, because it is a deliberate posture change.** Archie used to run several agent processes per task — a PM, repo agents, plugin agents — each its own bubblewrap sandbox with its own MCP servers and its own network allowlist. A data-analyst process could not reach the GitHub token, and only the ops agent's shell could reach the production admin host.

That boundary is gone. A task now runs **one process**: the PM's session, with every worker it spawns running as a subagent *inside* it. Three consequences:

- **Credentials are a union.** Every MCP server in the root `.mcp.json` attaches to the session, so every worker can reach every integration the deployment has configured.
- **The network allowlist is a union.** One list from `archie.json`, applied to the whole session, instead of one list per role.
- **Per-worker tool restriction is model-facing policy, not containment.** A plugin agent's `tools` / `disallowedTools` frontmatter still narrows what that worker is *offered*, and the SDK enforces it for that subagent — but it is a scoping aid, not a security boundary, because the worker shares the parent's process, filesystem grants and credentials.

This is accepted for an internal system. What replaces the old boundary is the **human-in-the-loop tiers** in the root MCP config: production writes go through a per-call approval rather than through process isolation. See [Tool Approvals](tool-approvals.md).

The boundaries that *do* still hold are the task (one session folder, one clone per repo, base clones read-only), the filesystem sandbox, the egress allowlist, and the approval gates below.

## Threat Model

### 1. Exfiltration

A compromised agent could try to leak code, credentials or internal data to an external service. The primary vector is web research: a coerced query embedding sensitive data flows to the external Perplexity API.

### 2. Sabotage

Injected instructions in web content could reach an agent with elevated privileges (repo writes, Slack posting, PR creation), causing unauthorized changes or misleading communications.

### 3. Resource Exhaustion

An agent in a loop could spawn unlimited research requests, consuming API credits and compute.

### Trust Boundary

**Web content is untrusted, and so is one part of the system prompt.** Plugin configuration and Slack messages from authenticated internal users are treated as trusted.

The exception is the `<channel_pinned_messages>` block (see [Channel Pinned Messages](slack-integration.md#channel-pinned-messages)). A line marked `source="verbatim"` is a channel member's own text passed through unaltered — the block's `note` tells the agent to read those lines as untrusted user input, never as direction. Three defences bound it: both the pin's author and its pinner must classify as internal (a bot posting from another workspace is refused; an internal bot's post is adopted and marked `(app)`, on the same rule thread ingestion uses, with the human pinner as the trust gate); every value is XML-escaped so nothing in a pin can close the wrapper or forge an element with someone else's attribution; and the block is an index that carries no authority until the agent opens the real message. What it does not defend against is an internal member pinning something adversarial — the same exposure the channel canvas already accepts, over a wider surface.

`WebSearch` and `WebFetch` are removed from the session's tool list, so `mcp__research-tools__web_research` is the only inbound web channel.

Slack and GitHub events are authenticated at the receiver layer before they reach any agent:

- **Slack:** Bolt verifies request signatures via the signing secret. On top of that, the event handler classifies the author with `isExternalUser` and bails out for users on a different `team_id` (Slack Connect) or guests. External-authored content is redacted from thread history before the PM sees it. That question is answered in exactly one place — `shouldRedact` in `src/connectors/slack/message-body.ts`, `shared && isExternalUser(author)` — so every ingestion path applies the same rule. Three render paths are deliberately **unredacted**, each safe by a *different* upstream drop: `exploreBody` (`read_channel_history` / `read_thread` — the agent asked to read that channel), `pinBody` (the two-principal pin gate already dropped anything externally authored or pinned), and `rawMessageBody` (the edit handler bails on an external editor; trigger dispatch drops a foreign-workspace app post before rendering).

  One write to `knowledge.log` bypasses `shouldRedact`: the **ingestion floor** in `fireTrigger` (`src/system/trigger-scheduler.ts`), for the case where `fetchSlackThread` dropped the triggering message. It is gated on the payload carrying **no identity at all** — no `user` and no `bot_id` — which is the one drop reason redaction has nothing to say about, since there is no author to classify.

  **The author bail-out is `event.user`-gated, so it never classifies an app post** — an app post carries no `user`. Any path an app post can reach therefore gates on the bot's own team itself, mirroring thread ingestion's rule (drop a bot from a foreign team, keep internal bots): `channel-pins.ts` for pins, `dispatchChannelMessageTriggers` for triggers.
- **GitHub:** Webhook payloads are HMAC-SHA256 verified against `GITHUB_WEBHOOK_SECRET` before any routing or task lookup.

## Defense Layer 1: The task sandbox

One sandbox policy per task, built once at spawn from `metadata.edit_allowed` and shared by the PM and every worker it spawns.

**Source:** `src/agents/sandbox.ts`, `src/agents/spawn.ts`

### Enforcement architecture

Three layers, all fed from the same `SandboxOptions` so they cannot drift:

1. **OS-level sandbox** (bubblewrap on Linux, sandbox-exec on macOS) — restricts `Bash` at the kernel level via `@anthropic-ai/sandbox-runtime`.
2. **Policy tier** (`managedSettings`) — what actually enforces the egress allowlist.
3. **PreToolUse hooks** (`createFilesystemGuardHooks`) — the same path boundaries on the in-process tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`), resolved to absolute before checking.

### Filesystem isolation

Grants are keyed on **directories**, not on the clones that happen to exist — that is what lets `mount_repo` create a clone mid-session and have it be reachable immediately, without a respawn.

| | Paths |
|---|---|
| `denyRead` | `/app`, `/home/archie/.claude`, and all of `$ARCHIE_WORKDIR` |
| `allowRead` | the PM workspace; `sessions/<taskId>/repos/` (this task's clones); `$ARCHIE_WORKDIR/repos/` (the shared base-clone cache); `shared/`; the SDK config and tmp dirs; the plugins repo; the core plugin directory |
| `allowWrite` | `/tmp`; the PM workspace; `$ARCHIE_WORKDIR/caches/`; the SDK tmp dir; **and, only in edit mode**, `sessions/<taskId>/repos/` |
| `denyWrite` | `$ARCHIE_WORKDIR/repos/` (always — a task that could rewrite a base clone would corrupt every other task sharing it); `sessions/<taskId>/repos/` while read-only; everything in `allowRead`; `.claude/settings.json`, `.claude/skills`, `.claude/hooks`, `CLAUDE.md` in the workspace; and each clone's `.git/HEAD` in edit mode |

On a **trigger-fired** task, that trigger's persistent directory is added to both the read and the write lists ([triggers.md](triggers.md#persistent-per-trigger-directory)).

`.git/HEAD` stays deny-write even in edit mode, so branch movement has to go through `switch_branch` / `create_branch` rather than a raw `git checkout`. **Known limitation:** that one deny is still enumerated per clone at spawn time, because the deny lists are prefix-matched and no directory expresses "`.git/HEAD` under any clone" — so a repo mounted mid-session in edit mode has a writable HEAD until the next respawn.

Two `allowRead` entries are holes punched through a broad denial rather than paths outside it: the **plugins repo** (under the denied `$ARCHIE_WORKDIR`) and the **core plugin** (under the denied `/app`). Loading a skill needs neither — `Skill` is in neither the hook's `READ_TOOLS` nor its `WRITE_TOOLS`, and the CLI reads `SKILL.md` in-process rather than through `Bash`. Reading a skill's *file* is what is gated, and both layers block it for different reasons: the hook because the path appears in no allow list, bubblewrap because it resolves back to `/app`.

**A path can be granted write-only** — present in `allowWrite` without a matching `allowRead`. `CACHES_DIR` is granted that way. It is still fully readable, including from `Bash`: measured under bwrap 0.11.0, `denyRead` emits its `--tmpfs` **before** the `allowWrite --bind`, so the bind sits on top and survives (see Known Limitation 1). But the in-process artifact tools cannot read it — `assertReadable` (`src/agents/artifacts.ts`) validates against `allowReadPaths` alone — so **a path agents are expected to produce shareable output in should be granted in both lists**.

### Network

Outbound access from `Bash` is deny-all by default: the session cannot `curl` or `wget`, and web access is only available through the research pipeline. The allowlist is the **union** for the whole task: `archie.json`'s `allowedNetworkDomains`, plus the two trusted package registries (`registry.npmjs.org`, `registry.yarnpkg.com`) when edit mode is approved, so `npm`/`yarn` installs and lockfile regeneration work.

The allowlist is enforced from the **policy tier** (`managedSettings`), not from the `sandbox` option — see `buildManagedNetworkPolicy`. `sandbox.network.allowedDomains` is silently ignored under `permissionMode: 'bypassPermissions'`, which the session runs under, so the policy tier is what actually holds the boundary. Because that enforcement lives in the Claude CLI rather than in our code it is version-coupled and has regressed before (CLI 2.1.156 → 2.1.157) with our config unchanged. `tools/e2e/egress-check.ts` asserts the boundary against a live instance for exactly this reason — treat an SDK bump as a security-relevant change and re-run it.

Two deployment caveats. A host-level IT managed-settings tier (e.g. `/etc/claude-code/managed-settings.json`) causes the SDK to **drop** our policy tier unless that admin sets `parentSettingsBehavior: 'merge'`, which would reopen egress with no error. And DNS inside the sandbox namespace is unavailable by design — all egress is forced through the sandbox's local proxy, so tools that ignore proxy environment variables fail to resolve even allowlisted hosts.

### Repo isolation: shared clones

Task clones are `git clone --shared` repositories, one per repo per task. Each has a fully independent `.git/` — its own HEAD, index, refs and config — and the only connection to the base repo is a read-only alternates link to `.git/objects/` (immutable, content-addressed blobs). `origin` is rewritten to GitHub, so a push never goes back to the base cache. Git identity is configured on each clone at creation. Bwrap sandbox artifacts (`.bashrc`, `.gitmodules`) are excluded via `.git/info/exclude`.

Within a task the clone is *not* an isolation boundary between workers: they share the process and the working tree, which is why the PM's prompt forbids pointing two workers at the same clone at once.

### Tool gating

The session runs with `permissionMode: bypassPermissions`. Availability is controlled through `disallowedTools`, which removes a tool from model context entirely:

| Tool | Read-only task | Edit mode |
|---|---|---|
| `Read`, `Glob`, `Grep`, `Bash`, `Skill`, `Agent` | available (sandboxed) | available (sandboxed) |
| `Write`, `Edit` | workspace only — clones are deny-write | workspace and clones |
| `repo-tools` read side | available | available |
| `repo-tools` write side (`push_branch`, `create_pull_request`, `merge_pull_request`, …) | **withheld** | available |
| `WebSearch`, `WebFetch`, `Cron*` | withheld | withheld |
| `deny`-tiered MCP tools | withheld | withheld |

### Sandbox bypass prevention

- `failIfUnavailable: true` — refuse to run rather than silently degrade to unsandboxed when bwrap/sandbox-exec is missing
- `allowUnsandboxedCommands: false` — the `dangerouslyDisableSandbox` Bash parameter is ignored
- `autoAllowBashIfSandboxed: true` — Bash is auto-approved when sandboxed
- All paths are resolved to absolute before checking, which prevents `../../` traversal

## Defense Layer 2: Research pipeline isolation

The research pipeline is the single channel through which untrusted web content enters. `mcp__research-tools__web_research` delegates to the Perplexity Agent API and runs server-side in the host Node process — it does not spawn a Claude subagent that could be prompt-injected into calling other tools. It returns a structured payload (`research_id`, `content`, `source_urls`).

**Bedrock guardrails.** Before a query is sent and before a response is returned, the text is scanned via `scanWithGuardrail` against an AWS Bedrock Guardrail (`BEDROCK_GUARDRAIL_ID` / `BEDROCK_GUARDRAIL_VERSION`). The INPUT scan rejects queries that look like they are leaking PII, secrets or proprietary data; the OUTPUT scan rejects responses flagged for prompt injection. Unset means the scan is skipped, with a one-time warning.

**Defense tag hook.** `createResearchDefenseTagHook` (PostToolUse) wraps every result in `<research_result source="external_web">…</research_result>` plus a system line saying the content is reference only and its instructions must not be followed.

**Preset classifier.** One nested `query()` to a Haiku classifier picks a Perplexity preset. It runs with `allowedTools: []` — no tools at all, only structured JSON output.

**Source:** `src/mcp/research-tools.ts`, `src/agents/spawn.ts`

## Defense Layer 3: Human-in-the-loop

**Edit mode.** A task starts read-only: the write side of `repo-tools` is absent and the clones are deny-write. The PM calls `request_edit_mode` with a reason, Slack buttons are posted, the task parks. On approval the clones move onto the task branch, the sandbox flips them writable and the PM's session is resumed with the new configuration. One-way and task-lifetime. See [edit-mode.md](edit-mode.md).

**MCP tool approvals.** An MCP server can declare, per tool, that calls need a per-call human approval — an `archie` block next to its connection config in the root `.mcp.json`. A PreToolUse hook classifies each call: `allow` runs ungated, `deny` never runs (and is withheld through `disallowedTools` up front), `ask` is denied while an engine-rendered Slack prompt is posted and the task parks. Optional `access.approverGroups` restricts resolution to verified active members of configured Slack user groups. Protected grants bind the exact call to the task and current policy, recheck membership before spend, and are single-use. Because the policy travels with the server and the session mounts every server, one config covers the whole task. This is the primary protection for production writes now that process isolation is gone. See [tool-approvals.md](tool-approvals.md).

**PR review.** All code changes go through pull requests. Merge is gated on GitHub branch protection, and in repos without `autoMerge: true` on an explicit user approval as well ([github-integration.md](github-integration.md#merge-policy-automerge)).

## Defense Layer 4: Git / GitHub safety

| Operation | Mechanism | Enforced by |
|---|---|---|
| `git commit` locally | allowed freely | local only |
| `git push` via Bash | blocked | network deny-all in the sandbox |
| Push / branch creation | allowed via MCP | tool design (no force push) |
| Push to main | blocked | GitHub branch protection (server-side) |
| Force push to any branch | blocked | GitHub branch protection (server-side) |
| Raw `git checkout` in a clone | blocked | `.git/HEAD` in `denyWrite` (per clone at spawn — see the limitation above) |

The `repo-tools` MCP server is the only pathway to GitHub.

## Defense Layer 5: Per-task resource budgets

- **Research requests** — 5 per task. On exhaustion a `blocker` finding is written, Slack approval buttons are posted ("Approve (+5)" / "Deny") and the task parks.
- **Wall-clock** — 60 minutes, after which the task posts a pause message and parks so it reopens on the next reply.

## Defense Layer 6: Observability

All output goes through the unified logger (`src/system/logger.ts`); direct `console.*` is prohibited and agent stderr is captured.

`shared/knowledge.log` is the per-task audit trail: Slack messages, GitHub events, user-facing replies, and system findings for every approval, denial, budget change, gated call requested and gated call actually spent. It is **write-only from the running agent's point of view** — the PM is fed inline and never reads it — so it cannot be used as an injection channel into the live session. See [persistence.md](persistence.md#the-knowledge-log).

## Enforcement Layers Summary

```
Layer 1: OS-level sandbox (Bash only)
  ├── denyRead [/app, ~/.claude, $ARCHIE_WORKDIR]
  ├── allowRead [workspace, task repos/, base repos/, shared/, plugins repo, core plugin, SDK dirs]
  ├── allowWrite [/tmp, workspace, caches/, SDK tmp, + task repos/ in edit mode]
  ├── denyWrite [base repos/, protected workspace files, + task repos/ when read-only, + clone .git/HEAD]
  ├── failIfUnavailable: true (refuse to start rather than run unsandboxed)
  └── network namespace: no DNS, no direct route — all egress via the sandbox proxy

Layer 1b: Policy tier (managedSettings) — enforces the egress allowlist
  ├── archie.json allowedNetworkDomains (the union for the whole session)
  ├── + trusted package registries in edit mode
  └── allowManagedDomainsOnly: true — user/project/local/flag domain rules ignored

Layer 2: PreToolUse hooks (Read, Write, Edit, Glob, Grep)
  └── same boundaries on in-process tools; writable implies readable

Layer 3: disallowedTools (removes tools from model context)
  ├── WebSearch, WebFetch, Cron* — always
  ├── repo-tools write side — until edit mode is approved
  └── deny-tiered MCP tools — from the root config

Layer 4: Git isolation
  ├── shared clones: independent .git/, read-only alternates to base objects
  ├── network deny-all blocks git push/fetch from Bash
  └── MCP tools scoped (no force push) + GitHub branch protection

Layer 5: Human gates
  ├── edit mode (task-lifetime), MCP tool approvals (per call, optionally Slack-group restricted), merge approval (per PR)
  └── PR review before merge

Layer 6: Resource budgets
  ├── research: 5 requests/task (extendable via Slack)
  └── wall-clock: 60 minutes/task
```

## Deployment Requirements

### Docker container configuration

The sandbox uses bubblewrap, which requires specific Docker privileges:

```yaml
cap_add:
  - SYS_ADMIN           # Namespace creation and mount operations
security_opt:
  - seccomp=unconfined  # Allows bwrap's clone/unshare syscalls
  - apparmor=unconfined # Allows bwrap's mount operations
  - systempaths=unconfined  # Removes /proc masking for PID namespace isolation
```

Bubblewrap creates Linux user namespaces to isolate Bash commands, and Docker's default profile blocks the syscalls it needs. This is **not** `--privileged`: device cgroup restrictions, capability bounding and mount namespace isolation all remain. **Fargate compatibility:** AWS Fargate supports neither `cap_add: SYS_ADMIN` nor custom security options, so production needs EC2-backed ECS or EKS.

### Non-root user

The container must run as the non-root `archie` user — the SDK's `bypassPermissions` mode refuses to execute as root. The entrypoint starts as root (to fix SSH socket permissions on macOS), then drops via `su-exec`.

### Persistent volumes

| Path | Purpose |
|---|---|
| `/workdir` | Runtime state: base clones, sessions, plugins, caches, trigger records and per-trigger data |
| `/home/archie/.claude` | Claude CLI config, session logs, shell snapshots |
| `/home/archie/.claude.json` | Claude CLI feature flags (auto-regenerated if missing) |

## Known Sandbox Limitations

### 1. ~~denyRead on parent destroys allowWrite on children~~ — not reproducible; retained as a correction

**This entry was wrong, and its claim survived long enough to shape both code comments and agent-facing prompt text, so it is corrected here rather than deleted.**

**What it claimed:** that bwrap emits `allowWrite --bind` before `denyRead --tmpfs`, so a tmpfs on the parent destroys a child's writable bind, leaving `allowRead` to restore read-only access with write "permanently lost".

**What is actually true**, measured inside the container under **bubblewrap 0.11.0** with the production config (`denyReadPaths: ['/workdir']`, child granted through `allowWritePaths` only): the child is fully readable **and** writable from `Bash`, and the writes persist to real disk. The ordering is the reverse of the claim — the `denyRead` tmpfs is emitted **first** and the `allowWrite` bind is layered on top. Inside the sandbox the granted child lists normally while its parent renders as a mode-700, 60-byte tmpfs. A control with `allowRead` alone yields read-without-write, confirming the sandbox was genuinely enforcing.

**Consequence:** no workaround is needed. If a future `sandbox-runtime` upgrade changes mount ordering, re-measure rather than assuming either direction.

### 2. SDK binds sensitive files as /dev/null device nodes

The SDK's sandbox replaces certain files (`.gitmodules`, `CLAUDE.md`) with `/dev/null` bind mounts inside bwrap. They appear as character device nodes in the working directory, so `git status` shows them as untracked and `git add` fails with "can only add regular files."

**Workaround:** they are added to `.git/info/exclude` on every clone setup via `configureSandboxExcludes()`. **Remove when:** the SDK offers a way to configure which files are `/dev/null`-mounted.

### 3. `.git/HEAD` deny is per clone at spawn

See [Filesystem isolation](#filesystem-isolation): a repo mounted mid-session in edit mode has a writable `.git/HEAD` until the next respawn, because the deny lists are prefix-matched and there is no directory that expresses the rule.

## What Is NOT Yet Implemented

- **Per-worker containment.** Covered above — worker tool restriction is model-facing policy, not isolation.
- **Content-level injection detection beyond Bedrock Guardrails.** The guardrails are optional; when `BEDROCK_GUARDRAIL_ID` is unset the scan is skipped, and there is no in-process pattern-matching fallback.
- **DNS monitoring.** No runtime monitoring of DNS queries to detect exfiltration via DNS tunneling.
- **Sandbox for the nested classifier subagent.** The nested `query()` in `research-tools.ts` (`classifyPreset`, Haiku) has no sandbox configuration. It runs with `allowedTools: []`, so the only attack surface is malformed JSON — there are no filesystem or network tools to abuse.
- **A named cross-task deny.** Other tasks' session directories are unreachable only as a consequence of `$ARCHIE_WORKDIR` being denied wholesale with this task's own subtrees re-granted on top. There is no rule that says "another task's folder is off limits", so a future grant that widens the re-allow would reopen it silently.

## Related Documentation

- [Plugin System](./plugin-system.md) — what a plugin may contribute, and the engine-owned root config
- [Tool Approvals](./tool-approvals.md) — the gate that replaces per-agent credential scoping
- [Web Research](./web-research.md) — full research pipeline details
