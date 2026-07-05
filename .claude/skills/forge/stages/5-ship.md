# Stage 5 — Ship

**Purpose:** open (or update) the PR with the verification manifest, get it green, and hand the merge decision to the user.

## Procedure

1. **Assemble the PR body** per the repo's `.github/PULL_REQUEST_TEMPLATE.md` (What & why / How it works / Verification / Deployment & follow-ups). The Verification section is the **manifest**: a table of every AC — id, criterion, method, status (`verified`/`waived`, per `forge.yaml`), and evidence (link into `qa-evidence/` on the branch, test case name, or the named post-merge step for waivers). Candor over polish: a waiver stated plainly beats an implied pass. Link the change dir (`openspec/changes/<change>/`) as the plan artifact.
2. **Push and open the PR** (or update the existing one in `pr` mode) as ready for review. Record the number in `forge.yaml`.
3. **Watch CI.** On failure: diagnose, fix on the branch, push — re-running the Stage 3 reviewers only if the fix is more than mechanical. On persistent unrelated-looking failure, report to the user rather than force-fixing someone else's breakage.
4. **Address review feedback.** Reviewer comments route like QA failures: trivial → fix directly; substantive → back through Stage 3's reviewers; scope-changing → back to the user. If a human pushes fixes to the branch directly, treat their diff as ground truth — never revert it; reconcile the plan artifacts to match.
5. **Merge gate (human).** Never merge without the user's explicit go — per-repo policy may add stricter rules (multiple approvals, manual rollout), which always win. When asking, include the verification manifest (the per-AC status table) in the chat message itself, plus the PR link — the user decides from the message, not from the PR tab.
6. **Archive, then merge.** On the user's go, push one final `forge(<change>): archive` commit to the PR branch: archive the OpenSpec change (fold spec deltas into `openspec/specs/`; `openspec archive` when the CLI exists, else move the dir to `openspec/changes/archive/<date>-<change>/`) and set `stage: done` in the archived `forge.yaml`. Wait for CI, then merge. This lands the code and its spec on the base branch atomically — no follow-up archive PR — and is safe precisely because review is already over and only one run exists at a time. If review reopens after the go (rare), revert the archive commit before continuing.

## Post-merge

- File follow-up issues for every waived AC that has a real post-merge step, so waivers don't evaporate.
