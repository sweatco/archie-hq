export const meta = {
  name: 'forge-implement',
  description: 'Forge v2 implement: branch setup, sequential task execution with per-task commits, full gate, then blind spec-compliance + adversarial bug-hunt review loop',
  whenToUse: 'Invoked by forge-run after planning, and again (fix mode) when QA routes failures back. Not normally launched directly.',
  phases: [
    { title: 'Setup', detail: 'feature branch from base (fresh) or continue' },
    { title: 'Tasks', detail: 'one fresh agent per task, commit each' },
    { title: 'Gate', detail: 'typecheck, build, full test suite' },
    { title: 'Review', detail: 'spec compliance ∥ bug hunt, cap 3 rounds' },
  ],
}

// args: { change, branch, base, brief, acs, plan: {design, tasks}, fresh: boolean,
//         fixes?: [{ac, problem, scenario}], guidance?: { [taskOrFixId]: string, gate?, review? } }
// guidance carries operator answers to previous impasses, keyed by the failing unit. A failed
// call replays its failure from cache on resume, so each impasse site retries once with a
// guidance-augmented prompt (a cache miss) while everything that succeeded stays cached.
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!input.branch || !input.base || !input.plan) return { status: 'error', reason: 'missing input.branch/base/plan' }
const guideFor = (key) => {
  const g = input.guidance
  const t = g ? (typeof g === 'string' ? g : g[key]) : null
  return t ? `\nOperator guidance from a previous impasse: ${t}` : ''
}

const DONE = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    commit: { type: 'string', description: 'Commit SHA, or "skipped" if the branch already contained the change' },
    notes: { type: 'string' },
  },
  required: ['done', 'notes'],
}

const GATE = {
  type: 'object',
  properties: {
    green: { type: 'boolean' },
    summary: { type: 'string', description: 'Test counts and any failures verbatim' },
  },
  required: ['green', 'summary'],
}

const REVIEW = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          blocking: { type: 'boolean' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE'], description: 'CONFIRMED = you can state the failing input/sequence' },
        },
        required: ['text', 'file', 'blocking'],
      },
    },
  },
  required: ['pass', 'findings'],
}

phase('Setup')
const setup = await agent(
  input.fresh
    ? `Set up a fresh feature branch in this repo: git fetch origin ${input.base}, then git checkout -B ${input.branch} origin/${input.base} (this run owns branch ${input.branch}; discarding any stale copy of it is intended). Confirm a clean working tree. Return the head SHA.`
    : `Continue work on existing branch ${input.branch} in this repo: git fetch origin ${input.base}, git checkout ${input.branch}. Do NOT reset it — it carries this run's prior commits. Confirm a clean working tree. Return the head SHA.`,
  { label: 'branch-setup', phase: 'Setup', effort: 'low', schema: { type: 'object', properties: { ok: { type: 'boolean' }, headSha: { type: 'string' } }, required: ['ok', 'headSha'] } }
)
if (!setup || !setup.ok) return { status: 'impasse', stage: 'implement', question: `Could not set up branch ${input.branch}. Working tree dirty, or base ${input.base} unreachable?`, context: setup }

const conventions = `Follow the repo's own conventions (CLAUDE.md, surrounding code style). Use the unified logger, never console.*. Never touch CHANGELOG.md. New behavior gets new tests alongside it. Commit on branch ${input.branch} with a clear conventional message; never commit to any other branch.`

// Attempt a unit of work; on failure, retry ONCE with operator guidance if any exists for it.
const attempt = async (key, prompt, label, phaseName) => {
  let r = await agent(prompt, { label, phase: phaseName, schema: DONE })
  const g = guideFor(key)
  if ((!r || !r.done) && g) r = await agent(prompt + g, { label: `${label} (guided)`, phase: phaseName, schema: DONE })
  return r
}

phase('Tasks')
if (Array.isArray(input.fixes) && input.fixes.length > 0) {
  for (const [i, fix] of input.fixes.entries()) {
    const key = fix.ac || `fix-${i + 1}`
    const r = await attempt(
      key,
      `You fix a QA-verified failure on branch ${input.branch} (already checked out). The acceptance criterion that failed: ${JSON.stringify(fix)}. The design context:\n${input.plan.design}\nDiagnose against the failing scenario, fix the code, add or strengthen a test that fails without your fix, run typecheck and the targeted tests, and commit. ${conventions}`,
      `fix:${key}`, 'Tasks'
    )
    if (!r || !r.done) return { status: 'impasse', stage: 'implement', question: `QA fix for ${key} could not be completed: ${r ? r.notes : 'agent failed'}. How should we proceed? (Your answer becomes guidance keyed "${key}".)`, context: fix }
  }
} else {
  for (const task of input.plan.tasks) {
    const r = await attempt(
      task.id,
      `You execute ONE task from an implementation plan, on branch ${input.branch} (already checked out). First check git log/diff on this branch: if this task's change is already present (a resumed run), verify it and report done with commit "skipped". Otherwise: make the change, run npm run typecheck and the targeted tests for the touched area, and commit. Task ${task.id}: ${task.title}\n${task.detail}\nTests: ${task.tests}\nDesign context:\n${input.plan.design}\n${conventions}`,
      `task:${task.id}`, 'Tasks'
    )
    if (!r || !r.done) return { status: 'impasse', stage: 'implement', question: `Task ${task.id} (${task.title}) could not be completed: ${r ? r.notes : 'agent failed'}. How should we proceed? (Your answer becomes guidance keyed "${task.id}".)`, context: task }
  }
}

phase('Gate')
const gatePrompt = `On branch ${input.branch}, run the full gate: npm run typecheck, npm run build, npm test. If something is red and the fix is mechanical (a missed import, a stale snapshot, a type error in new code), fix it, commit, and re-run. Report the final state honestly — never claim green without the passing output.`
let gate = await agent(gatePrompt, { label: 'full-gate', phase: 'Gate', schema: GATE })
if ((!gate || !gate.green) && guideFor('gate')) {
  gate = await agent(gatePrompt + guideFor('gate'), { label: 'full-gate (guided)', phase: 'Gate', schema: GATE })
}
if (!gate || !gate.green) return { status: 'impasse', stage: 'implement', question: `The full gate is red after implementation: ${gate ? gate.summary : 'gate agent failed'}. How should we proceed? (Your answer becomes guidance keyed "gate".)`, context: gate }

phase('Review')
const diffCmd = `git diff origin/${input.base}...HEAD`
const planForReview = `The brief ACs:\n${JSON.stringify(input.acs || [], null, 2)}\nThe design:\n${input.plan.design}\nThe tasks:\n${JSON.stringify(input.plan.tasks.map((t) => ({ id: t.id, title: t.title, detail: t.detail })), null, 2)}`
const reviewers = [
  {
    key: 'spec',
    prompt: `You check a diff against its plan. Inputs: the plan below and the diff (run: ${diffCmd}). You have NOT seen the implementer's reasoning and must judge only what is in the diff. Verify: every task's change is actually present; every code-level claim implied by the ACs is true in the diff; and — equally important — nothing in the diff goes BEYOND the plan (unrequested refactors, drive-by changes, scope creep are defects; the brief's non-goals are binding). ${planForReview}`,
  },
  {
    key: 'bugs',
    prompt: `You hunt for real bugs in a diff. Inputs: the diff (run: ${diffCmd}), read access to the repo, permission to run typecheck/tests. You have NOT seen the implementer's reasoning. Look for: logic errors, unhandled error paths, races/lifecycle issues (spawn/stop/resume/recovery interactions are this codebase's classic failure mode), broken invariants in persisted state, and test theater. For each NEW test in the diff, mutation-check it: revert the fix it guards (actually, in your working copy — restore afterwards) and confirm the test fails; a test that passes either way is a blocking finding. Classify each finding CONFIRMED (you can state the failing input/sequence) or PLAUSIBLE. ${planForReview}`,
  },
]

const runReviewers = async (which, tag) => {
  const verdicts = await parallel(which.map((rv) => () =>
    agent(rv.prompt, { label: `review:${rv.key} ${tag}`, phase: 'Review', schema: REVIEW }).then((v) => ({ key: rv.key, v }))
  ))
  const blocking = []
  for (const r of verdicts.filter(Boolean)) {
    if (r.v) {
      lastVerdicts[r.key] = r.v
      for (const f of r.v.findings) if (f.blocking) blocking.push({ reviewer: r.key, ...f })
    }
  }
  return blocking
}
const fixPrompt = (blocking, extra) => `You fix blocking review findings on branch ${input.branch} (already checked out). Address every finding below, run npm run typecheck / npm run build / npm test until green, and commit. If you believe a finding is wrong, do not silently skip it — note why in your report.${extra || ''} ${conventions}\nFindings:\n${JSON.stringify(blocking, null, 2)}\nDesign context:\n${input.plan.design}`

let lastVerdicts = {}
let pending = reviewers
let blocking = []
let rounds = 0
while (rounds < 3) {
  rounds++
  blocking = await runReviewers(pending, `r${rounds}`)
  if (blocking.length === 0) {
    log(`Review clean after round ${rounds}`)
    return { status: 'ok', headSha: setup.headSha, rounds, verdicts: lastVerdicts, gate: gate.summary }
  }
  if (rounds === 3) break
  log(`Review round ${rounds}: ${blocking.length} blocking finding(s) — fixing`)
  const fixed = await agent(fixPrompt(blocking), { label: `fix-findings r${rounds}`, phase: 'Review', schema: GATE })
  if (!fixed || !fixed.green) return { status: 'impasse', stage: 'implement', question: `Fixing review findings left the gate red: ${fixed ? fixed.summary : 'fixer agent failed'}. How should we proceed? (Your answer becomes guidance keyed "review".)`, context: { blocking } }
  gate = fixed
  const blockedReviewers = new Set(blocking.map((b) => b.reviewer))
  pending = reviewers.filter((rv) => blockedReviewers.has(rv.key))
}

// Cap hit — one operator-guided fix + full re-review, in prompts the capped rounds never used.
if (guideFor('review')) {
  log('Review cap hit — running one operator-guided fix round')
  const fixed = await agent(fixPrompt(blocking, guideFor('review') + ' The operator\'s word overrides a reviewer finding where they conflict.'), { label: 'fix-findings (guided)', phase: 'Review', schema: GATE })
  if (fixed && fixed.green) {
    gate = fixed
    blocking = await runReviewers(reviewers, 'guided')
    if (blocking.length === 0) return { status: 'ok', headSha: setup.headSha, rounds: rounds + 1, verdicts: lastVerdicts, gate: gate.summary, guided: true }
  }
}
return { status: 'impasse', stage: 'implement', question: `Reviewers still have ${blocking.length} blocking finding(s) after ${guideFor('review') ? 'a guided round' : '3 rounds'}. How should we proceed? (Your answer becomes guidance keyed "review".)`, context: { blocking } }
