export const meta = {
  name: 'forge-review',
  description: 'Forge v2 zero-footprint PR review + QA: derive intent and ACs from the PR itself, run blind review and QA rings in an isolated worktree, return a findings report. Never commits, pushes, or posts to GitHub.',
  whenToUse: 'Invoked by the /forge conductor for `/forge review <n>`. The conductor renders the report in chat and submits a GitHub review only on the operator\'s explicit approval.',
  phases: [
    { title: 'Ground', detail: 'worktree setup; PR-context / diff-mapper / drift lenses, fact-checked' },
    { title: 'Derive', detail: 'intent + numbered ACs from the PR, assumptions flagged' },
    { title: 'Review', detail: 'claims-vs-diff reviewer ∥ adversarial bug hunter (skipped in qa-only)' },
    { title: 'QA', detail: 'blind per-AC verification, evidence audited' },
  ],
}

// args: { pr?: number  — review a PR; OR branch: true  — review the current checkout's working
//         tree AS-IS (uncommitted and untracked changes included, snapshot-copied into the
//         isolated worktree; diffed against `base`, default main; `intent` optionally carries
//         the operator's stated intended behavior, which overrides inference),
//         base?: string, intent?: string, qaOnly?: boolean, scratchDir: string,
//         corrections?: string  — operator's corrected assumptions/ACs from a previous round,
//         sinceSha?: string, previousFindings?: array  — follow-up round: focus the delta and
//         rule each previous finding fixed / unaddressed / regressed (follow-up rounds always
//         run the full review ring — the rulings channel lives there, so qaOnly is ignored;
//         in branch mode the previous round's uncommitted state is unreconstructable, so the
//         delta focus degrades to a full re-review — broader, never narrower) }
// Contract: this workflow never impasses. Degradable failures (a dead lens, unavailable QA
// infra, a skipped ring) surface as entries in the returned `gaps`; the two unrecoverable
// failures (no worktree, no derivable ACs) return { status: 'error' } — but only after the
// worktree teardown has run. Iteration happens by relaunching with corrections; it is cheap
// because nothing is stateful. Nothing is ever committed, pushed, or posted.
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
if ((!input.pr && !input.branch) || !input.scratchDir) return { status: 'error', reason: 'missing input.pr (or input.branch) or input.scratchDir' }
const isPr = !!input.pr
const subject = isPr ? `PR #${input.pr}` : 'the current local branch'
const scratch = input.scratchDir
const qaOnly = !!input.qaOnly && !input.sinceSha
// Follow-up rounds carry two separable instructions: delta focus goes to every re-reviewing
// agent; the rulings ask goes ONLY to the claims reviewer (one ruling stream, not two).
const deltaFocus = input.sinceSha ? `\nFOLLOW-UP ROUND: focus on what changed since commit ${input.sinceSha}.` : ''
const rulingsAsk = input.sinceSha ? `\nAdditionally rule on each previously reported finding — fixed / unaddressed / regressed — in the previousFindingRulings field:\n${JSON.stringify(input.previousFindings || [], null, 2)}` : ''

// Deterministic paths, fixed BEFORE setup, so teardown can always target them.
const wt = `${scratch}/${isPr ? `pr-${input.pr}` : 'local-review'}`
const mutWt = `${wt}-mutation`
const GH_READONLY = 'You are strictly read-only on GitHub: never comment, review, approve, or modify anything there.'
const teardown = () => agent(
  `Best-effort cleanup, from the MAIN checkout of this repo: if a docker compose project is running from ${wt}, run docker compose down there first; then git worktree remove --force ${wt}, remove ${mutWt} (git worktree remove --force if it is a worktree, else rm -rf), and git worktree prune (each may not exist — ignore those errors). Touch nothing else; commit and push nothing.`,
  { label: 'teardown', phase: 'QA', effort: 'low', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }
)

const CLAIMS = {
  type: 'object',
  properties: {
    claims: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, citation: { type: 'string', description: 'file:line, PR/issue URL, or commit SHA' } }, required: ['claim', 'citation'] } },
    summary: { type: 'string' },
  },
  required: ['claims', 'summary'],
}
const CHECKED = {
  type: 'object',
  properties: { verdicts: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, citation: { type: 'string' }, verdict: { type: 'string', enum: ['CONFIRMED', 'WRONG', 'UNVERIFIABLE'] }, correction: { type: 'string' } }, required: ['claim', 'citation', 'verdict'] } } },
  required: ['verdicts'],
}

phase('Ground')
const setupPrompt = isPr
  ? `Prepare an isolated checkout of PR #${input.pr} of this repo at exactly ${wt}. Use the GitHub MCP tools (via ToolSearch) or gh CLI to find the PR's head SHA and base branch. Then: git fetch origin pull/${input.pr}/head, git worktree add ${wt} FETCH_HEAD, and VERIFY git -C ${wt} rev-parse HEAD matches the API's head SHA (another process may move FETCH_HEAD between commands) — on mismatch, re-fetch and re-create the worktree once. If the repo has gitignored local state needed to boot (.env, secrets/), copy it from the main checkout into the worktree. Do NOT commit, push, or create branches. ${GH_READONLY} Report the verified head SHA, base branch, and whether boot prerequisites (.env, docker) are present.`
  : `Prepare an isolated snapshot of this repo's CURRENT state — the code exactly as it sits, uncommitted and untracked changes included — at exactly ${wt}. In the main checkout: note the branch name and HEAD SHA, git worktree add ${wt} <that SHA> (detached), then overlay the dirty state: for every path in git status --porcelain, copy it from the checkout into ${wt} (paths deleted in the checkout: delete in ${wt} too; rename entries "R old -> new": copy the new path, delete the old), and run git -C ${wt} add -A --intent-to-add so new files show up in git diff. The operator's checkout is copied FROM only — never touch it. The base branch is ${input.base || 'main'} (fetch it: git fetch origin ${input.base || 'main'}). If the repo has gitignored local state needed to boot (.env, secrets/), copy it in too. Do NOT commit, push, or create branches. Report the head SHA, the base branch, whether boot prerequisites (.env, docker) are present, and in notes how many uncommitted/untracked files the snapshot includes.`
const setup = await agent(
  setupPrompt,
  { label: 'worktree-setup', phase: 'Ground', effort: 'low', schema: { type: 'object', properties: { ok: { type: 'boolean' }, headSha: { type: 'string' }, base: { type: 'string' }, bootReady: { type: 'boolean' }, notes: { type: 'string' } }, required: ['ok', 'headSha', 'base', 'bootReady'] } }
)
if (!setup || !setup.ok) {
  await teardown()
  return { status: 'error', reason: `could not prepare a worktree for ${subject}: ${setup ? setup.notes : 'setup agent failed'}` }
}
// PR mode diffs committed history; branch mode diffs the working tree (so uncommitted work,
// overlaid by setup, is part of the reviewed diff).
const diffCmd = isPr ? `git -C ${wt} diff origin/${setup.base}...HEAD` : `git -C ${wt} diff $(git -C ${wt} merge-base origin/${setup.base} HEAD)`

const CONTRACT = 'Return findings as factual claims, each with a citation. Do not speculate; a claim you cannot cite is not a finding.'
const lenses = [
  isPr
    ? { key: 'pr-context', prompt: `You gather the stated intent of PR #${input.pr} in this repo. Read (GitHub MCP via ToolSearch, or gh CLI): the PR description, linked issues, review comment threads, and commit messages. ${GH_READONLY} Report as claims: what the PR says it does, what it admits it could not verify, what reviewers have raised, and what remains unresolved. ${CONTRACT}` }
    : { key: 'change-context', prompt: `You gather the stated intent of the local change in the worktree ${wt}. Read the commit messages on this branch (git -C ${wt} log origin/${setup.base}..HEAD).${input.intent ? ` The operator states the intended behavior — treat it as the primary source: <intent>${input.intent}</intent>` : ''} Report as claims: what the change says it does, per the commits${input.intent ? ' and the stated intent' : ''}, and anything the messages admit is unfinished or unverified. ${CONTRACT}` },
  { key: 'diff-mapper', prompt: `You map what a diff ACTUALLY does, function by function. Work read-only in ${wt}; the diff: ${diffCmd}. Report as claims: each behavioral change the diff makes, where it diverges from or exceeds what ${isPr ? 'a reader of the PR title alone would expect' : 'the commit messages claim'}, new tests and what they assert, and anything unfinished (TODOs, dead code, unreferenced additions). ${CONTRACT}${deltaFocus}` },
  { key: 'drift-check', prompt: `You check base-branch drift for ${subject}. Work read-only in ${wt}: what has landed on ${setup.base} since this branch diverged (git log/diff against the merge-base) that touches the same files or subsystems? Report as claims: likely conflicts, invalidated assumptions, or duplicated work. ${CONTRACT}` },
]
const checked = await pipeline(
  lenses,
  (lens) => agent(lens.prompt, { label: `lens:${lens.key}`, phase: 'Ground', schema: CLAIMS }),
  (found, lens) => {
    if (!found || !found.claims || found.claims.length === 0) return { lens: lens.key, verdicts: [], summary: found ? found.summary : null, lensFailed: !found, verifierFailed: false }
    return agent(
      `You are an adversarial fact-checker with read-only access to the repo (worktree: ${wt})${isPr ? ' and the PR (GitHub MCP via ToolSearch / gh)' : ''}. ${GH_READONLY} For EACH claim below, try to REFUTE it against the actual code or source. Verdict per claim: CONFIRMED / WRONG (state what is actually there) / UNVERIFIABLE. Facts only. Claims:\n${JSON.stringify(found.claims, null, 2)}`,
      { label: `verify:${lens.key}`, phase: 'Ground', schema: CHECKED }
    ).then((v) => ({ lens: lens.key, summary: found.summary, verdicts: v ? v.verdicts : [], lensFailed: false, verifierFailed: !v }))
  }
)
const dossier = []
const gaps = []
for (const [i, lr] of checked.entries()) {
  if (!lr) { gaps.push(`lens ${lenses[i].key} failed in the pipeline — that angle is uncovered`); continue }
  if (lr.lensFailed) gaps.push(`lens ${lr.lens} returned nothing — that angle is uncovered`)
  if (lr.verifierFailed) gaps.push(`fact-checker for lens ${lr.lens} returned nothing — that lens's claims were dropped unverified`)
  for (const v of lr.verdicts || []) {
    if (v.verdict === 'CONFIRMED') dossier.push({ lens: lr.lens, claim: v.claim, citation: v.citation })
    else if (v.verdict === 'WRONG' && v.correction) dossier.push({ lens: lr.lens, claim: v.correction, citation: v.citation, note: 'correction of a refuted claim' })
  }
}
log(`Grounding: ${dossier.length} confirmed claims, ${gaps.length} gap(s)`)

phase('Derive')
const derivePrompt = `You derive the intent and acceptance criteria of ${subject} WITHOUT asking anyone. Inputs: the fact-checked dossier below. Produce: the intent (what the author is trying to achieve), every assumption you had to make (flag each — the operator corrects them later, so honesty beats confidence), and numbered ACs — each observable ("WHEN X THEN Y"), each with method unit / integration / live-e2e / manual / deploy-only. Any "couldn't verify" admissions in the dossier MUST each become an AC. ${input.intent ? `The operator's stated intended behavior is authoritative: <intent>${input.intent}</intent>. ` : ''}${input.corrections ? `Operator corrections from a previous round (these override your inferences): ${input.corrections}` : ''}\nDossier:\n${JSON.stringify(dossier, null, 2)}`
const DERIVED = { type: 'object', properties: { intent: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } }, acs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, method: { type: 'string', enum: ['unit', 'integration', 'live-e2e', 'manual', 'deploy-only'] } }, required: ['id', 'text', 'method'] } } }, required: ['intent', 'assumptions', 'acs'] }
let derived = await agent(derivePrompt, { label: 'derive-acs', phase: 'Derive', schema: DERIVED })
if (!derived) derived = await agent(derivePrompt, { label: 'derive-acs retry', phase: 'Derive', schema: DERIVED })
if (!derived) {
  await teardown()
  return { status: 'error', reason: 'could not derive intent/ACs for ${subject} after a retry — relaunch, or review manually' }
}

const REVIEW = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string', enum: ['blocking', 'non-blocking'] }, verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE'] } }, required: ['text', 'file', 'severity', 'verdict'] } },
    previousFindingRulings: { type: 'array', description: 'Follow-up rounds only: one ruling per previously reported finding', items: { type: 'object', properties: { finding: { type: 'string' }, ruling: { type: 'string', enum: ['fixed', 'unaddressed', 'regressed'] }, note: { type: 'string' } }, required: ['finding', 'ruling'] } },
  },
  required: ['findings'],
}
let reviewFindings = []
let previousFindingRulings = []
if (!qaOnly) {
  phase('Review')
  const ring = await parallel([
    () => agent(
      `You check a diff against its stated intent. Inputs: the derived intent and ACs below, and the diff (${diffCmd}); work read-only in ${wt} — never modify its files. Verify every stated claim of ${subject} is true in the diff, and flag anything the diff does BEYOND the stated intent (drive-by changes, unrequested refactors). Also flag over-engineering relative to the intent — unnecessary abstraction, unused generality, dead options — citing the simpler equivalent form. You have not seen the author's reasoning.${deltaFocus}${rulingsAsk}\nIntent: ${derived.intent}\nACs: ${JSON.stringify(derived.acs, null, 2)}`,
      { label: 'review:claims', phase: 'Review', schema: REVIEW }
    ),
    () => agent(
      `You hunt for real bugs in a diff. Inputs: the diff (${diffCmd}); treat ${wt} as read-only reference (running typecheck/tests there is allowed; never modify its files, never commit anywhere). Look for logic errors, unhandled error paths, races/lifecycle issues (spawn/stop/resume/recovery interactions are this codebase's classic failure mode), broken invariants in persisted state, and test theater. Mutation-check each NEW test in a SEPARATE disposable copy that is yours alone: ${isPr ? `git worktree add ${mutWt} ${setup.headSha}` : `copy ${wt} to ${mutWt} (excluding .git)`}, revert the guarded change there, confirm the test fails, then remove ${mutWt} when done. CONFIRMED = you can state the failing input/sequence.${deltaFocus}`,
      { label: 'review:bugs', phase: 'Review', schema: REVIEW }
    ),
  ])
  const [claims, bugs] = ring
  if (!claims) gaps.push('claims reviewer returned nothing — the claims-vs-diff angle is uncovered')
  if (!bugs) gaps.push('bug hunter returned nothing — the bug-hunt angle is uncovered')
  reviewFindings = [...(claims ? claims.findings : []), ...(bugs ? bugs.findings : [])]
  previousFindingRulings = (claims && claims.previousFindingRulings) || []
} else {
  gaps.push('code-review ring skipped (qa-only) — no bug hunt or claims-vs-diff check was performed')
}

phase('QA')
// The runner wipes the evidence dir before recording — that wipe is the freshness guarantee
// (the SHA suffix helps in PR mode but repeats across branch-mode rounds with uncommitted fixes).
const evDir = `${scratch}/evidence-${setup.headSha}`
let qaManifest = []
const runner = await agent(
  `You are a black-box QA engineer verifying acceptance criteria for a code change. You have NOT seen the implementation and MUST NOT read the implementation diff or non-test source changes — judge the running system and the test suite only (test files are your domain). Work in the worktree ${wt}; boot prerequisites present: ${setup.bootReady} (${setup.notes || ''}). First delete any existing contents of ${evDir}, then record fresh evidence per AC under ${evDir}/<AC-id>/. For live-e2e ACs: if boot prerequisites allow, load the archie-e2e skill and boot from the worktree, drive the scenario via the archie-debug MCP, tear the instance down after; otherwise mark BLOCKED with the reason. For unit/integration ACs: run the suite in the worktree; if a named test case demonstrably covers the AC, record VERIFIED with the test file + case name as the evidence; otherwise execute the check yourself. manual/deploy-only: BLOCKED with the named step. Report per-AC: VERIFIED / FAILED (replayable repro) / BLOCKED. Never claim VERIFIED without evidence you recorded. NEVER commit or push anything.\nACs:\n${JSON.stringify(derived.acs, null, 2)}`,
  { label: 'qa-runner', phase: 'QA', schema: { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { ac: { type: 'string' }, status: { type: 'string', enum: ['VERIFIED', 'FAILED', 'BLOCKED'] }, evidence: { type: 'string' }, repro: { type: 'string' } }, required: ['ac', 'status', 'evidence'] } } }, required: ['results'] } }
)
if (!runner) {
  gaps.push('QA runner returned nothing — no AC was machine-verified')
  qaManifest = derived.acs.map((ac) => ({ ac: ac.id, text: ac.text, method: ac.method, status: 'unverified', evidence: 'QA runner failed' }))
} else {
  const audit = await agent(
    `You audit QA evidence. Inputs: the ACs, the runner's claimed results, and the evidence directory ${evDir} (read it yourself). Judge whether the evidence actually demonstrates each criterion. Rule each: VERIFIED / UNCONVINCING / WAIVED-OK (a BLOCKED with a credible named step).\nACs:\n${JSON.stringify(derived.acs, null, 2)}\nRunner results:\n${JSON.stringify(runner.results, null, 2)}`,
    { label: 'qa-audit', phase: 'QA', schema: { type: 'object', properties: { rulings: { type: 'array', items: { type: 'object', properties: { ac: { type: 'string' }, ruling: { type: 'string', enum: ['VERIFIED', 'UNCONVINCING', 'WAIVED-OK'] }, note: { type: 'string' } }, required: ['ac', 'ruling'] } } }, required: ['rulings'] } }
  )
  if (!audit) gaps.push('QA audit returned nothing — runner results below are UNAUDITED')
  // Status vocabulary (mirrors forge-qa): failed | verified | verified-unaudited |
  // waived (BLOCKED with a credible named step) | unverified (BLOCKED without one).
  for (const ac of derived.acs) {
    const r = (runner.results || []).find((x) => x.ac === ac.id) || { status: 'BLOCKED', evidence: 'runner returned no result for this AC' }
    const ruling = audit ? ((audit.rulings.find((x) => x.ac === ac.id) || {}).ruling || 'UNCONVINCING') : 'UNAUDITED'
    let status
    if (r.status === 'FAILED' || ruling === 'UNCONVINCING') status = 'failed'
    else if (r.status === 'BLOCKED') status = ruling === 'WAIVED-OK' ? 'waived' : 'unverified'
    else status = ruling === 'UNAUDITED' ? 'verified-unaudited' : 'verified'
    qaManifest.push({ ac: ac.id, text: ac.text, method: ac.method, status, evidence: r.evidence, repro: r.repro, note: audit ? (audit.rulings.find((x) => x.ac === ac.id) || {}).note : undefined })
  }
}

await teardown()

const confirmedBlocking = reviewFindings.filter((f) => f.severity === 'blocking' && f.verdict === 'CONFIRMED').length
const failedAcs = qaManifest.filter((m) => m.status === 'failed').length
const unresolvedAcs = qaManifest.filter((m) => m.status === 'unverified' || m.status === 'verified-unaudited').length
const recommendation = confirmedBlocking > 0 || failedAcs > 0
  ? 'request-changes'
  : (reviewFindings.some((f) => f.severity === 'blocking') || unresolvedAcs > 0 || gaps.length > 0 ? 'needs-discussion' : 'approve')
return { status: 'ok', mode: isPr ? 'pr' : 'branch', pr: input.pr || null, headSha: setup.headSha, setupNotes: setup.notes, intent: derived.intent, assumptions: derived.assumptions, acs: derived.acs, reviewFindings, previousFindingRulings, qaManifest, gaps, recommendation }
