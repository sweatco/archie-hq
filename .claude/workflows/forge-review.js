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

// args: { pr: number, qaOnly?: boolean, scratchDir: string,
//         corrections?: string  — operator's corrected assumptions/ACs from a previous round,
//         sinceSha?: string, previousFindings?: array  — follow-up round: focus the delta and
//         re-check each previous finding (fixed / unaddressed / regressed) }
// This workflow NEVER impasses — it degrades honestly (a dead lens or unavailable QA becomes a
// flagged gap in the report) and always returns the report. Iteration happens by relaunching
// with corrections; it is cheap because nothing is stateful.
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!input.pr || !input.scratchDir) return { status: 'error', reason: 'missing input.pr or input.scratchDir' }
const scratch = input.scratchDir
const followUp = input.sinceSha ? `\nFOLLOW-UP ROUND: review only what changed since commit ${input.sinceSha}; additionally rule on each previously reported finding — fixed / unaddressed / regressed:\n${JSON.stringify(input.previousFindings || [], null, 2)}` : ''

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
// Zero-footprint isolation: an ephemeral worktree under the scratch dir. Fetching a PR head and
// adding a worktree writes nothing to any branch and never touches the operator's checkout.
const setup = await agent(
  `Prepare an isolated read-only checkout of PR #${input.pr} of this repo. Use the GitHub MCP tools (via ToolSearch) or gh CLI to find the PR's head ref and base branch. Then: git fetch origin pull/${input.pr}/head, git worktree add ${scratch}/pr-${input.pr} FETCH_HEAD. If the repo has gitignored local state needed to boot (.env, secrets/), copy it from the main checkout into the worktree. Do NOT commit, push, or create branches. Report the worktree path, head SHA, base branch, and whether boot prerequisites (.env, docker) are present.`,
  { label: 'worktree-setup', phase: 'Ground', effort: 'low', schema: { type: 'object', properties: { ok: { type: 'boolean' }, worktree: { type: 'string' }, headSha: { type: 'string' }, base: { type: 'string' }, bootReady: { type: 'boolean' }, notes: { type: 'string' } }, required: ['ok', 'worktree', 'headSha', 'base', 'bootReady'] } }
)
if (!setup || !setup.ok) return { status: 'error', reason: `could not prepare a worktree for PR #${input.pr}: ${setup ? setup.notes : 'setup agent failed'}` }
const wt = setup.worktree
const diffCmd = `git -C ${wt} diff ${setup.base === 'main' ? 'origin/main' : `origin/${setup.base}`}...HEAD`

const CONTRACT = 'Return findings as factual claims, each with a citation. Do not speculate; a claim you cannot cite is not a finding.'
const lenses = [
  { key: 'pr-context', prompt: `You gather the stated intent of PR #${input.pr} in this repo. Read (GitHub MCP via ToolSearch, or gh CLI): the PR description, linked issues, review comment threads, and commit messages. Report as claims: what the PR says it does, what it admits it could not verify, what reviewers have raised, and what remains unresolved. ${CONTRACT}` },
  { key: 'diff-mapper', prompt: `You map what a diff ACTUALLY does, function by function. Work in ${wt}; the diff: ${diffCmd}. Report as claims: each behavioral change the diff makes, where it diverges from or exceeds what a reader of the PR title alone would expect, new tests and what they assert, and anything unfinished (TODOs, dead code, unreferenced additions). ${CONTRACT}${followUp}` },
  { key: 'drift-check', prompt: `You check base-branch drift for PR #${input.pr}. Work in ${wt}: what has landed on ${setup.base} since this PR branched (git log/diff against the merge-base) that touches the same files or subsystems? Report as claims: likely conflicts, invalidated assumptions, or duplicated work. ${CONTRACT}` },
]
const checked = await pipeline(
  lenses,
  (lens) => agent(lens.prompt, { label: `lens:${lens.key}`, phase: 'Ground', schema: CLAIMS }),
  (found, lens) => {
    if (!found || !found.claims || found.claims.length === 0) return { lens: lens.key, verdicts: [], summary: found ? found.summary : 'LENS FAILED — treat this angle as uncovered', failed: !found }
    return agent(
      `You are an adversarial fact-checker with read access to the repo (worktree: ${wt}) and the PR (GitHub MCP via ToolSearch / gh). For EACH claim below, try to REFUTE it against the actual code or source. Verdict per claim: CONFIRMED / WRONG (state what is actually there) / UNVERIFIABLE. Facts only. Claims:\n${JSON.stringify(found.claims, null, 2)}`,
      { label: `verify:${lens.key}`, phase: 'Ground', schema: CHECKED }
    ).then((v) => ({ lens: lens.key, summary: found.summary, verdicts: v ? v.verdicts : found.claims.map((c) => ({ ...c, verdict: 'UNVERIFIABLE' })), failed: false }))
  }
)
const dossier = []
const gaps = []
for (const lr of checked.filter(Boolean)) {
  if (lr.failed) gaps.push(`lens ${lr.lens} returned nothing — that angle is uncovered`)
  for (const v of lr.verdicts || []) {
    if (v.verdict === 'CONFIRMED') dossier.push({ lens: lr.lens, claim: v.claim, citation: v.citation })
    else if (v.verdict === 'WRONG' && v.correction) dossier.push({ lens: lr.lens, claim: v.correction, citation: v.citation, note: 'correction of a refuted claim' })
  }
}
log(`Grounding: ${dossier.length} confirmed claims, ${gaps.length} gap(s)`)

phase('Derive')
const derived = await agent(
  `You derive the intent and acceptance criteria of PR #${input.pr} WITHOUT asking anyone. Inputs: the fact-checked dossier below. Produce: the intent (what the author is trying to achieve), every assumption you had to make (flag each — the operator corrects them later, so honesty beats confidence), and numbered ACs — each observable ("WHEN X THEN Y"), each with method unit / integration / live-e2e / manual / deploy-only. The PR's own "couldn't verify" admissions MUST each become an AC. ${input.corrections ? `Operator corrections from a previous round (these override your inferences): ${input.corrections}` : ''}\nDossier:\n${JSON.stringify(dossier, null, 2)}`,
  { label: 'derive-acs', phase: 'Derive', schema: { type: 'object', properties: { intent: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } }, acs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, method: { type: 'string', enum: ['unit', 'integration', 'live-e2e', 'manual', 'deploy-only'] } }, required: ['id', 'text', 'method'] } } }, required: ['intent', 'assumptions', 'acs'] } }
)
if (!derived) return { status: 'error', reason: 'could not derive intent/ACs from the PR — relaunch, or review manually' }

const REVIEW = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, findings: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string', enum: ['blocking', 'non-blocking'] }, verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE'] } }, required: ['text', 'file', 'severity', 'verdict'] } } },
  required: ['pass', 'findings'],
}
let reviewFindings = []
if (!input.qaOnly) {
  phase('Review')
  const ring = await parallel([
    () => agent(
      `You check a diff against its stated intent. Inputs: the derived intent and ACs below, and the diff (${diffCmd}); work read-only in ${wt}. Verify every claim the PR makes is true in the diff, and flag anything the diff does BEYOND the stated intent (drive-by changes, unrequested refactors). You have not seen the author's reasoning.${followUp}\nIntent: ${derived.intent}\nACs: ${JSON.stringify(derived.acs, null, 2)}`,
      { label: 'review:claims', phase: 'Review', schema: REVIEW }
    ),
    () => agent(
      `You hunt for real bugs in a diff. Inputs: the diff (${diffCmd}); work read-only in ${wt} (running typecheck/tests there is allowed; never commit). Look for logic errors, unhandled error paths, races/lifecycle issues (spawn/stop/resume/recovery interactions are this codebase's classic failure mode), broken invariants in persisted state, and test theater. Mutation-check each NEW test: revert the guarded change in the worktree, confirm the test fails, restore. CONFIRMED = you can state the failing input/sequence.${followUp}`,
      { label: 'review:bugs', phase: 'Review', schema: REVIEW }
    ),
  ])
  const [claims, bugs] = ring
  if (!claims) gaps.push('claims reviewer returned nothing — the claims-vs-diff angle is uncovered')
  if (!bugs) gaps.push('bug hunter returned nothing — the bug-hunt angle is uncovered')
  reviewFindings = [...(claims ? claims.findings : []), ...(bugs ? bugs.findings : [])]
}

phase('QA')
let qaManifest = []
const runner = await agent(
  `You are a black-box QA engineer verifying acceptance criteria for a PR. You have NOT seen the implementation and MUST NOT read the implementation diff or non-test source changes — judge the running system and the test suite only (test files are your domain). Work in the worktree ${wt}; boot prerequisites present: ${setup.bootReady} (${setup.notes || ''}). For live-e2e ACs: if boot prerequisites allow, load the archie-e2e skill and boot from the worktree, drive the scenario via the archie-debug MCP, tear the instance down after; otherwise mark BLOCKED with the reason. For unit/integration ACs: run the suite in the worktree; name the covering test case or execute the check yourself. manual/deploy-only: BLOCKED with the named step. Record evidence per AC under ${scratch}/evidence/<AC-id>/. Report per-AC: VERIFIED / FAILED (replayable repro) / BLOCKED / SUITE. Never claim VERIFIED without evidence you recorded. NEVER commit or push anything.\nACs:\n${JSON.stringify(derived.acs, null, 2)}`,
  { label: 'qa-runner', phase: 'QA', schema: { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { ac: { type: 'string' }, status: { type: 'string', enum: ['VERIFIED', 'FAILED', 'BLOCKED', 'SUITE'] }, evidence: { type: 'string' }, repro: { type: 'string' } }, required: ['ac', 'status', 'evidence'] } } }, required: ['results'] } }
)
if (!runner) {
  gaps.push('QA runner returned nothing — no AC was machine-verified')
  qaManifest = derived.acs.map((ac) => ({ ac: ac.id, text: ac.text, method: ac.method, status: 'unverified', evidence: 'QA runner failed' }))
} else {
  const audit = await agent(
    `You audit QA evidence. Inputs: the ACs, the runner's claimed results, and the evidence directory ${scratch}/evidence (read it yourself). Judge whether the evidence actually demonstrates each criterion. Rule each: VERIFIED / UNCONVINCING / WAIVED-OK (a BLOCKED with a credible named step).\nACs:\n${JSON.stringify(derived.acs, null, 2)}\nRunner results:\n${JSON.stringify(runner.results, null, 2)}`,
    { label: 'qa-audit', phase: 'QA', schema: { type: 'object', properties: { rulings: { type: 'array', items: { type: 'object', properties: { ac: { type: 'string' }, ruling: { type: 'string', enum: ['VERIFIED', 'UNCONVINCING', 'WAIVED-OK'] }, note: { type: 'string' } }, required: ['ac', 'ruling'] } } }, required: ['rulings'] } }
  )
  if (!audit) gaps.push('QA audit returned nothing — runner results are UNAUDITED below')
  for (const ac of derived.acs) {
    const r = (runner.results || []).find((x) => x.ac === ac.id) || { status: 'BLOCKED', evidence: 'runner returned no result for this AC' }
    const ruling = audit ? ((audit.rulings.find((x) => x.ac === ac.id) || {}).ruling || 'UNCONVINCING') : 'UNAUDITED'
    let status
    if ((r.status === 'VERIFIED' || r.status === 'SUITE') && (ruling === 'VERIFIED' || ruling === 'UNAUDITED')) status = ruling === 'UNAUDITED' ? 'verified-unaudited' : 'verified'
    else if (r.status === 'BLOCKED') status = 'unverified'
    else status = 'failed'
    qaManifest.push({ ac: ac.id, text: ac.text, method: ac.method, status, evidence: r.evidence, repro: r.repro, note: audit ? (audit.rulings.find((x) => x.ac === ac.id) || {}).note : undefined })
  }
}

// Cleanup is best-effort and must not affect the report.
await agent(`Remove the review worktree: git worktree remove --force ${wt} (from the main checkout), and confirm no docker compose project from ${wt} is still running (docker compose down there first if so). Do not touch anything else.`, { label: 'teardown', phase: 'QA', effort: 'low', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })

const confirmedBlocking = reviewFindings.filter((f) => f.severity === 'blocking' && f.verdict === 'CONFIRMED').length
const failedAcs = qaManifest.filter((m) => m.status === 'failed').length
const recommendation = confirmedBlocking > 0 || failedAcs > 0 ? 'request-changes' : (reviewFindings.some((f) => f.severity === 'blocking') || gaps.length > 0 ? 'needs-discussion' : 'approve')
return { status: 'ok', pr: input.pr, headSha: setup.headSha, intent: derived.intent, assumptions: derived.assumptions, acs: derived.acs, reviewFindings, qaManifest, gaps, recommendation }
