# Memory Layer — CLAUDE.md

`src/memory/` is Archie's file-based, workspace-bound memory subsystem. It keeps a
global public corpus plus compact private outcomes for one exact internal Slack channel
or human user. All behavior is gated by `ARCHIE_MEMORY`.

## Read before changing this subsystem

- `docs/architecture/memory.md` is the as-built architecture and operator guide.
The root repository instructions still apply.

## Keep documentation and tests in the same change

- Flow, storage, privacy, or rollout changes require an update to
  `docs/architecture/memory.md`.
- Flag changes require updates to both the architecture document and `.env.example`.
- Logic changes require focused tests under `src/memory/__tests__/` or the owning core
  subsystem's test directory.

## Invariants

- **Workspace-bound store.** `memory/.scoped-v1.json` binds the store to the authenticated
  Slack team. Missing identity, mismatched identity, malformed metadata, and non-empty
  legacy stores fail closed for memory without stopping Archie or its triggers.
- **Host-controlled authorization.** Task scope and author IDs come only from resolved
  Slack metadata. Transcript text, body mentions, display names, and model output never
  grant memory access.
- **One task, one destination.** The first Slack destination fixes the task audience.
  Public/private tasks stay in that exact channel; DM tasks stay in that exact DM.
  Public/private conversion changes live authorization, not persisted task metadata.
- **Strict storage split.** Rich profiles, entities, activity, and task summaries live
  under `memory/public/`. Private outcomes live only at
  `memory/private/channels/<channel-id>.md` or
  `memory/private/users/<human-user-id>.md`. Runtime queue state lives under
  `memory/runtime/`.
- **Live authorization.** Memory reads and Slack deliveries reclassify the fixed
  destination while memory is active. Lookup failures and external/guest visibility
  deny scoped access. With memory disabled or unavailable, normal delivery still works
  inside the fixed destination.
- **Public profiles use human Slack IDs only.** New profile and DM paths accept `U…` or
  `W…` IDs. Bot IDs, fallback IDs, display names, and path-shaped values cannot create
  or authorize scoped profile files.
- **Model output is untrusted.** Extraction output passes through `sanitize.ts` before
  persistence. Memory tool responses are escaped, marked as untrusted evidence, and
  size-bounded.
- **Writes are serialized.** Extraction, rolling-outcome replacement, pending recovery,
  and automatic housekeeping use the lifecycle queue. Do not add an independent writer
  to scoped memory.
- **Flags are independent and default safe.** `ARCHIE_MEMORY=false` disables every seam.
  `ARCHIE_MEMORY_INJECT` and `ARCHIE_MEMORY_TOOLS` independently gate public prompt
  injection and read-only tools; both default off.
- **No migration or external dependency.** Scoped v1 remains Markdown/JSON on disk. An
  operator backs up or wipes an old store instead of migrating it.

## Load-bearing files

- `paths.ts` — scoped paths, identifier guards, readiness, and flags.
- `index.ts` — workspace marker initialization and completion-listener registration.
- `lifecycle.ts` — serialized public/private extraction routing.
- `outcomes.ts` — atomic, bounded private rolling files.
- `task-authors.ts` — structured-author filtering.
- `tools.ts` — read-only MCP tools and live authorization.
- `sanitize.ts` — persistence trust boundary.
- `context.ts` — public-only prompt injection.

## Verify

```bash
npx vitest run src/memory/__tests__/ --testTimeout=10000
npm run typecheck
npm run build
```

The standalone `memory:housekeeping` command deliberately refuses a scoped store because
it cannot authenticate the workspace or join the runtime write queue. Scoped public
profiles are housekept automatically in-process.
