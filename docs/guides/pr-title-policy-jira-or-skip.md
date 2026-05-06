# Enabling Jira / `[Skip]` PR title normalization (`jira-or-skip`)

After the **archie-hq** change that adds `prTitlePolicy` is merged and deployed, normalization runs only for repo agents that opt in via plugin frontmatter. Nothing else in this repository is required for activation.

## What it does

For agents with `prTitlePolicy: jira-or-skip`:

- `create_pull_request` and `update_pr` normalize titles to **`[PROJ-123] …`** or **`[Skip] …`**.
- If the model omits a prefix, **`[Skip]`** is prepended automatically so the PR still opens.
- Repos without this policy are unchanged.

## Step 1: Deploy archie-hq

Ship the revision that includes `prTitlePolicy` support (build, release, restart workers or whichever processes run Archie). Use your normal deployment path (see [deployment.md](./deployment.md) if applicable).

Until this code is live, frontmatter changes in plugins have no effect.

## Step 2: Edit the plugins repository

Plugins are loaded from the git URL in **`ARCHIE_PLUGINS`** (see [plugin system](../architecture/plugin-system.md)). You must change the **engineering** (or equivalent) plugin checkout that defines your **mobile** repo agent.

### Find the correct file

Locate the **repo agent** markdown whose frontmatter already binds the mobile GitHub repository, for example:

- Path pattern: `agents/<key>.md` (e.g. `agents/mobile.md`)
- It must contain `metadata.archie.repo.github` pointing at the mobile app repo (e.g. `sweatco/sweatcoin-mobile`).

Do **not** add this to PM or plugin-only agents; only repo agents have `metadata.archie.repo` with `github`.

### Add the policy

Under **`metadata.archie.repo`**, add **`prTitlePolicy: jira-or-skip`** alongside existing keys:

```yaml
metadata:
  archie:
    repo:
      github: sweatco/sweatcoin-mobile   # use your real org/repo
      baseBranch: main                   # optional; keep if already present
      prTitlePolicy: jira-or-skip        # add this
```

Indentation: `prTitlePolicy` must be a sibling of `github` (and `baseBranch` if present), not nested under `github`.

Commit and push to the branch your runtime uses (often the default branch configured with `ARCHIE_PLUGINS_BRANCH`, if set).

## Step 3: Pick up the new plugin revision

Depending on your setup:

- **Production:** restart Archie or wait for the plugin refresh / next boot so `bootstrapWorkdir()` fetches the latest plugin commit; or redeploy so a fresh pull runs.
- **Local dev:** ensure `$ARCHIE_WORKDIR/plugins/…` reflects your push (pull, symlink refresh, or clean workdir as you usually do).

If plugins are a **symlink** to a local clone, update that clone and restart the app.

## Verification

1. Start a task that uses the mobile repo agent in **edit mode** and create a PR with a title **without** a prefix (e.g. `Fix typo`).
2. Confirm the GitHub PR title is **`[Skip] Fix typo`** (or similar).
3. Create another PR with an explicit Jira-style title (e.g. `[SWEAT-123] Fix typo`) and confirm it is unchanged (aside from trim/spacing normalization if applicable).
4. Check logs for lines like `PR title normalized (jira-or-skip): …` when adjustment happens.

## Troubleshooting

| Symptom | Likely cause |
|--------|----------------|
| No normalization | `prTitlePolicy` missing or wrong indent in frontmatter; or old archie-hq binary still running |
| Wrong repo affected | Policy added to the wrong `agents/*.md` file (not the mobile repo agent) |
| Plugins not updating | Branch mismatch, refresh cooldown, or symlinked plugins not pulled |

## Rollback

- Remove **`prTitlePolicy`** from the agent frontmatter and redeploy plugins; behavior returns to plain titles for that agent only.
- Reverting the archie-hq merge removes the feature globally; then frontmatter keys are ignored.
