# Consolidate repos/sessions/plugins under ARCHIE_WORKDIR

## Context

Currently Archie uses three separate directory trees managed independently:
- `/repos` (env: `ARCHIE_REPOS_DIR`) — pre-cloned source repos, requires manual `git clone`
- `./sessions` (hardcoded) — per-task session data
- `./plugins` (env: `ARCHIE_PLUGINS_DIR`) — plugin definitions (local folder or symlink)

Each requires separate setup, separate Docker volume mounts, and separate env vars. The deploy script must know about all three.

**Goal**: Consolidate under a single `ARCHIE_WORKDIR` directory. The app auto-clones plugins from a git URL and auto-clones source repos declared by plugins. Two env vars replace three:
- `ARCHIE_WORKDIR` — base directory (default: `./workdir`)
- `ARCHIE_PLUGINS` — git URL for the plugins repo (optional; if unset, `{WORKDIR}/plugins` must exist)

**New directory layout:**
```
{ARCHIE_WORKDIR}/
├── plugins/     # Cloned from ARCHIE_PLUGINS
├── repos/       # Auto-cloned from plugin repo-config.json
└── sessions/    # Created at runtime
```

---

## Key Decisions

- **Clone protocol**: HTTPS (leverages existing `GIT_ASKPASS` + GitHub App token in Dockerfiles)
- **Plugin strategy**: Clone if missing, `git pull --ff-only` if exists
- **Repo strategy**: Clone if missing, `git fetch --all` if exists — on startup
- **Old env vars**: Remove `ARCHIE_REPOS_DIR`, `ARCHIE_PLUGINS_DIR`, `ARCHIE_SESSIONS_DIR`
- **Local dev**: Default `ARCHIE_WORKDIR=./workdir`; if `ARCHIE_PLUGINS` unset, plugins dir must exist manually

---

## Implementation Steps

### 1. Create `src/system/workdir.ts` (new file)

Central bootstrap module providing:

**Synchronous path constants** (safe for module-level imports):
```
WORKDIR     = process.env.ARCHIE_WORKDIR || join(process.cwd(), 'workdir')
PLUGINS_DIR = join(WORKDIR, 'plugins')
REPOS_DIR   = join(WORKDIR, 'repos')
SESSIONS_DIR = join(WORKDIR, 'sessions')
```

**Async bootstrap functions:**
- `bootstrapWorkdir()` — creates dirs, clones/pulls plugins from `ARCHIE_PLUGINS` env var
- `cloneRepos(repos)` — clones repos declared by loaded plugins into `REPOS_DIR`

Git helpers:
- `githubRepoToUrl(githubRepo)` — converts `"sweatco/sweatcoin-backend"` → `"https://github.com/sweatco/sweatcoin-backend.git"`
- `cloneOrPull(url, dir, label)` — clone if missing, `git pull --ff-only` if exists (for plugins)
- `cloneOrFetch(url, dir, label)` — clone if missing, `git fetch --all` if exists (for source repos)

Error handling:
- Clone failures → throw (fatal, abort startup)
- Pull/fetch failures → warn and continue (existing content still functional)

### 2. Refactor `src/system/plugin-loader.ts` — explicit init

Currently loads at module level (line 142: `const loadedPlugins = scanPlugins()`).

Changes:
- Remove line 18 (`PLUGINS_DIR` constant) → import from `workdir.ts`, re-export for compatibility
- Remove line 142 (module-level `scanPlugins()`) → `let loadedPlugins: LoadedPlugin[] = []`
- Add exported `initPlugins()` that sets `loadedPlugins = scanPlugins()`
- Accessor functions (`getPlugins`, etc.) use the module variable directly — no guards, no null checks. `main()` calls `initPlugins()` before anything uses them.

### 3. Refactor `src/agents/repo-configs.ts` — explicit init

Currently loads at module level (line 76: `const repoConfigs = buildRepoConfigs()`).

Changes:
- Remove line 16 (`REPOS_DIR` constant) → import from `workdir.ts`
- Remove line 14 import of `PLUGINS_DIR` → import from `workdir.ts` (for error message)
- Remove lines 76-85 (module-level build + fail-fast check) → `let repoConfigs: RepoAgentConfig[] = []`
- Add exported `initRepoConfigs()` that sets `repoConfigs = buildRepoConfigs()` + fail-fast check
- Accessor functions use the variable directly — no guards.

### 4. Refactor `src/agents/plugin-configs.ts` — explicit init

Currently loads at module level (line 71: `const pluginAgentConfigs = buildPluginAgentConfigs()`).

Changes:
- Remove line 71 → `let pluginAgentConfigs: PluginAgentConfig[] = []`
- Add exported `initPluginAgentConfigs()` that sets `pluginAgentConfigs = buildPluginAgentConfigs()`
- Accessor functions use the variable directly — no guards.
- Remove line 13 comment about "ensures repo-configs.ts initializes first" — irrelevant now

### 5. Update `src/system/task-manager.ts`

Single-line change:
- Remove line 14 (`const SESSIONS_DIR = join(process.cwd(), 'sessions')`)
- Add `import { SESSIONS_DIR } from './workdir.js'`

Everything else (path helpers, grep commands) uses `SESSIONS_DIR` already — no other changes.

### 6. Update `src/index.ts` — new startup sequence

Current startup: imports trigger module-level loading → log → start server → recover tasks.

New `main()` sequence:
```
1. Banner + PATH fix
2. loadConfig()
3. bootstrapWorkdir()         — create dirs, clone/pull plugins
4. initPlugins()              — scan plugins directory
5. initRepoConfigs()          — build repo configs from plugins
6. initPluginAgentConfigs()   — build plugin agent configs
7. cloneRepos(reposToClone)   — clone source repos declared by plugins
8. configureGitIdentity()     — set git user on each base repo
9. Log team info (same as today)
10. startServer()
11. recoverActiveTasks()
```

New imports to add:
```typescript
import { bootstrapWorkdir, cloneRepos } from './system/workdir.js';
import { initPlugins } from './system/plugin-loader.js';
import { initRepoConfigs } from './agents/repo-configs.js';
import { initPluginAgentConfigs } from './agents/plugin-configs.js';
```

### 7. Update Docker files

**`Dockerfile.dev` line 36:**
- `mkdir -p /app/sessions /app/repos /app/secrets` → `mkdir -p /workdir /app/secrets`

**`Dockerfile.prod` line 40:**
- `mkdir -p /app/sessions /app/repos /app/secrets` → `mkdir -p /workdir /app/secrets`

**`docker-compose.yml`:**
- Environment: replace `ARCHIE_REPOS_DIR=/app/repos` with `ARCHIE_WORKDIR=/workdir` and `ARCHIE_PLUGINS=https://github.com/sweatco/archie-plugins.git`
- Volumes: replace 3 separate mounts (`./plugins:/app/plugins`, `./sessions:/app/sessions`, `./repos:/app/repos`) with single `./workdir:/workdir`

**`docker-compose.dev.yml`:**
- Remove `./plugins:/app/plugins` volume
- Optionally add `./workdir:/workdir` override or rely on base compose
- For local plugin dev, unset `ARCHIE_PLUGINS` env var and mount plugins directly into workdir

**`docker-compose.prod.yml`:**
- Update comment about inherited volumes

### 8. Update `.env.example`

Replace:
```
ARCHIE_REPOS_DIR=/path/to/repos
# ARCHIE_PLUGINS_DIR=plugins
```
With:
```
ARCHIE_WORKDIR=./workdir
# ARCHIE_PLUGINS=https://github.com/sweatco/archie-plugins.git
```

### 9. Update documentation

- `docs/guides/local-development.md` — new setup: set `ARCHIE_PLUGINS` in `.env`, everything auto-clones on `npm run dev`. Mention manual clone as alternative for plugin development only.
- `docs/guides/deployment.md` — new volume mount, new env vars
- `docs/architecture/plugin-system.md` — updated env var references
- `CLAUDE.md` — mention `ARCHIE_WORKDIR`

---

## Files Modified

| File | Type | Key Change |
|------|------|------------|
| `src/system/workdir.ts` | NEW | Path constants + bootstrap + clone helpers |
| `src/system/plugin-loader.ts` | EDIT | Explicit init, import PLUGINS_DIR from workdir |
| `src/agents/repo-configs.ts` | EDIT | Explicit init, import REPOS_DIR from workdir |
| `src/agents/plugin-configs.ts` | EDIT | Explicit init |
| `src/system/task-manager.ts` | EDIT | Import SESSIONS_DIR from workdir |
| `src/index.ts` | EDIT | Async bootstrap sequence |
| `Dockerfile.dev` | EDIT | mkdir /workdir |
| `Dockerfile.prod` | EDIT | mkdir /workdir |
| `docker-compose.yml` | EDIT | Single workdir volume + env vars |
| `docker-compose.dev.yml` | EDIT | Remove plugins mount |
| `docker-compose.prod.yml` | EDIT | Update comment |
| `.env.example` | EDIT | New env vars |
| `docs/guides/local-development.md` | EDIT | New setup instructions |
| `docs/guides/deployment.md` | EDIT | New paths |
| `docs/architecture/plugin-system.md` | EDIT | Updated env var references |

---

## Verification

1. **Typecheck**: `npm run typecheck` — all imports resolve, no type errors
2. **Local startup test**:
   - Set `ARCHIE_WORKDIR=./workdir` and `ARCHIE_PLUGINS=<git-url>` in `.env`
   - Run `npm run dev` — plugins and repos should auto-clone, server should start
3. **Docker build**: `docker compose build` succeeds
4. **Full flow**: Create a test task via Slack → PM spawns → repo agent gets correct repo path
5. **Session paths**: Verify sessions create under `./workdir/sessions/`
6. **Existing sessions**: Verify task recovery finds sessions in new location
